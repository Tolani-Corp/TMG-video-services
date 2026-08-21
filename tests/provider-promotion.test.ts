import { describe, expect, it } from "vitest";
import {
  evaluateProviderPromotion,
  type ProviderPromotionRequest,
  type RuntimeControlEvidence,
} from "../src/provider-promotion";

const allControls: RuntimeControlEvidence = {
  tenantAuthentication: true,
  tenantIsolation: true,
  entitlementGate: true,
  quotaPersistence: true,
  usageMeterPersistence: true,
  abuseControls: true,
  billingMapping: true,
};

function request(overrides: Partial<ProviderPromotionRequest> = {}): ProviderPromotionRequest {
  return {
    providerId: "twelvelabs-marengo3",
    target: "authoritative_embedding",
    providerAcceptanceState: "development_shadow_verified",
    cascadeAcceptanceState: "development_cascade_verified",
    providerAuthority: "shadow_only",
    promotionEnabled: false,
    explicitReleaseApproved: false,
    controls: allControls,
    ...overrides,
  };
}

describe("evaluateProviderPromotion", () => {
  it("denies promotion while policy and explicit release approval are absent", () => {
    const decision = evaluateProviderPromotion(request());

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("promotion_disabled_by_policy");
    expect(decision.reasons).toContain("explicit_release_approval_missing");
  });

  it("denies promotion when a required runtime control is missing", () => {
    const decision = evaluateProviderPromotion(
      request({
        promotionEnabled: true,
        explicitReleaseApproved: true,
        controls: { ...allControls, quotaPersistence: false },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("runtime_control_missing:quotaPersistence");
  });

  it("requires billing mapping for commercial use", () => {
    const decision = evaluateProviderPromotion(
      request({
        target: "commercial_use",
        promotionEnabled: true,
        explicitReleaseApproved: true,
        controls: { ...allControls, billingMapping: false },
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("runtime_control_missing:billingMapping");
  });

  it("can return allow only when acceptance, controls, policy, and explicit release approval all pass", () => {
    expect(
      evaluateProviderPromotion(
        request({ promotionEnabled: true, explicitReleaseApproved: true }),
      ),
    ).toEqual({ allowed: true, reasons: [] });
  });
});
