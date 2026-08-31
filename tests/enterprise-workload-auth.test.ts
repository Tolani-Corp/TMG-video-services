import { describe, expect, it } from "vitest";
import { EnterpriseWorkloadAuthError, verifyEnterpriseWorkloadRequest } from "../src/enterprise-workload-auth";

const encoder = new TextEncoder();
const now = 1_800_000_000;

function b64u(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function segment(value: unknown) { return b64u(encoder.encode(JSON.stringify(value))); }

async function fixture() {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const raw = btoa(String.fromCharCode(...spki));
  const pem = `-----BEGIN PUBLIC KEY-----\n${raw.match(/.{1,64}/g)?.join("\n")}\n-----END PUBLIC KEY-----`;
  return { keys, pem };
}

async function token(privateKey: CryptoKey, overrides: Record<string, unknown> = {}) {
  const header = segment({ alg: "RS256", typ: "JWT" });
  const payload = segment({
    iss: "https://clerk.test",
    sub: "mch_taskstaff",
    aud: "tolani:tmg-video:production",
    iat: now - 10,
    nbf: now - 10,
    exp: now + 290,
    organization: "tolani",
    access_class: "tolani-internal",
    service_id: "taskstaff",
    environment: "production",
    scope: "tolani.service.discover tmg.video.mcp.invoke",
    ...overrides,
  });
  const input = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(input)));
  return `${input}.${b64u(signature)}`;
}

const options = (pem: string) => ({
  pemPublicKey: pem,
  expectedIssuer: "https://clerk.test",
  expectedAudience: "tolani:tmg-video:production",
  expectedEnvironment: "production",
  requiredScopes: ["tmg.video.mcp.invoke"],
  allowedServiceIds: ["taskstaff"],
  nowEpochSeconds: now,
});

async function denied(run: Promise<unknown>, code: string) {
  try {
    await run;
    throw new Error("expected denial");
  } catch (error) {
    expect(error).toBeInstanceOf(EnterpriseWorkloadAuthError);
    expect((error as EnterpriseWorkloadAuthError).code).toBe(code);
  }
}

describe("TMG enterprise workload verification", () => {
  it("accepts exact scoped internal M2M identity", async () => {
    const { keys, pem } = await fixture();
    const jwt = await token(keys.privateKey);
    const principal = await verifyEnterpriseWorkloadRequest(
      new Request("https://internal.tmg/mcp", { headers: { authorization: `Bearer ${jwt}` } }),
      options(pem),
    );
    expect(principal.serviceId).toBe("taskstaff");
  });

  it("denies missing scope", async () => {
    const { keys, pem } = await fixture();
    const jwt = await token(keys.privateKey, { scope: "tolani.service.discover" });
    await denied(verifyEnterpriseWorkloadRequest(new Request("https://internal.tmg/mcp", { headers: { authorization: `Bearer ${jwt}` } }), options(pem)), "service_scope_required");
  });

  it("denies wrong audience and wrong environment", async () => {
    const { keys, pem } = await fixture();
    const wrongAudience = await token(keys.privateKey, { aud: "tolani:other:production" });
    const wrongEnvironment = await token(keys.privateKey, { environment: "staging" });
    await denied(verifyEnterpriseWorkloadRequest(new Request("https://internal.tmg/mcp", { headers: { authorization: `Bearer ${wrongAudience}` } }), options(pem)), "jwt_audience_invalid");
    await denied(verifyEnterpriseWorkloadRequest(new Request("https://internal.tmg/mcp", { headers: { authorization: `Bearer ${wrongEnvironment}` } }), options(pem)), "environment_mismatch");
  });

  it("denies expired and overlong credentials", async () => {
    const { keys, pem } = await fixture();
    const expired = await token(keys.privateKey, { iat: now - 400, nbf: now - 400, exp: now - 31 });
    const long = await token(keys.privateKey, { iat: now - 10, exp: now + 301 });
    await denied(verifyEnterpriseWorkloadRequest(new Request("https://internal.tmg/mcp", { headers: { authorization: `Bearer ${expired}` } }), options(pem)), "jwt_expired");
    await denied(verifyEnterpriseWorkloadRequest(new Request("https://internal.tmg/mcp", { headers: { authorization: `Bearer ${long}` } }), options(pem)), "jwt_ttl_invalid");
  });
});
