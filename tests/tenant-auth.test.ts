import { describe, expect, it } from "vitest";
import {
  TenantAuthenticationError,
  evaluateAuthenticatedTenantEntitlement,
  verifyTenantCredential,
  type TenantIdentityRegistry,
} from "../src/tenant-auth";
import type { TenantEntitlementRegistry } from "../src/entitlements";

const issuer = "urn:tolani:tmg:production-acceptance";
const audience = "urn:tolani:tmg-video-services:production";
const registry: TenantIdentityRegistry = {
  schemaVersion: "1.0.0",
  defaultDecision: "deny",
  issuers: {
    [issuer]: {
      audiences: [audience],
      environment: "production",
      principals: {
        principal_a: { tenantId: "tenant_a", enabled: true },
        principal_disabled: { tenantId: "tenant_disabled", enabled: false },
      },
    },
  },
};
const entitlements: TenantEntitlementRegistry = {
  schemaVersion: "1.0.0",
  defaultDecision: "deny",
  tenants: {
    tenant_a: {
      enabled: true,
      environment: "production",
      allowedPurposes: ["internal_search"],
      allowedProviderIds: ["fixture"],
      maxProviderAuthority: "fixture",
      quotas: { maxRequestsPerHour: 2, maxMediaDurationMsPerDay: 1000, maxVectorsPerDay: 10 },
    },
  },
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function createSigner() {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const sign = async (claims: Record<string, unknown>, kid = "test-key") => {
    const header = encode({ alg: "EdDSA", typ: "JWT", kid });
    const payload = encode(claims);
    const input = `${header}.${payload}`;
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString("base64url")}`;
  };
  return { publicJwk, sign };
}

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: issuer,
  aud: audience,
  sub: "principal_a",
  jti: "credential-1",
  iat: 1_700_000_000,
  exp: 1_700_000_600,
  env: "production",
  ...overrides,
});

async function expectAuthError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("expected authentication failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TenantAuthenticationError);
    expect((error as TenantAuthenticationError).code).toBe(code);
  }
}

describe("tenant credential verification", () => {
  it("verifies Ed25519 and derives the canonical tenant from issuer + subject", async () => {
    const { publicJwk, sign } = await createSigner();
    const credential = await sign(claims());
    const principal = await verifyTenantCredential(credential, {
      registry,
      verificationKeys: { "test-key": publicJwk },
      expectedAudience: audience,
      expectedEnvironment: "production",
      nowMs: 1_700_000_100_000,
      clockSkewSeconds: 0,
    });
    expect(principal.tenantId).toBe("tenant_a");
    expect(principal.subject).toBe("principal_a");
    expect(principal.credentialId).toBe("credential-1");
  });

  it("fails closed for wrong issuer, audience, environment, expiration, disabled principal, and signature", async () => {
    const { publicJwk, sign } = await createSigner();
    const base = {
      registry,
      verificationKeys: { "test-key": publicJwk },
      expectedAudience: audience,
      expectedEnvironment: "production" as const,
      nowMs: 1_700_000_100_000,
      clockSkewSeconds: 0,
    };
    await expectAuthError(verifyTenantCredential(await sign(claims({ iss: "urn:wrong" })), base), "credential_issuer_rejected");
    await expectAuthError(verifyTenantCredential(await sign(claims({ aud: "urn:wrong" })), base), "credential_audience_rejected");
    await expectAuthError(verifyTenantCredential(await sign(claims({ env: "preview" })), base), "credential_environment_rejected");
    await expectAuthError(verifyTenantCredential(await sign(claims({ exp: 1_700_000_050 })), base), "credential_expired");
    await expectAuthError(verifyTenantCredential(await sign(claims({ sub: "principal_disabled" })), base), "principal_disabled");

    const credential = await sign(claims());
    const [header, payload, signature] = credential.split(".");
    const tampered = `${header}.${payload}.${signature.slice(0, -2)}aa`;
    await expectAuthError(verifyTenantCredential(tampered, base), "credential_signature_invalid");
  });
});

describe("authenticated entitlement boundary", () => {
  it("uses the authenticated tenant and enforces environment/purpose/provider/authority/quota", async () => {
    const principal = {
      issuer,
      subject: "principal_a",
      tenantId: "tenant_a",
      credentialId: "credential-1",
      environment: "production" as const,
      issuedAt: 1,
      expiresAt: 2,
    };
    const allowed = evaluateAuthenticatedTenantEntitlement(
      principal,
      entitlements,
      { purpose: "internal_search", providerId: "fixture", providerAuthority: "fixture", requestedMediaDurationMs: 100, requestedVectors: 1 },
      { requestsThisHour: 0, mediaDurationMsToday: 0, vectorsToday: 0 },
    );
    expect(allowed.allowed).toBe(true);

    const denied = evaluateAuthenticatedTenantEntitlement(
      principal,
      entitlements,
      { purpose: "external_api", providerId: "fixture", providerAuthority: "authoritative", requestedMediaDurationMs: 0, requestedVectors: 0 },
      { requestsThisHour: 2, mediaDurationMsToday: 0, vectorsToday: 0 },
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reasons).toEqual(expect.arrayContaining(["purpose_not_entitled", "provider_authority_exceeds_entitlement", "request_quota_exceeded"]));
  });
});
