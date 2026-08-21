import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PROVIDER = "twelvelabs-marengo3";
const MODEL = "marengo3.0";
const PROFILE = "twelvelabs_marengo3_fused_512_v1";
const GROUP = "marengo3_fused_512_v1";
const DIMS = 512;
const TL = "https://api.twelvelabs.io/v1.3";
const MAX_BYTES = 25 * 1024 * 1024;

const req = (n) => { const v = process.env[n]; if (!v) throw new Error(`Missing ${n}`); return v; };
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function validateShadowControl({ manifest, rights, acceptance, nowIso, operation = "evaluate" }) {
  if (manifest?.schemaVersion !== "1.0.0" || rights?.schemaVersion !== "1.0.0") throw new Error("Unsupported canonical control schema");
  if (manifest.assetId !== rights.assetId || manifest.tenantId !== rights.tenantId || manifest.rightsProfileId !== rights.rightsProfileId) throw new Error("Manifest/rights binding mismatch");
  if (operation === "evaluate") {
    if (rights.evidenceState !== "verified" || rights.revokedAt) throw new Error("Shadow evaluation requires verified, non-revoked rights");
    if (rights.expiresAt && Date.parse(rights.expiresAt) <= Date.parse(nowIso)) throw new Error("Shadow evaluation rights expired");
    if (rights.allowedTenantIds?.length && !rights.allowedTenantIds.includes(manifest.tenantId)) throw new Error("Tenant not allowed by rights evidence");
    if (!rights.sourceEvidenceRef) throw new Error("Canonical rights source evidence required");
    if (manifest.publicationState === "blocked") throw new Error("Blocked assets cannot enter shadow evaluation");
  } else if (operation !== "revoke") throw new Error(`Unsupported operation ${operation}`);
  const m = manifest.media ?? {};
  if (m.mimeType !== "video/mp4") throw new Error("Shadow v1 accepts only video/mp4");
  if (!Number.isInteger(m.bytes) || m.bytes <= 0 || m.bytes > MAX_BYTES) throw new Error("Media byte evidence outside shadow safety cap");
  if (!Number.isInteger(m.durationMs) || m.durationMs < 4000 || m.durationMs > 30000) throw new Error("Shadow v1 requires 4-30 second media");
  if (!/^[a-f0-9]{64}$/.test(m.sha256 ?? "")) throw new Error("Invalid media SHA-256 evidence");
  if (!m.objectKey?.startsWith(`tenants/${manifest.tenantId}/assets/${manifest.assetId}/`)) throw new Error("Media object key escapes canonical tenant/asset prefix");
  const a = acceptance?.providers?.[PROVIDER];
  if (acceptance?.schemaVersion !== "1.0.0" || a?.state !== "development_shadow_verified" || a?.authority !== "shadow_only" || a?.profileId !== PROFILE || a?.compatibilityGroup !== GROUP || a?.dimensions !== DIMS) throw new Error("Verified Marengo shadow acceptance evidence required");
  for (const k of ["authoritativeRoutingAllowed", "publicApiAllowed", "mcpAllowed", "commercialUseAllowed"]) if (a.promotion?.[k] !== false) throw new Error(`Unsupported Marengo authority: ${k}`);
  return { tenantId: manifest.tenantId, assetId: manifest.assetId, rightsProfileId: rights.rightsProfileId, rightsRevision: rights.revision, mediaObjectKey: m.objectKey, mediaSha256: m.sha256, mediaBytes: m.bytes, acceptanceEvidenceId: `${a.evidence.workflowRunId}:${a.evidence.artifactDigest}` };
}

export function buildShadowVectorRecord({ manifest, rights, vector, acceptanceEvidenceId }) {
  if (!Array.isArray(vector) || vector.length !== DIMS || vector.some((v) => !Number.isFinite(v))) throw new Error(`Expected finite ${DIMS}-dimensional Marengo vector`);
  return {
    id: digest(`${manifest.tenantId}:${manifest.assetId}:shadow_asset:${PROFILE}`),
    values: vector,
    namespace: manifest.tenantId,
    metadata: {
      tenantId: manifest.tenantId, assetId: manifest.assetId, segmentId: "shadow_asset",
      rightsVerified: true, publicationState: "review",
      externalApi: false, mcp: false, advertising: false, datasetExport: false, licensing: false,
      rightsProfileId: rights.rightsProfileId, rightsRevision: rights.revision,
      embeddingProfileId: PROFILE, compatibilityGroup: GROUP, providerId: PROVIDER, providerModel: MODEL,
      shadowAuthority: "development_only", sourcePublicationState: manifest.publicationState,
      sourceSha256: manifest.media.sha256, acceptanceEvidenceId,
    },
  };
}

