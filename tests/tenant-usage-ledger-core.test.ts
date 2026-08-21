import { describe, expect, it } from "vitest";
import { evaluateQuotaReservation, utcUsageWindowStarts } from "../src/tenant-usage-ledger-core";

const quota = {
  maxRequestsPerHour: 120,
  maxMediaDurationMsPerDay: 3_600_000,
  maxVectorsPerDay: 1_000,
};

describe("tenant usage ledger core", () => {
  it("allows a bounded reservation and returns projected usage", () => {
    expect(
      evaluateQuotaReservation(
        quota,
        { requestsThisHour: 10, mediaDurationMsToday: 5_000, vectorsToday: 5 },
        { requestUnits: 1, mediaDurationMs: 1_000, vectorCount: 1 },
      ),
    ).toEqual({
      allowed: true,
      reasons: [],
      projected: { requestsThisHour: 11, mediaDurationMsToday: 6_000, vectorsToday: 6 },
    });
  });

  it("denies a reservation before insertion when any projected quota is exceeded", () => {
    const decision = evaluateQuotaReservation(
      quota,
      { requestsThisHour: 120, mediaDurationMsToday: 3_600_000, vectorsToday: 1_000 },
      { requestUnits: 1, mediaDurationMs: 1, vectorCount: 1 },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "request_quota_exceeded",
        "media_duration_quota_exceeded",
        "vector_quota_exceeded",
      ]),
    );
  });

  it("computes deterministic UTC hour/day window starts", () => {
    const occurredAtMs = Date.parse("2026-08-21T23:57:42.123Z");
    expect(utcUsageWindowStarts(occurredAtMs)).toEqual({
      hourStartMs: Date.parse("2026-08-21T23:00:00.000Z"),
      dayStartMs: Date.parse("2026-08-21T00:00:00.000Z"),
    });
  });
});
