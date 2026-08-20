import { describe, expect, it } from "vitest";
import type { EmbeddingProfile } from "../src/embedding";
import {
  buildArtifactKeys,
  buildVideoSegmentRecords,
  effectiveRightsEvidenceState,
  parseGovernedIngestionRequest,
  type CanonicalAssetManifest,
  type RightsRegistryRecord,
} from "../src/ingestion";

const manifest: CanonicalAssetManifest = {
  schemaVersion: "1.0.0",
  assetId: "fixture_asset_1",
  tenantId: "tmg_fixture",
  ingestRunId: "fixture_run_1",
  source: {
    sourceClass: "fixture",
    authorityRef: "repo://fixtures/harmless/harmless-fixture.mp4",
  },
  media: {
    objectKey: "tenants/tmg_fixture/assets/fixture_asset_1/media/original.mp4",
    sha256: "479a18838b9914e6994725f3b8dc7e15bc07ffe80ab3b1c1805e195d0251f1e3",
    bytes: 1441,
    mimeType: "video/mp4",
    durationMs: 2000,
  },
  rightsProfileId: "fixture_rights_1",
  publicationState: "review",
  receivedAt: "2026-08-20T20:00:00.000Z",
};

const rights: RightsRegistryRecord = {
  schemaVersion: "1.0.0",
  rightsProfileId: "fixture_rights_1",
  assetId: "fixture_asset_1",
  tenantId: "tmg_fixture",
  evidenceState: "verified",
  sourceEvidenceRef: "repo://fixtures/harmless/rights.json",
  allowedTerritories: [],
  allowedTenantIds: ["tmg_fixture"],
  grants: {
    externalApi: false,
    mcp: false,
    advertising: false,
    datasetExport: false,
    licensing: false,
  },
  revision: 1,
  updatedAt: "2026-08-20T20:00:00.000Z",
};

const profile: EmbeddingProfile = {
  id: "fixture_video_4_v1",
  provider: "fixture",
  model: "fixture",
  modelVersion: "1",
  dimensions: 4,
  modalities: ["fused"],
  compatibilityGroup: "fixture_video_4",
};

describe("governed ingestion control envelope", () => {
  it("accepts a bound manifest, rights revision, and non-overlapping segment plan", () => {
    const parsed = parseGovernedIngestionRequest({
      manifest,
      rights,
      segments: [
        { segmentId: "s0", startMs: 0, endMs: 1000 },
        { segmentId: "s1", startMs: 1000, endMs: 2000 },
      ],
    });

    expect(parsed.manifest.assetId).toBe("fixture_asset_1");
  });

  it("rejects cross-asset rights binding", () => {
    expect(() =>
      parseGovernedIngestionRequest({
        manifest,
        rights: { ...rights, assetId: "different_asset" },
        segments: [{ segmentId: "s0", startMs: 0, endMs: 1000 }],
      }),
    ).toThrow(/assetId/);
  });

  it("rejects overlapping segments", () => {
    expect(() =>
      parseGovernedIngestionRequest({
        manifest,
        rights,
        segments: [
          { segmentId: "s0", startMs: 0, endMs: 1200 },
          { segmentId: "s1", startMs: 1000, endMs: 2000 },
        ],
      }),
    ).toThrow(/overlaps/);
  });

  it("computes canonical artifact keys without accepting arbitrary prefixes", () => {
    const keys = buildArtifactKeys(manifest, rights);
    expect(keys.manifest).toBe(
      "tenants/tmg_fixture/assets/fixture_asset_1/control/manifest-v1.json",
    );
    expect(keys.rightsRevision).toContain("fixture_rights_1/r1.json");
  });

  it("converts expired and revoked records into non-indexable evidence states", () => {
    expect(
      effectiveRightsEvidenceState(
        { ...rights, expiresAt: "2026-08-19T00:00:00.000Z" },
        "2026-08-20T00:00:00.000Z",
      ),
    ).toBe("expired");
    expect(
      effectiveRightsEvidenceState(
        {
          ...rights,
          evidenceState: "revoked",
          revokedAt: "2026-08-20T00:00:00.000Z",
          revocationReason: "fixture revocation",
        },
        "2026-08-20T01:00:00.000Z",
      ),
    ).toBe("revoked");
  });

  it("keeps fixture records in review and with all external grants false", () => {
    const [record] = buildVideoSegmentRecords(
      manifest,
      rights,
      profile,
      [{ segmentId: "s0", startMs: 0, endMs: 1000 }],
      "2026-08-20T20:00:00.000Z",
    );

    expect(record?.publicationState).toBe("review");
    expect(record?.rights.grants.mcp).toBe(false);
    expect(record?.rights.grants.externalApi).toBe(false);
  });
});
