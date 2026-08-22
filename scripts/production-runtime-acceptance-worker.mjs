const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });

const requireAuth = (request, env) => {
  const expected = env.TMG_ACCEPTANCE_TOKEN;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
};

const requireObjectName = (value, env) => {
  if (typeof value !== "string" || !value.startsWith(`${env.TMG_ACCEPTANCE_OBJECT_PREFIX}-`)) {
    throw new Error("acceptance object name is outside the governed prefix");
  }
  if (value.length > 240) throw new Error("acceptance object name is too long");
  return value;
};

const requireQuota = (value) => {
  const quota = value && typeof value === "object" ? value : {};
  for (const key of ["maxRequestsPerHour", "maxMediaDurationMsPerDay", "maxVectorsPerDay"]) {
    if (!Number.isSafeInteger(quota[key]) || quota[key] < 0) {
      throw new Error(`invalid quota.${key}`);
    }
  }
  return quota;
};

const requireNonNegativeInteger = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
};

const requireTimestamp = (value) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("occurredAt must be a valid ISO timestamp");
  return value;
};

const getStub = (env, objectName) => env.ACCEPTANCE_LEDGER.getByName(requireObjectName(objectName, env));

const buildReservation = (body, env, tenantId) => ({
  eventId: String(body.eventId ?? ""),
  occurredAt: requireTimestamp(body.occurredAt),
  tenantId,
  purpose: "internal_search",
  providerId: env.TMG_ACCEPTANCE_PROVIDER_ID,
  providerAuthority: "fixture",
  requestUnits: requireNonNegativeInteger(body.requestUnits, "requestUnits"),
  mediaDurationMs: requireNonNegativeInteger(body.mediaDurationMs, "mediaDurationMs"),
  vectorCount: requireNonNegativeInteger(body.vectorCount, "vectorCount"),
  billingDisposition: "development_non_billable",
  commercialReleaseApproved: false,
  quota: requireQuota(body.quota),
});

export default {
  async fetch(request, env) {
    const authFailure = requireAuth(request, env);
    if (authFailure) return authFailure;

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          status: "ok",
          mode: env.TMG_ACCEPTANCE_MODE,
          tenant: env.TMG_ACCEPTANCE_TENANT,
          provider: env.TMG_ACCEPTANCE_PROVIDER_ID,
          publicAuthority: false,
          billingAuthority: false,
        });
      }

      if (request.method === "GET" && url.pathname === "/snapshot") {
        const objectName = requireObjectName(url.searchParams.get("object"), env);
        const at = requireTimestamp(url.searchParams.get("at"));
        const stub = getStub(env, objectName);
        const usage = await stub.getUsageSnapshot(at);
        return json({ objectName, objectId: stub.id.toString(), at, usage });
      }

      if (request.method === "POST" && url.pathname === "/reserve") {
        const body = await request.json();
        const objectName = requireObjectName(body.objectName, env);
        const stub = getStub(env, objectName);
        const reservation = buildReservation(body, env, env.TMG_ACCEPTANCE_TENANT);
        const decision = await stub.reserveUsage(reservation);
        return json({ objectName, objectId: stub.id.toString(), decision });
      }

      if (request.method === "POST" && url.pathname === "/cross-tenant-probe") {
        const body = await request.json();
        const objectName = requireObjectName(body.objectName, env);
        const stub = getStub(env, objectName);
        const reservation = buildReservation(body, env, `${env.TMG_ACCEPTANCE_TENANT}_cross_tenant_probe`);
        const decision = await stub.reserveUsage(reservation);
        return json({ objectName, objectId: stub.id.toString(), decision });
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: "acceptance_request_failed", message: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
};
