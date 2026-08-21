export type PromotionTarget =
  | "authoritative_embedding"
  | "public_api"
  | "mcp"
  | "commercial_use";

export interface RuntimeControlEvidence {
  tenantAuthentication: boolean;
  tenantIsolation: boolean;
  entitlementGate: boolean;
  quotaPersistence: boolean;
  usageMeterPersistence: boolean;
  abuseControls: boolean;
  billingMapping: boolean;
}

export interface ProviderPromotionRequest {
  providerId: string;
  target: PromotionTarget;
  providerAcceptanceState: string;
  cascadeAcceptanceState: string;
  providerAuthority: string;
  promotionEnabled: boolean;
  explicitReleaseApproved: boolean;
  controls: RuntimeControlEvidence;
}

export interface ProviderPromotionDecision {
  allowed: boolean;
  reasons: string[];
}

const REQUIRED_CONTROLS: Readonly<Record<PromotionTarget, readonly (keyof RuntimeControlEvidence)[]>> = {
  authoritative_embedding: [
    "tenantAuthentication",
    "tenantIsolation",
    "entitlementGate",
    "quotaPersistence",
    "usageMeterPersistence",
  ],
  public_api: [
    "tenantAuthentication",
    "tenantIsolation",
    "entitlementGate",
    "quotaPersistence",
    "usageMeterPersistence",
    "abuseControls",
  ],
  mcp: [
    "tenantAuthentication",
    "tenantIsolation",
    "entitlementGate",
    "quotaPersistence",
    "usageMeterPersistence",
    "abuseControls",
  ],
  commercial_use: [
    "tenantAuthentication",
    "tenantIsolation",
    "entitlementGate",
    "quotaPersistence",
    "usageMeterPersistence",
    "abuseControls",
    "billingMapping",
  ],
};

export function evaluateProviderPromotion(
  request: ProviderPromotionRequest,
): ProviderPromotionDecision {
  const reasons: string[] = [];

  if (!request.providerId.trim()) reasons.push("provider_id_missing");
  if (request.providerAcceptanceState !== "development_shadow_verified") {
    reasons.push("provider_acceptance_not_verified");
  }
  if (request.cascadeAcceptanceState !== "development_cascade_verified") {
    reasons.push("cascade_acceptance_not_verified");
  }
  if (request.providerAuthority !== "shadow_only") {
    reasons.push("unexpected_provider_authority");
  }
  if (!request.promotionEnabled) reasons.push("promotion_disabled_by_policy");
  if (!request.explicitReleaseApproved) reasons.push("explicit_release_approval_missing");

  for (const control of REQUIRED_CONTROLS[request.target]) {
    if (!request.controls[control]) reasons.push(`runtime_control_missing:${control}`);
  }

  return { allowed: reasons.length === 0, reasons };
}
