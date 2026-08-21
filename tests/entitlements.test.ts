import { describe, expect, it } from "vitest";
import {
  evaluateTenantEntitlement,
  type TenantEntitlement,
  type UsageSnapshot,
} from "../src/entitlements";

const fixtureEntitlement: TenantEntitlement = {
  enabled: true,
  environment: "development",
  allowedPurposes: ["internal_search"],
  allowedProviderIds: ["fixture"],
  maxProviderAuthority: "fixture",
  quotas: {
    maxRequestsPerHour: 120,
    maxMediaDurationMsPerDay: 3_600_000,
    maxVectorsPerDay: 1_000,
  },
};

const emptyUsage: UsageSnapshot = {
  requestsThisHour: 0,
  mediaDurationMsToday: 0,
  vectorsToday: 0,
};

describe("evaluateTenantEntitlement", () => {
  it("defaults to deny when a tenant has no entitlement", () => {
    expect(
      evaluateTenantEntitlement(
        undefined,
        {
          tenantId: "unknown",
          purpose: "internal_search",
          providerId: "fixture",
          providerAuthority: "fixture",
        },
        emptyUsage,
      ),
    ).toEqual({ allowed: false, reasons: ["tenant_not_entitled"] });
  });

  it("allows the development fixture tenant for bounded internal search", () => {
    const decision = evaluateTenantEntitlement(
      fixtureEntitlement,
      {
        tenantId: "tmg_fixture",
        purpose: "internal_search",
        providerId: "fixture",
        providerAuthority: "fixture",
        requestedMediaDurationMs: 1_000,
        requestedVectors: 1,
      },
      emptyUsage,
    );

    expect(decision).toEqual({ allowed: true, reasons: [] });
  });

  it("rejects external purposes and provider authority escalation", () => {
    const decision = evaluateTenantEntitlement(
      fixtureEntitlement,
      {
        tenantId: "tmg_fixture",
        purpose: "external_api",
        providerId: "twelvelabs-marengo3",
        providerAuthority: "authoritative",
      },
      emptyUsage,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("purpose_not_entitled");
    expect(decision.reasons).toContain("provider_not_entitled");
    expect(decision.reasons).toContain("provider_authority_exceeds_entitlement");
  });

  it("rejects projected usage that exceeds any configured quota", () => {
    const decision = evaluateTenantEntitlement(
      fixtureEntitlement,
      {
        tenantId: "tmg_fixture",
        purpose: "internal_search",
        providerId: "fixture",
        providerAuthority: "fixture",
        requestedMediaDurationMs: 1,
        requestedVectors: 1,
      },
      {
        requestsThisHour: 120,
        mediaDurationMsToday: 3_600_000,
        vectorsToday: 1_000,
      },
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
});
