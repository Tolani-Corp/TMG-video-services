import { describe, expect, it } from "vitest";
import { prepareChildCascade, validateCascadeParent } from "../scripts/derived-rights-cascade.mjs";

const tenantId = "tmg_fixture"; const parentAssetId = "parent"; const parentRightsProfileId = "parent_rights"; const childAssetId = "child"; const childRightsProfileId = "child_rights";
const plan = { schemaVersion: "1.0.0", planId: "tsp_test", tenantId, parentAssetId, parentRightsProfileId, parentRightsRevision: 1, children: [{ childAssetId, childRightsProfileId, childRoot: `tenants/${tenantId}/assets/${childAssetId}`, mediaObjectKey: `tenants/${tenantId}/assets/${childAssetId}/media/segment.mp4`, sourceSha256: "a".repeat(64) }] };
const parentCurrent = { schemaVersion: "1.0.0", tenantId, assetId: parentAssetId, rightsProfileId: parentRightsProfileId, currentRevision: 2, evidenceState: "revoked" };
const manifest = { tenantId, assetId: childAssetId, rightsProfileId: childRightsProfileId, media: { sha256: "a".repeat(64), objectKey: `tenants/${tenantId}/assets/${childAssetId}/media/segment.mp4` } };
const current = { schemaVersion: "1.0.0", tenantId, assetId: childAssetId, rightsProfileId: childRightsProfileId, currentRevision: 1, evidenceState: "verified", revisionKey: `tenants/${tenantId}/assets/${childAssetId}/control/rights/${childRightsProfileId}/r1.json` };
const rights = { schemaVersion: "1.0.0", tenantId, assetId: childAssetId, rightsProfileId: childRightsProfileId, evidenceState: "verified", sourceEvidenceRef: "evidence:test", allowedTerritories: [], allowedTenantIds: [], grants: { externalApi: false, mcp: false, advertising: false, datasetExport: false, licensing: false }, revision: 1, updatedAt: "2026-08-21T00:00:00Z" };
const receipt = { status: "indexed_shadow", authority: "development_shadow_only", tenantId, assetId: childAssetId, rightsProfileId: childRightsProfileId, vectorId: "b".repeat(64) };

describe("derived rights cascade", () => {
  it("requires parent rights to have changed after materialization", () => {
    expect(() => validateCascadeParent({ plan, parentCurrent: { ...parentCurrent, currentRevision: 1, evidenceState: "verified" }, tenantId, parentAssetId, rightsProfileId: parentRightsProfileId, planId: plan.planId })).toThrow(/requires parent rights revision\/state change/);
  });
  it("accepts a stale materialization after parent revocation", () => {
    expect(validateCascadeParent({ plan, parentCurrent, tenantId, parentAssetId, rightsProfileId: parentRightsProfileId, planId: plan.planId })).toMatchObject({ changedRevision: true, blockedState: true, childCount: 1 });
  });
  it("creates a new revoked child rights revision before vector cleanup", () => {
    const out = prepareChildCascade({ plan, parentCurrent, childManifest: manifest, childCurrent: current, childRights: rights, shadowReceipt: receipt, reason: "parent revoked", revokedAt: "2026-08-21T12:00:00Z" });
    expect(out.status).toBe("revoked"); expect(out.rights.revision).toBe(2); expect(out.rights.evidenceState).toBe("revoked"); expect(out.shadowAction).toBe("revoke_vector"); expect(Object.values(out.rights.grants).every((value) => value === false)).toBe(true);
  });
  it("is idempotent for already revoked child rights but still cleans an active vector", () => {
    const revokedRights = { ...rights, evidenceState: "revoked", revision: 2, revokedAt: "2026-08-21T12:00:00Z", revocationReason: "prior", updatedAt: "2026-08-21T12:00:00Z" };
    const revokedCurrent = { ...current, currentRevision: 2, evidenceState: "revoked", revisionKey: `tenants/${tenantId}/assets/${childAssetId}/control/rights/${childRightsProfileId}/r2.json` };
    const out = prepareChildCascade({ plan, parentCurrent, childManifest: manifest, childCurrent: revokedCurrent, childRights: revokedRights, shadowReceipt: receipt, reason: "retry", revokedAt: "2026-08-21T12:10:00Z" });
    expect(out.status).toBe("already_revoked"); expect(out.rights).toBeNull(); expect(out.shadowAction).toBe("revoke_vector");
  });
  it("rejects a shadow receipt bound to another child", () => {
    expect(() => prepareChildCascade({ plan, parentCurrent, childManifest: manifest, childCurrent: current, childRights: rights, shadowReceipt: { ...receipt, assetId: "other" }, reason: "parent revoked", revokedAt: "2026-08-21T12:00:00Z" })).toThrow(/receipt does not match/);
  });
});
