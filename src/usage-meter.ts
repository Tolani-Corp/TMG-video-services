import type { RetrievalPurpose } from "./domain";
import type { ProviderAuthority } from "./entitlements";

export type BillingDisposition = "development_non_billable" | "eligible_for_billing";

export interface UsageEventInput {
  eventId: string;
  occurredAt: string;
  tenantId: string;
  purpose: RetrievalPurpose;
  providerId: string;
  providerAuthority: ProviderAuthority;
  requestUnits: number;
  mediaDurationMs: number;
  vectorCount: number;
  billingDisposition: BillingDisposition;
  commercialReleaseApproved: boolean;
}

export interface UsageEvent {
  schemaVersion: "1.0.0";
  eventType: "video_intelligence_usage";
  eventId: string;
  occurredAt: string;
  tenantId: string;
  purpose: RetrievalPurpose;
  providerId: string;
  providerAuthority: ProviderAuthority;
  usage: {
    requestUnits: number;
    mediaDurationMs: number;
    vectorCount: number;
  };
  billingDisposition: BillingDisposition;
}

export class UsageMeterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageMeterError";
  }
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageMeterError(`${field} must be a non-negative safe integer.`);
  }
}

export function createUsageEvent(input: UsageEventInput): UsageEvent {
  if (!input.eventId.trim()) throw new UsageMeterError("eventId is required.");
  if (!input.tenantId.trim()) throw new UsageMeterError("tenantId is required.");
  if (!input.providerId.trim()) throw new UsageMeterError("providerId is required.");
  if (!Number.isFinite(Date.parse(input.occurredAt))) {
    throw new UsageMeterError("occurredAt must be a valid ISO timestamp.");
  }

  requireNonNegativeInteger(input.requestUnits, "requestUnits");
  requireNonNegativeInteger(input.mediaDurationMs, "mediaDurationMs");
  requireNonNegativeInteger(input.vectorCount, "vectorCount");

  if (input.billingDisposition === "eligible_for_billing") {
    if (!input.commercialReleaseApproved) {
      throw new UsageMeterError("Billing eligibility requires explicit commercial release approval.");
    }
    if (input.providerAuthority !== "authoritative") {
      throw new UsageMeterError("Billing eligibility requires authoritative provider routing.");
    }
  }

  return {
    schemaVersion: "1.0.0",
    eventType: "video_intelligence_usage",
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    tenantId: input.tenantId,
    purpose: input.purpose,
    providerId: input.providerId,
    providerAuthority: input.providerAuthority,
    usage: {
      requestUnits: input.requestUnits,
      mediaDurationMs: input.mediaDurationMs,
      vectorCount: input.vectorCount,
    },
    billingDisposition: input.billingDisposition,
  };
}
