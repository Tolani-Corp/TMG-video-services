import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TENANT = "tmg_fixture";
const PARENT_ASSET = "harmless_temporal_parent_001";
const RIGHTS = "harmless_temporal_parent_rights_v1";
const PARENT_MEDIA = "/tmp/tmg-temporal-parent.mp4";
const PARENT_MANIFEST = process.env.TMG_SEGMENT_PARENT_MANIFEST_PATH ?? "/tmp/tmg-temporal-parent-manifest.json";
const PARENT_RIGHTS = process.env.TMG_SEGMENT_PARENT_RIGHTS_PATH ?? "/tmp/tmg-temporal-parent-rights.json";
const PARENT_CURRENT = process.env.TMG_SEGMENT_PARENT_CURRENT_RIGHTS_PATH ?? "/tmp/tmg-temporal-parent-current-rights.json";
const SEGMENT_INDEX = process.env.TMG_SEGMENT_INDEX_PATH ?? "/tmp/tmg-temporal-segments/index.json";
const EVIDENCE = process.env.TMG_TEMPORAL_ACCEPT_EVIDENCE_OUT ?? "temporal-segment-acceptance.json";
const PRESERVATION = process.env.TMG_TEMPORAL_ACCEPT_PRESERVATION ?? "/tmp/tmg-temporal-preservation.json";
const PROFILE = "twelvelabs_marengo3_fused_512_v1";

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const req = (name) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${(result.stderr ?? result.stdout ?? result.error?.message ?? "").slice(-3000)}`);
  return result.stdout ?? "";
}

function appendEnv(values) {
  if (!process.env.GITHUB_ENV) return;
  fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function generate() {
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=360x360:r=25:d=45", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=45", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "23", "-g", "50", "-c:a", "aac", "-b:a", "96k", "-ac", "1", "-ar", "48000", "-movflags", "+faststart", "-shortest", PARENT_MEDIA]);
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels", "-of", "json", PARENT_MEDIA]));
  const media = fs.readFileSync(PARENT_MEDIA);
  const digest = sha(media);
  const durationMs = Math.round(Number(probe?.format?.duration ?? 0) * 1000);
  const video = probe?.streams?.find((s) => s.codec_type === "video");
  const audio = probe?.streams?.find((s) => s.codec_type === "audio");
  if (durationMs < 44_500 || durationMs > 45_500 || video?.codec_name !== "h264" || video?.width !== 360 || video?.height !== 360 || audio?.codec_name !== "aac") throw new Error("Synthetic parent media contract mismatch");
  const root = `tenants/${TENANT}/assets/${PARENT_ASSET}`;
  const mediaObjectKey = `${root}/media/original.mp4`;
  const rightsKey = `${root}/control/rights/${RIGHTS}/r1.json`;
  const createdAt = new Date().toISOString();
  const manifest = { schemaVersion: "1.0.0", assetId: PARENT_ASSET, tenantId: TENANT, ingestRunId: `temporal_accept_${process.env.GITHUB_RUN_ID ?? "local"}`, source: { sourceClass: "fixture", authorityRef: "fixture:synthetic-temporal-acceptance" }, media: { objectKey: mediaObjectKey, sha256: digest, bytes: media.byteLength, mimeType: "video/mp4", durationMs }, rightsProfileId: RIGHTS, publicationState: "review", receivedAt: createdAt };
  const rights = { schemaVersion: "1.0.0", rightsProfileId: RIGHTS, assetId: PARENT_ASSET, tenantId: TENANT, evidenceState: "verified", sourceEvidenceRef: "fixture:synthetic-temporal-acceptance:no-third-party-content", allowedTerritories: ["US", "CA"], allowedTenantIds: [TENANT], grants: { externalApi: false, mcp: false, advertising: false, datasetExport: false, licensing: false }, revision: 1, updatedAt: createdAt };
  const current = { schemaVersion: "1.0.0", tenantId: TENANT, assetId: PARENT_ASSET, rightsProfileId: RIGHTS, currentRevision: 1, evidenceState: "verified", updatedAt: createdAt, revisionKey: rightsKey };
  write(PARENT_MANIFEST, manifest); write(PARENT_RIGHTS, rights); write(PARENT_CURRENT, current);
  appendEnv({ TMG_TEMPORAL_PARENT_SHA256: digest, TMG_TEMPORAL_PARENT_BYTES: media.byteLength, TMG_TEMPORAL_PARENT_DURATION_MS: durationMs, TMG_SEGMENT_SOURCE_OBJECT_KEY: mediaObjectKey, TMG_SEGMENT_SOURCE_SHA256: digest, TMG_SEGMENT_SOURCE_BYTES: media.byteLength });
  console.log(JSON.stringify({ status: "generated", sha256: digest, bytes: media.byteLength, durationMs, video: { codec: video.codec_name, width: video.width, height: video.height, fps: video.r_frame_rate }, audio: { codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels } }));
}

async function cfGetByIds(ids) {
  const account = req("CLOUDFLARE_ACCOUNT_ID"); const token = req("CLOUDFLARE_API_TOKEN"); const index = req("TMG_MARENGO_SHADOW_INDEX");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/vectorize/v2/indexes/${encodeURIComponent(index)}/get_by_ids`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ids }) });
  const body = await response.json();
  if (!response.ok || body?.success !== true) throw new Error(`Vectorize get_by_ids failed: ${response.status}`);
  return Array.isArray(body.result) ? body.result : [];
}

