import { describe, expect, it } from "vitest";
import { buildDerivedControl, validateCurrentPointer, validateMaterializationControl } from "../scripts/materialize-temporal-segments.mjs";

const manifest = { schemaVersion: "1.0.0", assetId: "parent", tenantId: "tenant", ingestRunId: "run", source: { sourceClass: "licensed", authorityRef: "contract:1" }, media: { objectKey: "tenants/tenant/assets/parent/media/original.mp4", sha256: "a".repeat(64), bytes: 1000, mimeType: "video/mp4", durationMs: 120000 }, rightsProfileId: "rights", publicationState: "review", receivedAt: "2026-08-21T00:00:00Z" };
const rights = { schemaVersion: "1.0.0", rightsProfileId: "rights", assetId: "parent", tenantId: "tenant", evidenceState: "verified", sourceEvidenceRef: "evidence:1", allowedTerritories: ["US"], allowedTenantIds: ["tenant"], grants: { externalApi: false, mcp: false, advertising: false, datasetExport: false, licensing: false }, revision: 3, updatedAt: "2026-08-21T00:00:00Z" };
const current = { schemaVersion: "1.0.0", tenantId: "tenant", assetId: "parent", rightsProfileId: "rights", currentRevision: 3, evidenceState: "verified", updatedAt: "2026-08-21T00:00:00Z", revisionKey: "tenants/tenant/assets/parent/control/rights/rights/r3.json" };

it("requires the dispatched rights revision to be current", () => {
  expect(() => validateCurrentPointer({ ...current, currentRevision: 4 }, rights)).toThrow(/not current/);
});

it("accepts bounded non-overlapping temporal windows", () => {
  expect(validateMaterializationControl({ manifest, rights, current, segments: [{ segmentId: "s1", startMs: 0, endMs: 10000 }, { segmentId: "s2", startMs: 10000, endMs: 40000 }], nowIso: "2026-08-21T01:00:00Z" })).toBe(true);
});

it("rejects overlap and windows outside the Marengo bound", () => {
  expect(() => validateMaterializationControl({ manifest, rights, current, segments: [{ segmentId: "s1", startMs: 0, endMs: 10000 }, { segmentId: "s2", startMs: 9000, endMs: 15000 }], nowIso: "2026-08-21T01:00:00Z" })).toThrow(/overlaps/);
  expect(() => validateMaterializationControl({ manifest, rights, current, segments: [{ segmentId: "s1", startMs: 0, endMs: 3500 }], nowIso: "2026-08-21T01:00:00Z" })).toThrow(/4-30/);
});

it("fails closed for revoked or blocked parent controls", () => {
  expect(() => validateMaterializationControl({ manifest, rights: { ...rights, evidenceState: "revoked", revokedAt: "2026-08-21T00:30:00Z" }, current: { ...current, evidenceState: "revoked" }, segments: [{ segmentId: "s1", startMs: 0, endMs: 10000 }], nowIso: "2026-08-21T01:00:00Z" })).toThrow(/verified rights/);
  expect(() => validateMaterializationControl({ manifest: { ...manifest, publicationState: "blocked" }, rights, current, segments: [{ segmentId: "s1", startMs: 0, endMs: 10000 }], nowIso: "2026-08-21T01:00:00Z" })).toThrow(/Blocked/);
});

it("creates deterministic child identity, review-only manifest, and immutable lineage", () => {
  const args = { manifest, rights, segment: { segmentId: "s1", startMs: 10000, endMs: 20000 }, childMedia: { sha256: "b".repeat(64), bytes: 5000, durationMs: 10000 }, runId: "42", createdAt: "2026-08-21T01:00:00Z" };
  const a = buildDerivedControl(args); const b = buildDerivedControl(args);
  expect(a.childAssetId).toBe(b.childAssetId);
  expect(a.derivedManifest.publicationState).toBe("review");
  expect(a.derivedRights.grants).toEqual(rights.grants);
  expect(a.derivation.publicationAuthority).toBe(false);
  expect(a.derivation.parent.rightsRevision).toBe(3);
});