async function body(r) { if (r.status === 204) return null; const t = await r.text(); if (!t) return null; try { return JSON.parse(t); } catch { return { message: t.slice(0, 300) }; } }
async function tl(path, init = {}, allow404 = false) {
  const r = await fetch(TL + path, { ...init, headers: { "x-api-key": req("TWELVELABS_API_KEY"), ...(init.headers ?? {}) } });
  const b = await body(r); if (allow404 && r.status === 404) return { r, b }; if (!r.ok) throw new Error(`TwelveLabs HTTP ${r.status}: ${b?.error?.message ?? b?.message ?? "provider error"}`); return { r, b };
}
async function cf(path, init = {}) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${req("CLOUDFLARE_ACCOUNT_ID")}/vectorize/v2/indexes/${encodeURIComponent(req("TMG_MARENGO_SHADOW_INDEX"))}`;
  const r = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${req("CLOUDFLARE_API_TOKEN")}`, ...(init.headers ?? {}) } });
  const b = await body(r); if (!r.ok || b?.success !== true) throw new Error(`Vectorize HTTP ${r.status}: ${JSON.stringify(b?.errors ?? b)}`); return b.result;
}

function controls(operation) {
  const manifest = read(req("TMG_SHADOW_MANIFEST_PATH")); const rights = read(req("TMG_SHADOW_RIGHTS_PATH")); const acceptance = read(process.env.TMG_PROVIDER_ACCEPTANCE_REGISTRY_PATH ?? "config/provider-acceptance-registry.json");
  const c = validateShadowControl({ manifest, rights, acceptance, nowIso: new Date().toISOString(), operation });
  if (req("TMG_SHADOW_TENANT_ID") !== c.tenantId || req("TMG_SHADOW_ASSET_ID") !== c.assetId || req("TMG_SHADOW_RIGHTS_PROFILE_ID") !== c.rightsProfileId || Number(req("TMG_SHADOW_RIGHTS_REVISION")) !== c.rightsRevision) throw new Error("Dispatch identity does not match canonical R2 evidence");
  return { manifest, rights, c };
}

async function preflight() {
  const { c } = controls(process.env.TMG_SHADOW_ACTION ?? "evaluate");
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `TMG_SHADOW_MEDIA_OBJECT_KEY=${c.mediaObjectKey}\nTMG_SHADOW_EXPECTED_SHA256=${c.mediaSha256}\nTMG_SHADOW_EXPECTED_BYTES=${c.mediaBytes}\n`);
  console.log(JSON.stringify({ status: "preflight_passed", ...c }));
}

async function createAsset(media, manifest) {
  const f = new FormData(); f.set("method", "direct"); f.set("enable_hls", "false"); f.set("enable_thumbnail", "false");
  f.set("user_metadata", JSON.stringify({ tmg_purpose: "development_shadow_evaluation", tmg_asset_id: manifest.assetId, tmg_tenant_id: manifest.tenantId, publication_state: "review" }));
  f.set("file", new Blob([media], { type: "video/mp4" }), `${manifest.assetId}.mp4`);
  const { b } = await tl("/assets", { method: "POST", body: f }); if (!b?._id) throw new Error("TwelveLabs asset ID missing"); return b._id;
}
async function ready(id) { const end = Date.now() + 180000; while (Date.now() < end) { const { b } = await tl(`/assets/${encodeURIComponent(id)}`); if (b?.status === "ready") return b; if (b?.status === "failed") throw new Error(`TwelveLabs asset failed: ${b?.error?.message ?? "unspecified"}`); await sleep(3000); } throw new Error("TwelveLabs asset readiness timeout"); }
async function embed(id) { const { b } = await tl("/embed-v2", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input_type: "video", model_name: MODEL, video: { media_source: { asset_id: id }, embedding_option: ["visual", "audio", "transcription"], embedding_scope: ["asset"], embedding_type: ["fused_embedding"] } }) }); const x = b?.data?.filter?.((i) => i?.embedding_option === "fused" && i?.embedding_scope === "asset") ?? []; if (x.length !== 1) throw new Error(`Expected one fused embedding; got ${x.length}`); return x[0].embedding; }
async function deleteAsset(id) { const { r } = await tl(`/assets/${encodeURIComponent(id)}?force=true`, { method: "DELETE" }); if (r.status !== 204) throw new Error("Provider delete failed"); const check = await tl(`/assets/${encodeURIComponent(id)}`, {}, true); if (check.r.status !== 404) throw new Error("Provider asset still exists after delete"); }
async function present(id) { const x = await cf("/get_by_ids", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) }); return Array.isArray(x) && x.some((v) => v?.id === id); }
async function waitPresent(id, want) { const end = Date.now() + 90000; while (Date.now() < end) { if ((await present(id)) === want) return; await sleep(2500); } throw new Error(`Vector presence did not become ${want}`); }
async function upsert(r) { const x = await cf("/upsert", { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: JSON.stringify(r) + "\n" }); if (!x?.mutationId) throw new Error("Vectorize upsert mutationId missing"); return x.mutationId; }
async function remove(id) { const x = await cf("/delete_by_ids", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) }); if (!x?.mutationId) throw new Error("Vectorize delete mutationId missing"); return x.mutationId; }

