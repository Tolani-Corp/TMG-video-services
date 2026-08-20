import { describe, expect, it } from "vitest";
import type { EmbeddingProfile } from "../src/embedding";
import type { VideoSegmentRecord } from "../src/domain";
import { IndexPreparationError, prepareVectorUpsert } from "../src/indexing";

const profile: EmbeddingProfile = {
  id: "fixture_4_v1",
  provider: "fixture",
  model: "fixture",
  modelVersion: "1",
  dimensions: 4,
  modalities: ["visual"],
  compatibilityGroup: "fixture_4",
};

function segment(evidenceState: VideoSegmentRecord["rights"]["evidenceState"] = "verified"): VideoSegmentRecord {
  return {
    assetId: "asset_1",
    segmentId: "segment_1",
    startMs: 0,
    endMs: 1000,
    publicationState: "review",
    tenantId: "tenant_1",
    embeddingProfileId: profile.id,
    embeddingDimensions: profile.dimensions,
    rights: {
      rightsProfileId: "rights_1",
      evidenceState,
      sourceEvidenceRef: "r2://rights/rights_1.json",
      allowedTerritories: [],
      allowedTenantIds: ["tenant_1"],
      grants: {
        externalApi: false,
        mcp: false,
        advertising: false,
        datasetExport: false,
        licensing: false,
      },
    },
  };
}

describe("prepareVectorUpsert", () => {
  it("creates a deterministic 64-character vector id and preserves G0 rights metadata", async () => {
    const first = await prepareVectorUpsert(segment(), profile, [0.1, 0.2, 0.3, 0.4]);
    const second = await prepareVectorUpsert(segment(), profile, [0.1, 0.2, 0.3, 0.4]);

    expect(first.id).toHaveLength(64);
    expect(first.id).toBe(second.id);
    expect(first.namespace).toBe("tenant_1");
    expect(first.metadata.publicationState).toBe("review");
    expect(first.metadata.mcp).toBe(false);
    expect(first.metadata.externalApi).toBe(false);
  });

  it("blocks searchable indexing before rights evidence is verified", async () => {
    await expect(
      prepareVectorUpsert(segment("pending"), profile, [0.1, 0.2, 0.3, 0.4]),
    ).rejects.toThrow(IndexPreparationError);
  });

  it("rejects an embedding with incompatible dimensions", async () => {
    await expect(prepareVectorUpsert(segment(), profile, [0.1, 0.2])).rejects.toThrow(
      /requires 4 dimensions/,
    );
  });
});
