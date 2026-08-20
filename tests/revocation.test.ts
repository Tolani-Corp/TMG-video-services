import { describe, expect, it, vi } from "vitest";
import type { RightsRegistryRecord } from "../src/ingestion";
import {
  deleteIndexedVectorsForRevocation,
  revokeRightsRecord,
  type IndexReceipt,
} from "../src/revocation";

const rights: RightsRegistryRecord = {
  schemaVersion: "1.0.0",
  rightsProfileId: "rights_1",
  assetId: "asset_1",
  tenantId: "tenant_1",
  evidenceState: "verified",
  sourceEvidenceRef: "evidence://1",
  allowedTerritories: [],
  allowedTenantIds: ["tenant_1"],
  grants: {
    externalApi: true,
    mcp: true,
    advertising: true,
    datasetExport: true,
    licensing: true,
  },
  revision: 1,
  updatedAt: "2026-08-20T20:00:00.000Z",
};

const receipt: IndexReceipt = {
  schemaVersion: "1.0.0",
  tenantId: "tenant_1",
  assetId: "asset_1",
  rightsProfileId: "rights_1",
  embeddingProfileId: "profile_1",
  vectorIds: ["v1", "v2"],
  mutationId: "m1",
  indexedAt: "2026-08-20T20:00:00.000Z",
  status: "indexed",
};

describe("revocation propagation", () => {
  it("revokes every commercial grant and increments the rights revision", () => {
    const revoked = revokeRightsRecord(rights, {
      reason: "license terminated",
      revokedAt: "2026-08-20T21:00:00.000Z",
    });

    expect(revoked.evidenceState).toBe("revoked");
    expect(revoked.revision).toBe(2);
    expect(Object.values(revoked.grants).every((value) => value === false)).toBe(true);
  });

  it("deletes every vector recorded for the matching asset", async () => {
    const deleteByIds = vi.fn(async () => ({ mutationId: "delete-mutation-1" }));
    const updated = await deleteIndexedVectorsForRevocation(
      { deleteByIds },
      receipt,
      rights,
      "2026-08-20T21:00:00.000Z",
    );

    expect(deleteByIds).toHaveBeenCalledWith(["v1", "v2"]);
    expect(updated.status).toBe("revoked");
    expect(updated.revokeMutationId).toBe("delete-mutation-1");
  });

  it("refuses to delete vectors for a mismatched rights profile", async () => {
    await expect(
      deleteIndexedVectorsForRevocation(
        { deleteByIds: async () => ({ mutationId: "x" }) },
        receipt,
        { ...rights, rightsProfileId: "different" },
        "2026-08-20T21:00:00.000Z",
      ),
    ).rejects.toThrow(/rights profile mismatch/);
  });
});
