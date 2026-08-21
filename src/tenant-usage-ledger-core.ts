import type { TenantQuota, UsageSnapshot } from "./entitlements";

export interface UsageIncrement {
  requestUnits: number;
  mediaDurationMs: number;
  vectorCount: number;
}

export interface QuotaReservationDecision {
  allowed: boolean;
  reasons: string[];
  projected: UsageSnapshot;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateQuotaReservation(
  quota: TenantQuota,
  usage: UsageSnapshot,
  increment: UsageIncrement,
): QuotaReservationDecision {
  const reasons: string[] = [];
  const values = [
    quota.maxRequestsPerHour,
    quota.maxMediaDurationMsPerDay,
    quota.maxVectorsPerDay,
    usage.requestsThisHour,
    usage.mediaDurationMsToday,
    usage.vectorsToday,
    increment.requestUnits,
    increment.mediaDurationMs,
    increment.vectorCount,
  ];

  if (!values.every(isNonNegativeSafeInteger)) {
    reasons.push("invalid_quota_or_usage_value");
  }

  const projected: UsageSnapshot = {
    requestsThisHour: usage.requestsThisHour + increment.requestUnits,
    mediaDurationMsToday: usage.mediaDurationMsToday + increment.mediaDurationMs,
    vectorsToday: usage.vectorsToday + increment.vectorCount,
  };

  if (projected.requestsThisHour > quota.maxRequestsPerHour) {
    reasons.push("request_quota_exceeded");
  }
  if (projected.mediaDurationMsToday > quota.maxMediaDurationMsPerDay) {
    reasons.push("media_duration_quota_exceeded");
  }
  if (projected.vectorsToday > quota.maxVectorsPerDay) {
    reasons.push("vector_quota_exceeded");
  }

  return { allowed: reasons.length === 0, reasons, projected };
}

export function utcUsageWindowStarts(occurredAtMs: number): {
  hourStartMs: number;
  dayStartMs: number;
} {
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
    throw new RangeError("occurredAtMs must be a non-negative safe integer.");
  }

  const hourMs = 60 * 60 * 1_000;
  const dayMs = 24 * hourMs;
  return {
    hourStartMs: Math.floor(occurredAtMs / hourMs) * hourMs,
    dayStartMs: Math.floor(occurredAtMs / dayMs) * dayMs,
  };
}