function childPath(child, name) { return path.join(path.dirname(child.files.manifest), name); }

async function verifyEvaluated() {
  const index = read(SEGMENT_INDEX);
  if (index.children?.length !== 3) throw new Error(`Expected exactly 3 child segments; got ${index.children?.length ?? 0}`);
  const vectorIds = [];
  const children = [];
  for (const child of index.children) {
    const receipt = read(childPath(child, "evaluation-receipt.json"));
    const event = read(childPath(child, "evaluation-event.json"));
    if (receipt.status !== "indexed_shadow" || receipt.authority !== "development_shadow_only" || receipt.embeddingProfileId !== PROFILE) throw new Error(`Invalid shadow receipt for ${child.childAssetId}`);
    if (event?.provider?.assetDeleted !== true || event?.provider?.assetReady !== true || event?.provider?.dimensions !== 512) throw new Error(`Provider cleanup/evidence incomplete for ${child.childAssetId}`);
    if (event.effectiveShadowPublicationState !== "review" || Object.values(event.effectiveShadowGrants ?? {}).some((v) => v !== false)) throw new Error(`Shadow authority expanded for ${child.childAssetId}`);
    vectorIds.push(receipt.vectorId);
    children.push({ childAssetId: child.childAssetId, segmentId: child.segmentId, startMs: child.startMs, endMs: child.endMs, mediaSha256: child.sourceSha256, mediaBytes: child.sourceBytes, durationMs: child.durationMs, vectorId: receipt.vectorId, upsertMutationId: receipt.upsertMutationId, providerAssetDeleted: true });
  }
  if (new Set(vectorIds).size !== 3) throw new Error("Expected three unique vector IDs");
  const vectors = await cfGetByIds(vectorIds);
  if (vectors.length !== 3) throw new Error(`Expected 3 live shadow vectors; got ${vectors.length}`);
  for (const vector of vectors) {
    const m = vector.metadata ?? {};
    if (m.rightsVerified !== true || m.publicationState !== "review") throw new Error("Live shadow vector is not verified/review-only");
    for (const key of ["externalApi", "mcp", "advertising", "datasetExport", "licensing"]) if (m[key] !== false) throw new Error(`Live shadow vector unexpectedly grants ${key}`);
  }
  write(EVIDENCE, { schemaVersion: "1.0.0", status: "evaluated", purpose: "temporal_segment_materialization_development_acceptance", runId: process.env.GITHUB_RUN_ID ?? null, parent: { tenantId: TENANT, assetId: PARENT_ASSET, rightsProfileId: RIGHTS, sha256: req("TMG_TEMPORAL_PARENT_SHA256"), bytes: Number(req("TMG_TEMPORAL_PARENT_BYTES")), durationMs: Number(req("TMG_TEMPORAL_PARENT_DURATION_MS")), publicationState: "review" }, planId: index.planId, materialization: { childCount: 3, authority: index.authority, publicationAuthority: index.publicationAuthority }, marengo: { compatibilityGroup: "marengo3_fused_512_v1", dimensions: 512, postInsertCount: 3 }, children });
  console.log(JSON.stringify({ status: "evaluated_verified", vectors: 3, planId: index.planId }));
}

async function verifyRevoked() {
  const evidence = read(EVIDENCE); const index = read(SEGMENT_INDEX); const vectorIds = [];
  const deletions = [];
  for (const child of index.children) {
    const receipt = read(childPath(child, "revoked-receipt.json"));
    if (receipt.status !== "revoked_shadow" || !receipt.deleteMutationId) throw new Error(`Revocation evidence incomplete for ${child.childAssetId}`);
    vectorIds.push(receipt.vectorId); deletions.push({ childAssetId: child.childAssetId, vectorId: receipt.vectorId, deleteMutationId: receipt.deleteMutationId });
  }
  const remaining = await cfGetByIds(vectorIds);
  if (remaining.length !== 0) throw new Error(`Expected zero vectors after revocation; got ${remaining.length}`);
  const preservation = read(PRESERVATION);
  if (preservation.parentMediaPreserved !== true || preservation.childrenPreserved !== 3 || preservation.lineagePreserved !== 3) throw new Error("R2 preservation evidence incomplete");
  write(EVIDENCE, { ...evidence, status: "passed", marengo: { ...evidence.marengo, postDeleteCount: 0, deletionMutations: deletions }, r2: preservation, completedAt: new Date().toISOString() });
  console.log(JSON.stringify({ status: "passed", postDeleteCount: 0, preservedChildren: preservation.childrenPreserved }));
}

const command = process.argv[2];
try {
  if (command === "generate") generate();
  else if (command === "verify-evaluated") await verifyEvaluated();
  else if (command === "verify-revoked") await verifyRevoked();
  else throw new Error("Expected generate | verify-evaluated | verify-revoked");
} catch (error) { console.error(error?.stack ?? String(error)); process.exit(1); }
