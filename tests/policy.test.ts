import { describe, expect, it } from "vitest";
import type { VideoSegmentRecord } from "../src/domain";
import { evaluateRetrievalPolicy } from "../src/policy";

function segment(overrides: Partial<VideoSegmentRecord> = {}): VideoSegmentRecord {
  return {
    assetId: "asset_1",
    segmentId: "segment_1",
    startMs: 0,
    endMs: 5000,
    publicationState: "approved",
    tenantId: "tenant_1",
    embeddingProfileId: "marengo3_512_v1",
    embeddingDimensions: 512,
    rights: {
      rightsProfileId: "rights_1",
      evidenceState: "verified",
      sourceEvidenceRef: "r2://rights/rights_1.json",
      allowedTerritories: ["US"],
      allowedTenantIds: ["tenant_1"],
      grants: {
        externalApi: true,
        mcp: true,
        advertising: false,
        datasetExport: false,
        licensing: false,
      },
    },
    ...overrides,
  };
}

describe("evaluateRetrievalPolicy", () => {
  it("allows an approved MCP retrieval with verified purpose-specific rights", () => {
    const decision = evaluateRetrievalPolicy(segment(), {
      purpose: "mcp",
      tenantId: "tenant_1",
      territory: "US",
      nowIso: "2026-08-20T20:00:00Z",
    });

    expect(decision).toEqual({ allowed: true, reasons: [] });
  });

  it("denies advertising when advertising rights were not granted", () => {
    const decision = evaluateRetrievalPolicy(segment(), {
      purpose: "advertising",
      tenantId: "tenant_1",
      territory: "US",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("purpose_not_granted:advertising");
  });

  it("denies external retrieval when publication is not approved", () => {
    const decision = evaluateRetrievalPolicy(segment({ publicationState: "review" }), {
      purpose: "external_api",
      tenantId: "tenant_1",
      territory: "US",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("publication_not_approved");
  });

  it("permits internal review content when verified and not blocked", () => {
    const decision = evaluateRetrievalPolicy(segment({ publicationState: "review" }), {
      purpose: "internal_search",
      tenantId: "tenant_1",
      territory: "US",
    });

    expect(decision.allowed).toBe(true);
  });

  it("denies retrieval outside the granted territory", () => {
    const decision = evaluateRetrievalPolicy(segment(), {
      purpose: "mcp",
      tenantId: "tenant_1",
      territory: "DE",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("territory_not_granted");
  });

  it("denies expired rights", () => {
    const base = segment();
    const decision = evaluateRetrievalPolicy(
      {
        ...base,
        rights: {
          ...base.rights,
          expiresAt: "2026-08-19T00:00:00Z",
        },
      },
      {
        purpose: "mcp",
        tenantId: "tenant_1",
        territory: "US",
        nowIso: "2026-08-20T00:00:00Z",
      },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("rights_expired");
  });
});
