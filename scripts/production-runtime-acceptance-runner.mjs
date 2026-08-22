import fs from "node:fs";

const baseUrl = process.env.TMG_ACCEPTANCE_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.TMG_ACCEPTANCE_TOKEN;
const runId = process.env.GITHUB_RUN_ID ?? "local";
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.split("=")[1] ?? "1";
const outDir = process.env.TMG_RUNTIME_ACCEPTANCE_OUT ?? "production-runtime-acceptance";
const tenant = "prod_acceptance_fixture_v1";
const objectPrefix = `${tenant}-${runId}`;

if (!token) throw new Error("TMG_ACCEPTANCE_TOKEN is required");
fs.mkdirSync(outDir, { recursive: true });

const request = async (pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${pathname} failed ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(`acceptance assertion failed: ${message}`);
};
const same = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
const post = (pathname, body) => request(pathname, { method: "POST", body: JSON.stringify(body) });
const snapshot = (objectName, at) => request(`/snapshot?object=${encodeURIComponent(objectName)}&at=${encodeURIComponent(at)}`);
const quota = (requests = 100, media = 1_000_000, vectors = 10_000) => ({
  maxRequestsPerHour: requests,
  maxMediaDurationMsPerDay: media,
  maxVectorsPerDay: vectors,
});
const reserveBody = (objectName, eventId, occurredAt, increments, q) => ({
  objectName,
  eventId,
  occurredAt,
  requestUnits: increments.requestUnits,
  mediaDurationMs: increments.mediaDurationMs,
  vectorCount: increments.vectorCount,
  quota: q,
});

const report = { schemaVersion: "1.0.0", phase, runId, tenant, cases: [] };
const record = (name, data) => report.cases.push({ name, status: "pass", ...data });

await request("/health");

