import fs from "node:fs";
import crypto, { webcrypto } from "node:crypto";

const baseUrl = process.env.TMG_AUTH_ACCEPTANCE_BASE_URL ?? "http://127.0.0.1:8788";
const controlToken = process.env.TMG_AUTH_CONTROL_TOKEN;
const privateJwkPath = process.env.TMG_AUTH_PRIVATE_JWK_PATH;
const replayTokenPath = process.env.TMG_AUTH_REPLAY_TOKEN_PATH;
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.split("=")[1] ?? "1";
const outDir = process.env.TMG_AUTH_ACCEPTANCE_OUT ?? "production-tenant-auth-acceptance";
const runId = process.env.GITHUB_RUN_ID ?? "local";
const issuer = "urn:tolani:tmg:production-acceptance";
const audience = "urn:tolani:tmg-video-services:production";
const kid = "production-acceptance-v1";

if (!controlToken || !privateJwkPath || !replayTokenPath) {
  throw new Error("TMG_AUTH_CONTROL_TOKEN, TMG_AUTH_PRIVATE_JWK_PATH, and TMG_AUTH_REPLAY_TOKEN_PATH are required");
}
fs.mkdirSync(outDir, { recursive: true });

const privateJwk = JSON.parse(fs.readFileSync(privateJwkPath, "utf8"));
const signingKey = await webcrypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const tokenHash = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function signCredential(subject, jti, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "EdDSA", typ: "JWT", kid });
  const payload = encode({
    iss: issuer,
    aud: audience,
    sub: subject,
    jti,
    iat: now - 1,
    nbf: now - 1,
    exp: now + 600,
    env: "production",
    ...overrides,
  });
  const input = `${header}.${payload}`;
  const signature = await webcrypto.subtle.sign({ name: "Ed25519" }, signingKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

async function call(pathname, { credential, body, control = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (control) headers.authorization = `Bearer ${controlToken}`;
  else if (credential) headers.authorization = `Bearer ${credential}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseBody = await response.json();
  return { status: response.status, body: responseBody };
}

const assert = (condition, message) => {
  if (!condition) throw new Error(`tenant auth acceptance assertion failed: ${message}`);
};
const expectReason = (result, status, reason) => {
  assert(result.status === status, `${reason} status=${result.status} expected=${status}`);
  assert(result.body.allowed === false, `${reason} must be denied`);
  assert(Array.isArray(result.body.reasons) && result.body.reasons.includes(reason), `${reason} missing from ${JSON.stringify(result.body)}`);
};
const requestBody = (overrides = {}) => ({
  purpose: "internal_search",
  providerId: "fixture",
  providerAuthority: "fixture",
  requestedMediaDurationMs: 25,
  requestedVectors: 1,
  ...overrides,
});
const snapshot = async (tenantId, at) => {
  const result = await call(`/control/snapshot?tenantId=${encodeURIComponent(tenantId)}&at=${encodeURIComponent(at)}`, { control: true });
  assert(result.status === 200, `snapshot ${tenantId} failed ${result.status}`);
  return result.body;
};
const sameUsage = (left, right, message) => assert(JSON.stringify(left) === JSON.stringify(right), `${message}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
const report = { schemaVersion: "1.0.0", phase, runId, cases: [] };
const record = (name, data = {}) => report.cases.push({ name, status: "pass", ...data });

const health = await call("/health", { control: true });
assert(health.status === 200 && health.body.publicAuthority === false && health.body.billingAuthority === false, "harness must be healthy and non-authoritative");

if (phase === "1") {
  const snapshotAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const tenantA = "prod_acceptance_auth_a";
  const tenantB = "prod_acceptance_auth_b";
  const baselineA = await snapshot(tenantA, snapshotAt);
  const baselineB = await snapshot(tenantB, snapshotAt);

  expectReason(await call("/v1/authorize", { body: requestBody() }), 401, "credential_missing");
  expectReason(await call("/v1/authorize", { credential: "not-a-jwt", body: requestBody() }), 401, "credential_malformed");

  const signed = await signCredential("prod-acceptance-principal-a", `${runId}-signature`);
  const tampered = `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`;
  expectReason(await call("/v1/authorize", { credential: tampered, body: requestBody() }), 401, "credential_signature_invalid");

  expectReason(await call("/v1/authorize", {
    credential: await signCredential("prod-acceptance-principal-a", `${runId}-issuer`, { iss: "urn:tolani:tmg:wrong" }),
    body: requestBody(),
  }), 401, "credential_issuer_rejected");
  expectReason(await call("/v1/authorize", {
    credential: await signCredential("prod-acceptance-principal-a", `${runId}-audience`, { aud: "urn:tolani:tmg:wrong-audience" }),
    body: requestBody(),
  }), 401, "credential_audience_rejected");
  expectReason(await call("/v1/authorize", {
    credential: await signCredential("prod-acceptance-principal-a", `${runId}-environment`, { env: "preview" }),
    body: requestBody(),
  }), 401, "credential_environment_rejected");

  const now = Math.floor(Date.now() / 1000);
  expectReason(await call("/v1/authorize", {
    credential: await signCredential("prod-acceptance-principal-a", `${runId}-expired`, { iat: now - 120, nbf: now - 120, exp: now - 60 }),
    body: requestBody(),
  }), 401, "credential_expired");
  expectReason(await call("/v1/authorize", {
    credential: await signCredential("prod-acceptance-principal-a", `${runId}-future`, { iat: now + 60, nbf: now + 60, exp: now + 600 }),
    body: requestBody(),
  }), 401, "credential_not_yet_valid");
  expectReason(await call("/v1/authorize", {
    credential: await signCredential("unknown-principal", `${runId}-unregistered`),
    body: requestBody(),
  }), 401, "principal_not_registered");
  expectReason(await call("/v1/authorize", {
    credential: await signCredential("prod-acceptance-disabled", `${runId}-disabled`),
    body: requestBody(),
  }), 401, "principal_disabled");
  record("authentication_negative_matrix", { cases: 9 });

  const overrideCredential = await signCredential("prod-acceptance-principal-a", `${runId}-override`);
  expectReason(await call("/v1/authorize", {
    credential: overrideCredential,
    body: requestBody({ tenantId: tenantB }),
  }), 403, "caller_tenant_override_forbidden");
  record("caller_tenant_override_forbidden", { credentialSha256: tokenHash(overrideCredential) });

  const entitlementDenials = [
    ["purpose_not_entitled", { purpose: "external_api" }],
    ["provider_not_entitled", { providerId: "marengo" }],
    ["provider_authority_exceeds_entitlement", { providerAuthority: "authoritative" }],
  ];
  for (const [reason, override] of entitlementDenials) {
    const credential = await signCredential("prod-acceptance-principal-a", `${runId}-${reason}`);
    expectReason(await call("/v1/authorize", { credential, body: requestBody(override) }), 403, reason);
  }
  const afterEntitlementDenials = await snapshot(tenantA, snapshotAt);
  sameUsage(afterEntitlementDenials.usage, baselineA.usage, "entitlement denials must be side-effect-free");
  record("entitlement_default_deny_matrix", { cases: entitlementDenials.length, usage: afterEntitlementDenials.usage });

  const allowAToken = await signCredential("prod-acceptance-principal-a", `${runId}-allow-a`);
  const allowA = await call("/v1/authorize", { credential: allowAToken, body: requestBody() });
  assert(allowA.status === 200 && allowA.body.allowed === true && allowA.body.tenantId === tenantA, "tenant A authorized request must succeed with canonical tenant");
  assert(allowA.body.subject === "prod-acceptance-principal-a", "tenant A subject mismatch");

  const replayA = await call("/v1/authorize", { credential: allowAToken, body: requestBody() });
  expectReason(replayA, 401, "credential_replay");
  const afterA = await snapshot(tenantA, snapshotAt);
  assert(afterA.usage.requestsThisHour === baselineA.usage.requestsThisHour + 1, "credential replay must not double-count tenant A requests");

  const allowBToken = await signCredential("prod-acceptance-principal-b", `${runId}-allow-b`);
  const allowB = await call("/v1/authorize", { credential: allowBToken, body: requestBody({ requestedMediaDurationMs: 40, requestedVectors: 2 }) });
  assert(allowB.status === 200 && allowB.body.allowed === true && allowB.body.tenantId === tenantB, "tenant B authorized request must succeed with canonical tenant");
  assert(allowA.body.objectId !== allowB.body.objectId, "tenant A and tenant B must resolve to different Durable Object identities");
  const afterB = await snapshot(tenantB, snapshotAt);
  assert(afterB.usage.requestsThisHour === baselineB.usage.requestsThisHour + 1, "tenant B usage must increment independently");
  record("tenant_isolation_and_authorized_usage", {
    tenantAObjectId: allowA.body.objectId,
    tenantBObjectId: allowB.body.objectId,
    tenantAUsage: afterA.usage,
    tenantBUsage: afterB.usage,
  });

  fs.writeFileSync(replayTokenPath, allowAToken, { mode: 0o600 });
  fs.writeFileSync(`${outDir}/phase1-state.json`, `${JSON.stringify({
    tenantA,
    tenantB,
    snapshotAt,
    tenantAObjectId: allowA.body.objectId,
    tenantBObjectId: allowB.body.objectId,
    tenantAUsage: afterA.usage,
    tenantBUsage: afterB.usage,
    replayCredentialSha256: tokenHash(allowAToken),
  }, null, 2)}\n`);
} else if (phase === "2") {
  const state = JSON.parse(fs.readFileSync(`${outDir}/phase1-state.json`, "utf8"));
  const replayToken = fs.readFileSync(replayTokenPath, "utf8");
  assert(tokenHash(replayToken) === state.replayCredentialSha256, "cross-session replay token hash mismatch");
  const replay = await call("/v1/authorize", { credential: replayToken, body: requestBody() });
  expectReason(replay, 401, "credential_replay");

  const tenantA = await snapshot(state.tenantA, state.snapshotAt);
  const tenantB = await snapshot(state.tenantB, state.snapshotAt);
  assert(tenantA.objectId === state.tenantAObjectId && tenantB.objectId === state.tenantBObjectId, "tenant object identities must persist across sessions");
  sameUsage(tenantA.usage, state.tenantAUsage, "cross-session replay must not change tenant A usage");
  sameUsage(tenantB.usage, state.tenantBUsage, "tenant B usage must remain isolated across sessions");
  record("persistent_cross_session_credential_replay_rejection", {
    replayCredentialSha256: state.replayCredentialSha256,
    tenantAObjectId: tenantA.objectId,
    tenantAUsage: tenantA.usage,
  });
} else {
  throw new Error(`unsupported phase ${phase}`);
}

fs.writeFileSync(`${outDir}/phase-${phase}-results.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(`production tenant auth acceptance phase ${phase} passed cases=${report.cases.length}`);