async function evaluate() {
  const { manifest, rights, c } = controls("evaluate"); const media = fs.readFileSync(req("TMG_SHADOW_MEDIA_PATH"));
  if (media.length !== manifest.media.bytes || digest(media) !== manifest.media.sha256) throw new Error("Rehydrated R2 media integrity mismatch");
  let assetId; let provider; let cleaned = false; let record; let mutationId;
  try { assetId = await createAsset(media, manifest); provider = await ready(assetId); record = buildShadowVectorRecord({ manifest, rights, vector: await embed(assetId), acceptanceEvidenceId: c.acceptanceEvidenceId }); mutationId = await upsert(record); await waitPresent(record.id, true); }
  finally { if (assetId) { try { await deleteAsset(assetId); cleaned = true; } catch (e) { console.error(`Provider cleanup failed: ${e?.message ?? e}`); } } }
  if (!record || !mutationId || !cleaned) throw new Error("Shadow evaluation failed closed before complete evidence/cleanup");
  const receipt = { schemaVersion: "1.0.0", status: "indexed_shadow", authority: "development_shadow_only", tenantId: manifest.tenantId, assetId: manifest.assetId, rightsProfileId: rights.rightsProfileId, rightsRevision: rights.revision, embeddingProfileId: PROFILE, compatibilityGroup: GROUP, vectorId: record.id, vectorizeIndex: req("TMG_MARENGO_SHADOW_INDEX"), upsertMutationId: mutationId, sourceSha256: manifest.media.sha256, acceptanceEvidenceId: c.acceptanceEvidenceId, evaluatedAt: new Date().toISOString() };
  write(req("TMG_SHADOW_RECEIPT_PATH"), receipt); write(req("TMG_SHADOW_EVENT_PATH"), { ...receipt, eventType: "marengo_shadow_evaluation", provider: { id: PROVIDER, model: MODEL, assetReady: provider?.status === "ready", assetDeleted: cleaned, dimensions: DIMS }, effectiveShadowPublicationState: "review", effectiveShadowGrants: { externalApi: false, mcp: false, advertising: false, datasetExport: false, licensing: false } });
  console.log(JSON.stringify({ status: "evaluated", vectorId: record.id, mutationId }));
}

async function revoke() {
  const { manifest, rights, c } = controls("revoke"); const receipt = read(req("TMG_SHADOW_RECEIPT_PATH"));
  if (receipt?.tenantId !== manifest.tenantId || receipt?.assetId !== manifest.assetId || receipt?.rightsProfileId !== rights.rightsProfileId || receipt?.embeddingProfileId !== PROFILE || receipt?.compatibilityGroup !== GROUP || receipt?.authority !== "development_shadow_only" || receipt?.acceptanceEvidenceId !== c.acceptanceEvidenceId) throw new Error("Shadow receipt does not match canonical control/acceptance evidence");
  const deleteMutationId = await remove(receipt.vectorId); await waitPresent(receipt.vectorId, false); const revokedAt = new Date().toISOString();
  write(req("TMG_SHADOW_RECEIPT_PATH"), { ...receipt, status: "revoked_shadow", deleteMutationId, revokedAt });
  write(req("TMG_SHADOW_EVENT_PATH"), { schemaVersion: "1.0.0", eventType: "marengo_shadow_revocation", status: "revoked_shadow", authority: "development_shadow_only", tenantId: manifest.tenantId, assetId: manifest.assetId, rightsProfileId: rights.rightsProfileId, rightsRevision: rights.revision, embeddingProfileId: PROFILE, compatibilityGroup: GROUP, vectorId: receipt.vectorId, deleteMutationId, sourceSha256: manifest.media.sha256, acceptanceEvidenceId: c.acceptanceEvidenceId, revokedAt });
  console.log(JSON.stringify({ status: "revoked", vectorId: receipt.vectorId, deleteMutationId }));
}

async function main() { const c = process.argv[2]; if (c === "preflight") return preflight(); if (c === "evaluate") return evaluate(); if (c === "revoke") return revoke(); throw new Error("Expected preflight | evaluate | revoke"); }
if ((process.argv[1] ? pathToFileURL(process.argv[1]).href : null) === import.meta.url) main().catch((e) => { console.error(e?.stack ?? String(e)); process.exit(1); });