if (phase === "1") {
  const now = new Date();
  now.setUTCSeconds(0, 0);
  const at = now.toISOString();
  const snapshotAt = new Date(now.getTime() + 5 * 60_000).toISOString();

  const idemObject = `${objectPrefix}-idempotency`;
  const idemEvent = `${runId}-idem-1`;
  const idemQuota = quota(10, 10_000, 100);
  const firstPayload = reserveBody(idemObject, idemEvent, at, { requestUnits: 1, mediaDurationMs: 100, vectorCount: 2 }, idemQuota);
  const first = await post("/reserve", firstPayload);
  assert(first.decision.allowed === true && first.decision.recorded === true && first.decision.duplicate === false, "first idempotency reservation must persist exactly once");
  const afterFirst = await snapshot(idemObject, snapshotAt);
  same(afterFirst.usage, { requestsThisHour: 1, mediaDurationMsToday: 100, vectorsToday: 2 }, "first reservation snapshot");

  const replay = await post("/reserve", firstPayload);
  assert(replay.decision.allowed === true && replay.decision.recorded === false && replay.decision.duplicate === true, "exact replay must be accepted without recording");
  const afterReplay = await snapshot(idemObject, snapshotAt);
  same(afterReplay.usage, afterFirst.usage, "exact replay must not double-count");

  const conflict = await post("/reserve", { ...firstPayload, vectorCount: 3 });
  assert(conflict.decision.allowed === false && conflict.decision.recorded === false && conflict.decision.duplicate === true, "conflicting replay must be rejected");
  assert(conflict.decision.reasons.includes("idempotency_conflict"), "conflicting replay reason must be idempotency_conflict");
  const afterConflict = await snapshot(idemObject, snapshotAt);
  same(afterConflict.usage, afterFirst.usage, "conflicting replay must not mutate usage");

  const crossTenant = await post("/cross-tenant-probe", reserveBody(idemObject, `${runId}-cross-tenant`, at, { requestUnits: 1, mediaDurationMs: 0, vectorCount: 0 }, idemQuota));
  assert(crossTenant.decision.allowed === false && crossTenant.decision.recorded === false, "cross-tenant reservation must be rejected");
  assert(crossTenant.decision.reasons.includes("tenant_binding_mismatch"), "cross-tenant reason must be tenant_binding_mismatch");
  const afterCrossTenant = await snapshot(idemObject, snapshotAt);
  same(afterCrossTenant.usage, afterFirst.usage, "cross-tenant probe must not mutate usage");
  record("tenant_isolation_and_idempotency", { objectName: idemObject, objectId: first.objectId, usage: afterCrossTenant.usage });

  const quotaObject = `${objectPrefix}-quota`;
  const quotaPolicy = quota(2, 500, 5);
  const accepted = await post("/reserve", reserveBody(quotaObject, `${runId}-quota-accepted`, at, { requestUnits: 1, mediaDurationMs: 200, vectorCount: 2 }, quotaPolicy));
  assert(accepted.decision.allowed === true && accepted.decision.recorded === true, "in-quota reservation must persist");
  const quotaBaseline = await snapshot(quotaObject, snapshotAt);

  const quotaProbes = [
    ["request_quota_exceeded", { requestUnits: 2, mediaDurationMs: 0, vectorCount: 0 }],
    ["media_duration_quota_exceeded", { requestUnits: 0, mediaDurationMs: 400, vectorCount: 0 }],
    ["vector_quota_exceeded", { requestUnits: 0, mediaDurationMs: 0, vectorCount: 4 }],
  ];
  for (const [reason, increments] of quotaProbes) {
    const decision = await post("/reserve", reserveBody(quotaObject, `${runId}-${reason}`, at, increments, quotaPolicy));
    assert(decision.decision.allowed === false && decision.decision.recorded === false, `${reason} reservation must be rejected before insert`);
    assert(decision.decision.reasons.includes(reason), `${reason} must be reported`);
    const current = await snapshot(quotaObject, snapshotAt);
    same(current.usage, quotaBaseline.usage, `${reason} must not change persisted usage`);
  }
  record("quota_before_insert", { objectName: quotaObject, objectId: accepted.objectId, usage: quotaBaseline.usage });

  const utcObject = `${objectPrefix}-utc`;
  const utcQuota = quota(100, 100_000, 1000);
  const utcEvents = [
    ["2026-08-21T23:59:59.000Z", { requestUnits: 1, mediaDurationMs: 100, vectorCount: 1 }],
    ["2026-08-22T00:00:00.000Z", { requestUnits: 2, mediaDurationMs: 200, vectorCount: 2 }],
    ["2026-08-22T01:00:00.000Z", { requestUnits: 3, mediaDurationMs: 300, vectorCount: 3 }],
  ];
  for (let index = 0; index < utcEvents.length; index += 1) {
    const [occurredAt, increments] = utcEvents[index];
    const result = await post("/reserve", reserveBody(utcObject, `${runId}-utc-${index + 1}`, occurredAt, increments, utcQuota));
    assert(result.decision.allowed === true && result.decision.recorded === true, `UTC event ${index + 1} must persist`);
  }
  const utc0030 = await snapshot(utcObject, "2026-08-22T00:30:00.000Z");
  same(utc0030.usage, { requestsThisHour: 2, mediaDurationMsToday: 200, vectorsToday: 2 }, "UTC midnight boundary snapshot");
  const utc0130 = await snapshot(utcObject, "2026-08-22T01:30:00.000Z");
  same(utc0130.usage, { requestsThisHour: 3, mediaDurationMsToday: 500, vectorsToday: 5 }, "UTC hour boundary snapshot");
  record("utc_windows", { objectName: utcObject, objectId: utc0130.objectId, at0030: utc0030.usage, at0130: utc0130.usage });

  const persistenceObject = `${objectPrefix}-persistence`;
  const persistenceEvent = await post("/reserve", reserveBody(persistenceObject, `${runId}-persist-1`, at, { requestUnits: 1, mediaDurationMs: 50, vectorCount: 1 }, quota(10, 10_000, 100)));
  assert(persistenceEvent.decision.allowed === true && persistenceEvent.decision.recorded === true, "persistence seed must record");
  const persistenceSnapshot = await snapshot(persistenceObject, snapshotAt);
  fs.writeFileSync(`${outDir}/phase1-state.json`, `${JSON.stringify({ objectName: persistenceObject, objectId: persistenceEvent.objectId, snapshotAt, usage: persistenceSnapshot.usage }, null, 2)}\n`);
  record("persistence_seed", { objectName: persistenceObject, objectId: persistenceEvent.objectId, usage: persistenceSnapshot.usage });
} else if (phase === "2") {
  const state = JSON.parse(fs.readFileSync(`${outDir}/phase1-state.json`, "utf8"));
  const persisted = await snapshot(state.objectName, state.snapshotAt);
  same(persisted.usage, state.usage, "usage snapshot must persist across independently restarted remote sessions");
  assert(persisted.objectId === state.objectId, "Durable Object identity must remain stable across sessions");
  record("persistence_across_sessions", { objectName: state.objectName, objectId: persisted.objectId, usage: persisted.usage });
} else {
  throw new Error(`unsupported phase ${phase}`);
}

fs.writeFileSync(`${outDir}/phase-${phase}-results.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(`production runtime acceptance phase ${phase} passed cases=${report.cases.length}`);
