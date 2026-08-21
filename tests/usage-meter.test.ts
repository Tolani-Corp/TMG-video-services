import { describe, expect, it } from "vitest";
import { createUsageEvent, UsageMeterError } from "../src/usage-meter";

describe("createUsageEvent", () => {
  it("records raw development usage without inventing cost", () => {
    const event = createUsageEvent({
      eventId: "usage_test_001",
      occurredAt: "2026-08-21T20:00:00.000Z",
      tenantId: "tmg_fixture",
      purpose: "internal_search",
      providerId: "fixture",
      providerAuthority: "fixture",
      requestUnits: 1,
      mediaDurationMs: 1_000,
      vectorCount: 1,
      billingDisposition: "development_non_billable",
      commercialReleaseApproved: false,
    });

    expect(event.billingDisposition).toBe("development_non_billable");
    expect(event.usage).toEqual({ requestUnits: 1, mediaDurationMs: 1_000, vectorCount: 1 });
    expect(event).not.toHaveProperty("cost");
    expect(event).not.toHaveProperty("estimatedCost");
  });

  it("rejects billing eligibility without explicit commercial release approval", () => {
    expect(() =>
      createUsageEvent({
        eventId: "usage_test_002",
        occurredAt: "2026-08-21T20:00:00.000Z",
        tenantId: "tenant_001",
        purpose: "external_api",
        providerId: "twelvelabs-marengo3",
        providerAuthority: "authoritative",
        requestUnits: 1,
        mediaDurationMs: 1_000,
        vectorCount: 1,
        billingDisposition: "eligible_for_billing",
        commercialReleaseApproved: false,
      }),
    ).toThrow(UsageMeterError);
  });

  it("rejects billing eligibility for non-authoritative provider routing", () => {
    expect(() =>
      createUsageEvent({
        eventId: "usage_test_003",
        occurredAt: "2026-08-21T20:00:00.000Z",
        tenantId: "tenant_001",
        purpose: "external_api",
        providerId: "twelvelabs-marengo3",
        providerAuthority: "shadow",
        requestUnits: 1,
        mediaDurationMs: 1_000,
        vectorCount: 1,
        billingDisposition: "eligible_for_billing",
        commercialReleaseApproved: true,
      }),
    ).toThrow(/authoritative provider routing/);
  });
});
