import type { RetrievalPurpose } from "./domain";

export type ProviderAuthority = "fixture" | "shadow" | "authoritative";

export interface TenantQuota {
  maxRequestsPerHour: number;
  maxMediaDurationMsPerDay: number;
  maxVectorsPerDay: number;
}

export interface TenantEntitlement {
  enabled: boolean;
  environment: "development" | "preview" | "production";
  allowedPurposes: readonly RetrievalPurpose[];
  allowedProviderIds: readonly string[];
  maxProviderAuthority: ProviderAuthority;
  quotas: TenantQuota;
}

export interface TenantEntitlementRegistry {
  schemaVersion: string;
  defaultDecision: "deny";
  tenants: Readonly<Record<string, TenantEntitlement>>;
}

export interface UsageSnapshot {
  requestsThisHour: number;
  mediaDurationMsToday: number;
  vectorsToday: number;
}

export interface EntitlementRequest {
  tenantId: string;
  purpose: RetrievalPurpose;
  providerId: string;
  providerAuthority: ProviderAuthority;
  requestedMediaDurationMs?: number;
  requestedVectors?: number;
}

export interface EntitlementDecision {
  allowed: boolean;
  reasons: string[];
}

const AUTHORITY_RANK: Readonly<Record<ProviderAuthority, number>> = {
  fixture: 0,
  shadow: 1,
  authoritative: 2,
};

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function getTenantEntitlement(
  registry: TenantEntitlementRegistry,
  tenantId: string,
): TenantEntitlement | undefined {
  return registry.tenants[tenantId];
}

export function evaluateTenantEntitlement(
  entitlement: TenantEntitlement | undefined,
  request: EntitlementRequest,
  usage: UsageSnapshot,
): EntitlementDecision {
  const reasons: string[] = [];

  if (!entitlement) {
    return { allowed: false, reasons: ["tenant_not_entitled"] };
  }
  if (!entitlement.enabled) reasons.push("tenant_disabled");
  if (!entitlement.allowedPurposes.includes(request.purpose)) reasons.push("purpose_not_entitled");
  if (!entitlement.allowedProviderIds.includes(request.providerId)) reasons.push("provider_not_entitled");
  if (AUTHORITY_RANK[request.providerAuthority] > AUTHORITY_RANK[entitlement.maxProviderAuthority]) {
    reasons.push("provider_authority_exceeds_entitlement");
  }

  const requestedMediaDurationMs = request.requestedMediaDurationMs ?? 0;
  const requestedVectors = request.requestedVectors ?? 0;
  const usageValues = [
    usage.requestsThisHour,
    usage.mediaDurationMsToday,
    usage.vectorsToday,
    requestedMediaDurationMs,
    requestedVectors,
  ];
  if (!usageValues.every(isNonNegativeFinite)) reasons.push("invalid_usage_snapshot");

  if (usage.requestsThisHour + 1 > entitlement.quotas.maxRequestsPerHour) {
    reasons.push("request_quota_exceeded");
  }
  if (
    usage.mediaDurationMsToday + requestedMediaDurationMs >
    entitlement.quotas.maxMediaDurationMsPerDay
  ) {
    reasons.push("media_duration_quota_exceeded");
  }
  if (usage.vectorsToday + requestedVectors > entitlement.quotas.maxVectorsPerDay) {
    reasons.push("vector_quota_exceeded");
  }

  return { allowed: reasons.length === 0, reasons };
}
