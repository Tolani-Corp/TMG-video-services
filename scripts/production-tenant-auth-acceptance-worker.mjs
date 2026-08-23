import identityRegistry from "../config/production-tenant-identities.json";
import entitlementRegistry from "../config/production-tenant-auth-acceptance-entitlements.json";
import {
  TenantAuthenticationError,
  evaluateAuthenticatedTenantEntitlement,
  verifyTenantCredential,
} from "../src/tenant-auth.ts";

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });

const timingSafeEqualText = async (left, right) => {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) return false;
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [aMac, bMac] = await Promise.all([
    crypto.subtle.sign("HMAC", key, a),
    crypto.subtle.sign("HMAC", key, b),
  ]);
  const av = new Uint8Array(aMac);
  const bv = new Uint8Array(bMac);
  let diff = 0;
  for (let index = 0; index < av.length; index += 1) diff |= av[index] ^ bv[index];
  return diff === 0;
};

const requireControl = async (request, env) => {
  const expected = env.TMG_AUTH_CONTROL_TOKEN;
  const actual = request.headers.get("authorization") ?? "";
  if (!expected || !(await timingSafeEqualText(actual, `Bearer ${expected}`))) {
    return json({ error: "control_unauthorized" }, 401);
  }
  return null;
};

const requireCredential = (request) => {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ") || header.length <= 7) {
    throw new TenantAuthenticationError("credential_missing");
  }
  return header.slice(7);
};

const requireNonNegativeInteger = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}_invalid`);
  return value;
};

const canonicalObjectName = (env, tenantId) => {
  const prefix = env.TMG_AUTH_OBJECT_PREFIX;
  const runId = env.TMG_AUTH_RUN_ID;
  if (!prefix || !runId || !/^[A-Za-z0-9_.-]+$/.test(tenantId)) throw new Error("canonical_object_identity_invalid");
  const name = `${prefix}-${runId}-${tenantId}`;
  if (name.length > 240) throw new Error("canonical_object_identity_too_long");
  return name;
};

const getTenantStub = (env, tenantId) => {
  const objectName = canonicalObjectName(env, tenantId);
  const stub = env.ACCEPTANCE_LEDGER.getByName(objectName);
  return { objectName, stub };
};

const verificationOptions = (env) => ({
  registry: identityRegistry,
  verificationKeys: { [env.TMG_AUTH_KID]: JSON.parse(env.TMG_AUTH_PUBLIC_JWK) },
  expectedAudience: "urn:tolani:tmg-video-services:production",
  expectedEnvironment: "production",
  clockSkewSeconds: 0,
});

const forbiddenCallerIdentityFields = ["tenantId", "tenant", "objectName", "objectId", "subject", "principal"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const failure = await requireControl(request, env);
        if (failure) return failure;
        return json({
          status: "ok",
          mode: env.TMG_AUTH_MODE,
          issuer: "urn:tolani:tmg:production-acceptance",
          audience: "urn:tolani:tmg-video-services:production",
          publicAuthority: false,
          providerPromotionAuthority: false,
          billingAuthority: false,
          commercialAuthority: false,
        });
      }

      if (request.method === "GET" && url.pathname === "/control/snapshot") {
        const failure = await requireControl(request, env);
        if (failure) return failure;
        const tenantId = url.searchParams.get("tenantId");
        const at = url.searchParams.get("at");
        if (!tenantId || !at || !Number.isFinite(Date.parse(at))) return json({ error: "snapshot_request_invalid" }, 400);
        const { objectName, stub } = getTenantStub(env, tenantId);
        const usage = await stub.getUsageSnapshot(at);
        return json({ tenantId, objectName, objectId: stub.id.toString(), at, usage });
      }

      if (request.method === "POST" && url.pathname === "/v1/authorize") {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) return json({ allowed: false, reasons: ["request_invalid"] }, 400);
        if (forbiddenCallerIdentityFields.some((field) => Object.hasOwn(body, field))) {
          return json({ allowed: false, reasons: ["caller_tenant_override_forbidden"] }, 403);
        }

        const credential = requireCredential(request);
        const principal = await verifyTenantCredential(credential, verificationOptions(env));
        const purpose = typeof body.purpose === "string" ? body.purpose : "";
        const providerId = typeof body.providerId === "string" ? body.providerId : "";
        const providerAuthority = typeof body.providerAuthority === "string" ? body.providerAuthority : "";
        const requestedMediaDurationMs = requireNonNegativeInteger(body.requestedMediaDurationMs ?? 0, "requestedMediaDurationMs");
        const requestedVectors = requireNonNegativeInteger(body.requestedVectors ?? 0, "requestedVectors");
        const occurredAt = new Date().toISOString();
        const { objectName, stub } = getTenantStub(env, principal.tenantId);
        const usageBefore = await stub.getUsageSnapshot(occurredAt);

        const entitlement = evaluateAuthenticatedTenantEntitlement(
          principal,
          entitlementRegistry,
          { purpose, providerId, providerAuthority, requestedMediaDurationMs, requestedVectors },
          usageBefore,
        );
        if (!entitlement.allowed || !entitlement.entitlement) {
          return json({
            allowed: false,
            authenticated: true,
            tenantId: principal.tenantId,
            subject: principal.subject,
            reasons: entitlement.reasons,
            objectName,
            usageBefore,
          }, 403);
        }

        const decision = await stub.reserveUsage({
          eventId: `auth:${principal.credentialId}`,
          occurredAt,
          tenantId: principal.tenantId,
          purpose,
          providerId,
          providerAuthority,
          requestUnits: 1,
          mediaDurationMs: requestedMediaDurationMs,
          vectorCount: requestedVectors,
          billingDisposition: "production_acceptance_non_billable",
          commercialReleaseApproved: false,
          quota: entitlement.entitlement.quotas,
        });

        if (decision.duplicate) {
          return json({
            allowed: false,
            authenticated: true,
            tenantId: principal.tenantId,
            subject: principal.subject,
            reasons: ["credential_replay", ...decision.reasons],
            objectName,
            objectId: stub.id.toString(),
            usageBefore,
            usageAfter: decision.usage,
          }, 401);
        }
        if (!decision.allowed || !decision.recorded) {
          return json({
            allowed: false,
            authenticated: true,
            tenantId: principal.tenantId,
            subject: principal.subject,
            reasons: decision.reasons,
            objectName,
            objectId: stub.id.toString(),
            usageBefore,
            usageAfter: decision.usage,
          }, 403);
        }

        return json({
          allowed: true,
          authenticated: true,
          tenantId: principal.tenantId,
          subject: principal.subject,
          credentialId: principal.credentialId,
          objectName,
          objectId: stub.id.toString(),
          usageBefore,
          usageAfter: decision.usage,
          authorities: {
            publicApi: false,
            mcp: false,
            providerPromotion: false,
            billing: false,
            commercialUse: false,
          },
        });
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof TenantAuthenticationError) {
        return json({ allowed: false, authenticated: false, reasons: [error.code] }, 401);
      }
      return json({ allowed: false, reasons: [error instanceof Error ? error.message : "acceptance_request_failed"] }, 400);
    }
  },
};
