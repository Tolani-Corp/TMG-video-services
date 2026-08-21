import fs from "node:fs";
import { pathToFileURL } from "node:url";

const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const req = (name) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };

export function validatePointer({ pointer, rights, operation = "evaluate", label = "asset" }) {
  if (pointer?.schemaVersion !== "1.0.0") throw new Error(`${label} current-rights pointer schema unsupported`);
  if (pointer.tenantId !== rights.tenantId || pointer.assetId !== rights.assetId || pointer.rightsProfileId !== rights.rightsProfileId) throw new Error(`${label} current-rights pointer identity mismatch`);
  if (!Number.isInteger(pointer.currentRevision) || pointer.currentRevision < rights.revision) throw new Error(`${label} current-rights pointer revision regressed`);
  if (operation === "evaluate") {
    if (pointer.currentRevision !== rights.revision) throw new Error(`${label} selected rights revision is stale`);
    if (pointer.evidenceState !== "verified" || rights.evidenceState !== "verified" || rights.revokedAt) throw new Error(`${label} current rights are not verified`);
  }
  return true;
}

export function validateDerivedParent({ derivation, parentPointer, parentRights, operation = "evaluate", nowIso }) {
  const parent = derivation?.parent;
  if (derivation?.schemaVersion !== "1.0.0" || derivation?.authority !== "development_materialization_only" || derivation?.publicationAuthority !== false || !parent) throw new Error("Derived segment lineage is invalid");
  if (parentPointer.tenantId !== derivation.tenantId || parentPointer.assetId !== parent.assetId || parentPointer.rightsProfileId !== parent.rightsProfileId) throw new Error("Parent current-rights pointer does not match derivation");
  if (parentRights.tenantId !== derivation.tenantId || parentRights.assetId !== parent.assetId || parentRights.rightsProfileId !== parent.rightsProfileId) throw new Error("Parent rights record does not match derivation");
  if (parentPointer.currentRevision !== parentRights.revision) throw new Error("Parent rights record is not current");
  if (operation === "evaluate") {
    if (parentPointer.currentRevision !== parent.rightsRevision) throw new Error("Parent rights changed after segment materialization; rematerialization required");
    if (parentPointer.evidenceState !== "verified" || parentRights.evidenceState !== "verified" || parentRights.revokedAt) throw new Error("Parent current rights are not verified");
    if (parentRights.expiresAt && Date.parse(parentRights.expiresAt) <= Date.parse(nowIso)) throw new Error("Parent current rights expired");
  }
  return true;
}

function main() {
  const operation = process.env.TMG_SHADOW_ACTION ?? "evaluate";
  const rights = read(req("TMG_SHADOW_RIGHTS_PATH"));
  const pointerPath = process.env.TMG_SHADOW_CURRENT_RIGHTS_PATH;
  if (!pointerPath || !fs.existsSync(pointerPath)) {
    if (operation === "revoke") {
      console.log(JSON.stringify({ status: "current_rights_pointer_absent_but_revoke_allowed" }));
      return;
    }
    throw new Error("Current rights pointer required for shadow evaluation");
  }
  const pointer = read(pointerPath);
  validatePointer({ pointer, rights, operation, label: "asset" });
  const derivationPath = process.env.TMG_SHADOW_DERIVATION_PATH;
  if (operation === "evaluate" && derivationPath && fs.existsSync(derivationPath)) {
    const derivation = read(derivationPath);
    const parentPointer = read(req("TMG_SHADOW_PARENT_CURRENT_RIGHTS_PATH"));
    const parentRights = read(req("TMG_SHADOW_PARENT_RIGHTS_PATH"));
    validateDerivedParent({ derivation, parentPointer, parentRights, operation, nowIso: new Date().toISOString() });
  }
  console.log(JSON.stringify({ status: "current_rights_verified", operation }));
}

if ((process.argv[1] ? pathToFileURL(process.argv[1]).href : null) === import.meta.url) {
  try { main(); } catch (error) { console.error(error?.stack ?? String(error)); process.exit(1); }
}
