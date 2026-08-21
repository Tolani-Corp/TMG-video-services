import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const req = (name) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const grantsOff = Object.freeze({ externalApi: false, mcp: false, advertising: false, datasetExport: false, licensing: false });

export function validateCascadeParent({ plan, parentCurrent, tenantId, parentAssetId, rightsProfileId, planId }) {
  if (plan?.schemaVersion !== "1.0.0" || parentCurrent?.schemaVersion !== "1.0.0") throw new Error("Unsupported cascade control schema");
  if (plan.planId !== planId) throw new Error("Dispatched plan ID does not match immutable plan");
  if (plan.tenantId !== tenantId || plan.parentAssetId !== parentAssetId || plan.parentRightsProfileId !== rightsProfileId) throw new Error("Temporal plan identity mismatch");
  if (parentCurrent.tenantId !== tenantId || parentCurrent.assetId !== parentAssetId || parentCurrent.rightsProfileId !== rightsProfileId) throw new Error("Parent current-rights identity mismatch");
  if (!Array.isArray(plan.children) || plan.children.length < 1 || plan.children.length > 64) throw new Error("Temporal plan child count outside governed bounds");
  const changedRevision = parentCurrent.currentRevision !== plan.parentRightsRevision;
  const blockedState = parentCurrent.evidenceState !== "verified";
  if (!changedRevision && !blockedState) throw new Error("Cascade requires parent rights revision/state change after materialization");
  return { planId: plan.planId, childCount: plan.children.length, changedRevision, blockedState, parentCurrentRevision: parentCurrent.currentRevision, parentEvidenceState: parentCurrent.evidenceState };
}

export function prepareChildCascade({ plan, parentCurrent, childManifest, childCurrent, childRights, shadowReceipt, reason, revokedAt }) {
  if (!reason?.trim()) throw new Error("Cascade revocation reason required");
  if (!Number.isFinite(Date.parse(revokedAt))) throw new Error("revokedAt must be a valid timestamp");
  const planChild = plan.children.find((child) => child.childAssetId === childManifest?.assetId);
  if (!planChild) throw new Error("Child is not part of immutable temporal plan");
  if (childManifest.tenantId !== plan.tenantId || childCurrent.tenantId !== plan.tenantId || childRights.tenantId !== plan.tenantId) throw new Error("Child tenant mismatch");
  if (childCurrent.assetId !== planChild.childAssetId || childRights.assetId !== planChild.childAssetId || childManifest.assetId !== planChild.childAssetId) throw new Error("Child asset identity mismatch");
  if (childCurrent.rightsProfileId !== planChild.childRightsProfileId || childRights.rightsProfileId !== planChild.childRightsProfileId || childManifest.rightsProfileId !== planChild.childRightsProfileId) throw new Error("Child rights profile mismatch");
  if (childCurrent.currentRevision !== childRights.revision || childCurrent.revisionKey !== `${planChild.childRoot}/control/rights/${planChild.childRightsProfileId}/r${childRights.revision}.json`) throw new Error("Child current-rights pointer is stale or malformed");
  if (childManifest.media?.sha256 !== planChild.sourceSha256 || childManifest.media?.objectKey !== planChild.mediaObjectKey) throw new Error("Child media does not match immutable materialization plan");
  const receiptState = shadowReceipt?.status ?? "missing";
  if (shadowReceipt && (shadowReceipt.assetId !== planChild.childAssetId || shadowReceipt.rightsProfileId !== planChild.childRightsProfileId || shadowReceipt.authority !== "development_shadow_only")) throw new Error("Shadow receipt does not match derived child");
  if (shadowReceipt && !["indexed_shadow", "revoked_shadow"].includes(shadowReceipt.status)) throw new Error(`Unsupported shadow receipt status ${shadowReceipt.status}`);
  if (receiptState === "indexed_shadow" && !/^[a-f0-9]{64}$/.test(shadowReceipt.vectorId ?? "")) throw new Error("Active shadow receipt has invalid vector ID");

  const shadowAction = receiptState === "indexed_shadow" ? "revoke_vector" : "none";
  const vectorId = shadowAction === "revoke_vector" ? shadowReceipt.vectorId : null;
  if (childCurrent.evidenceState === "revoked" || childRights.evidenceState === "revoked" || childRights.revokedAt) {
    return { status: "already_revoked", childAssetId: planChild.childAssetId, childRightsProfileId: planChild.childRightsProfileId, childRoot: planChild.childRoot, shadowAction, vectorId, rights: null, current: childCurrent, event: { schemaVersion: "1.0.0", eventType: "derived_rights_cascade", status: "already_revoked", authority: "development_cascade_only", parentAssetId: plan.parentAssetId, parentCurrentRevision: parentCurrent.currentRevision, parentEvidenceState: parentCurrent.evidenceState, materializedParentRightsRevision: plan.parentRightsRevision, planId: plan.planId, childAssetId: planChild.childAssetId, childRightsProfileId: planChild.childRightsProfileId, shadowReceiptState: receiptState, shadowAction, vectorId, reason, createdAt: revokedAt } };
  }

  const nextRevision = childRights.revision + 1;
  const revisionKey = `${planChild.childRoot}/control/rights/${planChild.childRightsProfileId}/r${nextRevision}.json`;
  const rights = { ...childRights, evidenceState: "revoked", grants: { ...grantsOff }, revision: nextRevision, updatedAt: revokedAt, revokedAt, revocationReason: `parent_rights_cascade:${reason}` };
  const current = { schemaVersion: "1.0.0", tenantId: plan.tenantId, assetId: planChild.childAssetId, rightsProfileId: planChild.childRightsProfileId, currentRevision: nextRevision, evidenceState: "revoked", updatedAt: revokedAt, revisionKey };
  const event = { schemaVersion: "1.0.0", eventType: "derived_rights_cascade", status: "revoked", authority: "development_cascade_only", parentAssetId: plan.parentAssetId, parentCurrentRevision: parentCurrent.currentRevision, parentEvidenceState: parentCurrent.evidenceState, materializedParentRightsRevision: plan.parentRightsRevision, planId: plan.planId, childAssetId: planChild.childAssetId, childRightsProfileId: planChild.childRightsProfileId, previousChildRightsRevision: childRights.revision, revokedChildRightsRevision: nextRevision, shadowReceiptState: receiptState, shadowAction, vectorId, reason, createdAt: revokedAt };
  return { status: "revoked", childAssetId: planChild.childAssetId, childRightsProfileId: planChild.childRightsProfileId, childRoot: planChild.childRoot, shadowAction, vectorId, rights, current, event };
}

