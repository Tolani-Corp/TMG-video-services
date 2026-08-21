import { expect, it } from "vitest";
import { validateDerivedParent, validatePointer } from "../scripts/validate-shadow-current-rights.mjs";

const rights = { tenantId: "t", assetId: "a", rightsProfileId: "r", revision: 2, evidenceState: "verified" };
const pointer = { schemaVersion: "1.0.0", tenantId: "t", assetId: "a", rightsProfileId: "r", currentRevision: 2, evidenceState: "verified" };

it("blocks stale evaluation but allows deletion-only revocation", () => {
  expect(() => validatePointer({ pointer: { ...pointer, currentRevision: 3 }, rights, operation: "evaluate" })).toThrow(/stale/);
  expect(validatePointer({ pointer: { ...pointer, currentRevision: 3, evidenceState: "revoked" }, rights, operation: "revoke" })).toBe(true);
});

it("forces rematerialization after parent rights revision changes", () => {
  const derivation = { schemaVersion: "1.0.0", authority: "development_materialization_only", publicationAuthority: false, tenantId: "t", parent: { assetId: "p", rightsProfileId: "pr", rightsRevision: 1 } };
  const parentRights = { tenantId: "t", assetId: "p", rightsProfileId: "pr", revision: 2, evidenceState: "verified" };
  const parentPointer = { tenantId: "t", assetId: "p", rightsProfileId: "pr", currentRevision: 2, evidenceState: "verified" };
  expect(() => validateDerivedParent({ derivation, parentPointer, parentRights, operation: "evaluate", nowIso: "2026-08-21T00:00:00Z" })).toThrow(/rematerialization/);
  expect(validateDerivedParent({ derivation, parentPointer, parentRights, operation: "revoke", nowIso: "2026-08-21T00:00:00Z" })).toBe(true);
});