async function readBody(response) { const text = await response.text(); if (!text) return null; try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; } }
async function cf(pathname, init = {}) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${req("CLOUDFLARE_ACCOUNT_ID")}/vectorize/v2/indexes/${encodeURIComponent(req("TMG_MARENGO_SHADOW_INDEX"))}`;
  const response = await fetch(base + pathname, { ...init, headers: { authorization: `Bearer ${req("CLOUDFLARE_API_TOKEN")}`, ...(init.headers ?? {}) } });
  const body = await readBody(response);
  if (!response.ok || body?.success !== true) throw new Error(`Vectorize HTTP ${response.status}: ${JSON.stringify(body?.errors ?? body)}`);
  return body.result;
}
async function vectorPresent(id) { const result = await cf("/get_by_ids", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) }); return Array.isArray(result) && result.some((value) => value?.id === id); }
async function waitAbsent(id) { const end = Date.now() + 90000; while (Date.now() < end) { if (!(await vectorPresent(id))) return; await sleep(2500); } throw new Error(`Shadow vector remained present after deletion: ${id}`); }

function validateParent() {
  const plan = read(req("TMG_CASCADE_PLAN_PATH"));
  const parentCurrent = read(req("TMG_CASCADE_PARENT_CURRENT_RIGHTS_PATH"));
  const result = validateCascadeParent({ plan, parentCurrent, tenantId: req("TMG_CASCADE_TENANT_ID"), parentAssetId: req("TMG_CASCADE_PARENT_ASSET_ID"), rightsProfileId: req("TMG_CASCADE_PARENT_RIGHTS_PROFILE_ID"), planId: req("TMG_CASCADE_PLAN_ID") });
  console.log(JSON.stringify({ status: "cascade_parent_valid", ...result }));
}

function prepareChild() {
  const plan = read(req("TMG_CASCADE_PLAN_PATH")); const parentCurrent = read(req("TMG_CASCADE_PARENT_CURRENT_RIGHTS_PATH"));
  const childManifest = read(req("TMG_CASCADE_CHILD_MANIFEST_PATH")); const childCurrent = read(req("TMG_CASCADE_CHILD_CURRENT_RIGHTS_PATH")); const childRights = read(req("TMG_CASCADE_CHILD_RIGHTS_PATH"));
  const receiptPath = process.env.TMG_CASCADE_CHILD_SHADOW_RECEIPT_PATH; const shadowReceipt = receiptPath && fs.existsSync(receiptPath) ? read(receiptPath) : null;
  const result = prepareChildCascade({ plan, parentCurrent, childManifest, childCurrent, childRights, shadowReceipt, reason: req("TMG_CASCADE_REASON"), revokedAt: process.env.TMG_CASCADE_REVOKED_AT ?? new Date().toISOString() });
  const out = req("TMG_CASCADE_CHILD_OUTPUT_DIR"); write(path.join(out, "cascade-result.json"), result); if (result.rights) write(path.join(out, "revoked-rights.json"), result.rights); write(path.join(out, "current-rights.json"), result.current); write(path.join(out, "cascade-event.json"), result.event);
  console.log(JSON.stringify({ status: result.status, childAssetId: result.childAssetId, shadowAction: result.shadowAction, vectorId: result.vectorId }));
}

async function deleteShadow() {
  const result = read(req("TMG_CASCADE_CHILD_RESULT_PATH"));
  if (result.shadowAction !== "revoke_vector") { console.log(JSON.stringify({ status: "shadow_delete_skipped", childAssetId: result.childAssetId })); return; }
  const receipt = read(req("TMG_CASCADE_CHILD_SHADOW_RECEIPT_PATH"));
  if (receipt.status !== "indexed_shadow" || receipt.vectorId !== result.vectorId || receipt.authority !== "development_shadow_only") throw new Error("Active shadow receipt changed after cascade preparation");
  const deletion = await cf("/delete_by_ids", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [receipt.vectorId] }) });
  if (!deletion?.mutationId) throw new Error("Vectorize delete mutationId missing"); await waitAbsent(receipt.vectorId);
  const revokedAt = new Date().toISOString();
  const revokedReceipt = { ...receipt, status: "revoked_shadow", deleteMutationId: deletion.mutationId, revokedAt };
  const event = { schemaVersion: "1.0.0", eventType: "derived_shadow_cascade_revocation", status: "revoked_shadow", authority: "development_cascade_only", parentAssetId: result.event.parentAssetId, planId: result.event.planId, childAssetId: result.childAssetId, childRightsProfileId: result.childRightsProfileId, vectorId: receipt.vectorId, deleteMutationId: deletion.mutationId, revokedAt };
  write(req("TMG_CASCADE_CHILD_REVOKED_RECEIPT_PATH"), revokedReceipt); write(req("TMG_CASCADE_CHILD_SHADOW_EVENT_PATH"), event);
  console.log(JSON.stringify({ status: "shadow_revoked", childAssetId: result.childAssetId, vectorId: receipt.vectorId, deleteMutationId: deletion.mutationId }));
}

function summarize() {
  const root = req("TMG_CASCADE_OUTPUT_ROOT"); const results = [];
  for (const name of fs.readdirSync(root)) { const p = path.join(root, name, "cascade-result.json"); if (!fs.existsSync(p)) continue; const r = read(p); const shadowPath = path.join(root, name, "shadow-revocation-event.json"); results.push({ childAssetId: r.childAssetId, childRightsProfileId: r.childRightsProfileId, rightsStatus: r.status, shadowAction: r.shadowAction, vectorId: r.vectorId, shadowRevocation: fs.existsSync(shadowPath) ? read(shadowPath) : null }); }
  const summary = { schemaVersion: "1.0.0", status: "completed", authority: "development_cascade_only", tenantId: req("TMG_CASCADE_TENANT_ID"), parentAssetId: req("TMG_CASCADE_PARENT_ASSET_ID"), parentRightsProfileId: req("TMG_CASCADE_PARENT_RIGHTS_PROFILE_ID"), planId: req("TMG_CASCADE_PLAN_ID"), reason: req("TMG_CASCADE_REASON"), childCount: results.length, revokedChildren: results.filter((r) => r.rightsStatus === "revoked").length, alreadyRevokedChildren: results.filter((r) => r.rightsStatus === "already_revoked").length, deletedShadowVectors: results.filter((r) => r.shadowRevocation).length, children: results, completedAt: new Date().toISOString() };
  write(req("TMG_CASCADE_SUMMARY_PATH"), summary); console.log(JSON.stringify(summary));
}

async function main() { const command = process.argv[2]; if (command === "validate-parent") return validateParent(); if (command === "prepare-child") return prepareChild(); if (command === "delete-shadow") return deleteShadow(); if (command === "summarize") return summarize(); throw new Error("Expected validate-parent | prepare-child | delete-shadow | summarize"); }
if ((process.argv[1] ? pathToFileURL(process.argv[1]).href : null) === import.meta.url) Promise.resolve(main()).catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });
