import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MIN_MS = 4000;
const MAX_MS = 30000;
const MAX_SEGMENTS = 64;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const OUT_ROOT = process.env.TMG_SEGMENT_OUTPUT_DIR ?? "/tmp/tmg-temporal-segments";
const INDEX_PATH = process.env.TMG_SEGMENT_INDEX_PATH ?? `${OUT_ROOT}/index.json`;

const req = (name) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const id = (prefix, material) => `${prefix}_${sha(material).slice(0, 40)}`;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${String(result.status)}): ${(result.stderr ?? result.stdout ?? result.error?.message ?? "").slice(-3000)}`);
  }
  return result.stdout ?? "";
}

export function validateCurrentPointer(pointer, rights) {
  if (pointer?.schemaVersion !== "1.0.0") throw new Error("Current rights pointer schema unsupported");
  if (pointer.tenantId !== rights.tenantId || pointer.assetId !== rights.assetId || pointer.rightsProfileId !== rights.rightsProfileId) throw new Error("Current rights pointer identity mismatch");
  if (pointer.currentRevision !== rights.revision) throw new Error("Dispatched rights revision is not current");
  if (pointer.evidenceState !== rights.evidenceState) throw new Error("Current rights pointer state mismatch");
  return true;
}

export function validateMaterializationControl({ manifest, rights, current, segments, nowIso }) {
  if (manifest?.schemaVersion !== "1.0.0" || rights?.schemaVersion !== "1.0.0") throw new Error("Unsupported canonical control schema");
  if (manifest.assetId !== rights.assetId || manifest.tenantId !== rights.tenantId || manifest.rightsProfileId !== rights.rightsProfileId) throw new Error("Manifest/rights binding mismatch");
  validateCurrentPointer(current, rights);
  if (rights.evidenceState !== "verified" || rights.revokedAt) throw new Error("Materialization requires current verified rights");
  if (rights.expiresAt && Date.parse(rights.expiresAt) <= Date.parse(nowIso)) throw new Error("Materialization rights expired");
  if (rights.allowedTenantIds?.length && !rights.allowedTenantIds.includes(manifest.tenantId)) throw new Error("Tenant not allowed by rights evidence");
  if (!rights.sourceEvidenceRef) throw new Error("Canonical source-evidence reference required");
  if (manifest.publicationState === "blocked") throw new Error("Blocked source assets cannot be materialized");
  if (!Number.isInteger(manifest.media?.bytes) || manifest.media.bytes <= 0 || manifest.media.bytes > MAX_SOURCE_BYTES) throw new Error("Source media byte evidence outside materialization cap");
  if (!Number.isInteger(manifest.media?.durationMs) || manifest.media.durationMs < MIN_MS) throw new Error("Source media duration invalid");
  if (!/^[a-f0-9]{64}$/.test(manifest.media?.sha256 ?? "")) throw new Error("Invalid source SHA-256 evidence");
  if (!manifest.media?.objectKey?.startsWith(`tenants/${manifest.tenantId}/assets/${manifest.assetId}/`)) throw new Error("Source media object key escapes canonical asset prefix");
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > MAX_SEGMENTS) throw new Error(`Segment plan must contain 1-${MAX_SEGMENTS} entries`);
  let previousEnd = -1;
  const seen = new Set();
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(segment?.segmentId ?? "")) throw new Error("Invalid segmentId");
    if (seen.has(segment.segmentId)) throw new Error(`Duplicate segmentId ${segment.segmentId}`);
    seen.add(segment.segmentId);
    if (!Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs) || segment.startMs < 0 || segment.endMs <= segment.startMs) throw new Error(`Invalid window for ${segment.segmentId}`);
    const duration = segment.endMs - segment.startMs;
    if (duration < MIN_MS || duration > MAX_MS) throw new Error(`Segment ${segment.segmentId} must be 4-30 seconds`);
    if (segment.endMs > manifest.media.durationMs) throw new Error(`Segment ${segment.segmentId} exceeds source duration`);
    if (segment.startMs < previousEnd) throw new Error(`Segment ${segment.segmentId} overlaps prior segment`);
    previousEnd = segment.endMs;
  }
  return true;
}

export function buildDerivedControl({ manifest, rights, segment, childMedia, runId, createdAt }) {
  const material = `${manifest.tenantId}|${manifest.assetId}|${manifest.media.sha256}|${segment.segmentId}|${segment.startMs}|${segment.endMs}`;
  const childAssetId = id("ts", material);
  const childRightsProfileId = id("tsr", `${rights.rightsProfileId}|${rights.revision}|${childAssetId}`);
  const childRoot = `tenants/${manifest.tenantId}/assets/${childAssetId}`;
  const mediaObjectKey = `${childRoot}/media/segment.mp4`;
  const manifestKey = `${childRoot}/control/manifest-v1.json`;
  const rightsKey = `${childRoot}/control/rights/${childRightsProfileId}/r1.json`;
  const currentRightsKey = `${childRoot}/control/rights/${childRightsProfileId}/current.json`;
  const derivationKey = `${childRoot}/control/derivation/temporal-segment-v1.json`;
  const derivedManifest = {
    schemaVersion: "1.0.0", assetId: childAssetId, tenantId: manifest.tenantId, ingestRunId: `segment_${runId}`,
    source: { sourceClass: manifest.source.sourceClass, authorityRef: manifest.source.authorityRef, sourceRef: `derived:r2://${manifest.media.objectKey}#${segment.startMs}-${segment.endMs}` },
    media: { objectKey: mediaObjectKey, sha256: childMedia.sha256, bytes: childMedia.bytes, mimeType: "video/mp4", durationMs: childMedia.durationMs },
    rightsProfileId: childRightsProfileId, publicationState: "review", receivedAt: createdAt,
  };
  const derivedRights = {
    schemaVersion: "1.0.0", rightsProfileId: childRightsProfileId, assetId: childAssetId, tenantId: manifest.tenantId,
    evidenceState: "verified", sourceEvidenceRef: rights.sourceEvidenceRef,
    allowedTerritories: rights.allowedTerritories ?? [], allowedTenantIds: rights.allowedTenantIds ?? [], grants: rights.grants,
    revision: 1, updatedAt: createdAt,
    ...(rights.expiresAt ? { expiresAt: rights.expiresAt } : {}),
  };
  const currentRights = {
    schemaVersion: "1.0.0", tenantId: manifest.tenantId, assetId: childAssetId, rightsProfileId: childRightsProfileId,
    currentRevision: 1, evidenceState: "verified", updatedAt: createdAt, revisionKey: rightsKey,
  };
  const derivation = {
    schemaVersion: "1.0.0", authority: "development_materialization_only", publicationAuthority: false,
    tenantId: manifest.tenantId, childAssetId, childRightsProfileId, segmentId: segment.segmentId, startMs: segment.startMs, endMs: segment.endMs,
    parent: { assetId: manifest.assetId, mediaObjectKey: manifest.media.objectKey, mediaSha256: manifest.media.sha256, rightsProfileId: rights.rightsProfileId, rightsRevision: rights.revision },
    child: { mediaObjectKey, mediaSha256: childMedia.sha256, mediaBytes: childMedia.bytes, durationMs: childMedia.durationMs },
    materializer: { version: "temporal-segment-v1", runId }, createdAt,
  };
  return { childAssetId, childRightsProfileId, childRoot, mediaObjectKey, manifestKey, rightsKey, currentRightsKey, derivationKey, derivedManifest, derivedRights, currentRights, derivation };
}

function parseSegments() {
  const raw = process.env.TMG_SEGMENT_PLAN_JSON ?? req("TMG_SEGMENT_PLAN_PATH");
  return raw.trim().startsWith("[") ? JSON.parse(raw) : read(raw);
}

function controls() {
  const manifest = read(req("TMG_SEGMENT_PARENT_MANIFEST_PATH"));
  const rights = read(req("TMG_SEGMENT_PARENT_RIGHTS_PATH"));
  const current = read(req("TMG_SEGMENT_PARENT_CURRENT_RIGHTS_PATH"));
  const segments = parseSegments();
  validateMaterializationControl({ manifest, rights, current, segments, nowIso: new Date().toISOString() });
  if (req("TMG_SEGMENT_TENANT_ID") !== manifest.tenantId || req("TMG_SEGMENT_PARENT_ASSET_ID") !== manifest.assetId || req("TMG_SEGMENT_RIGHTS_PROFILE_ID") !== rights.rightsProfileId || Number(req("TMG_SEGMENT_RIGHTS_REVISION")) !== rights.revision) throw new Error("Dispatch identity does not match current canonical rights");
  return { manifest, rights, current, segments };
}

function preflight() {
  const { manifest, segments } = controls();
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `TMG_SEGMENT_SOURCE_OBJECT_KEY=${manifest.media.objectKey}\nTMG_SEGMENT_SOURCE_SHA256=${manifest.media.sha256}\nTMG_SEGMENT_SOURCE_BYTES=${manifest.media.bytes}\nTMG_SEGMENT_COUNT=${segments.length}\n`);
  console.log(JSON.stringify({ status: "preflight_passed", assetId: manifest.assetId, segments: segments.length, sourceBytes: manifest.media.bytes }));
}

function materialize() {
  const { manifest, rights, segments } = controls();
  const sourcePath = req("TMG_SEGMENT_SOURCE_MEDIA_PATH");
  const source = fs.readFileSync(sourcePath);
  if (source.byteLength !== manifest.media.bytes || sha(source) !== manifest.media.sha256) throw new Error("Source R2 media integrity mismatch");
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", sourcePath]));
  const sourceDurationMs = Math.round(Number(probe?.format?.duration ?? 0) * 1000);
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs + 500 < manifest.media.durationMs) throw new Error("ffprobe duration contradicts canonical manifest");
  if (!probe?.streams?.some((s) => s.codec_type === "video")) throw new Error("Source has no video stream");
  const hasAudio = probe.streams.some((s) => s.codec_type === "audio");
  fs.rmSync(OUT_ROOT, { recursive: true, force: true }); fs.mkdirSync(OUT_ROOT, { recursive: true });
  const createdAt = new Date().toISOString(); const runId = process.env.GITHUB_RUN_ID ?? `local_${Date.now()}`; const children = [];
  for (const segment of segments) {
    const segmentDir = path.join(OUT_ROOT, segment.segmentId); fs.mkdirSync(segmentDir, { recursive: true }); const mediaPath = path.join(segmentDir, "segment.mp4");
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-ss", (segment.startMs / 1000).toFixed(3), "-i", sourcePath, "-t", ((segment.endMs - segment.startMs) / 1000).toFixed(3), "-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0"] : []), "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "23", "-g", "50", ...(hasAudio ? ["-c:a", "aac", "-b:a", "96k", "-ac", "1", "-ar", "48000"] : []), "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", mediaPath];
    run("ffmpeg", args);
    const childProbe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels", "-of", "json", mediaPath]));
    const media = fs.readFileSync(mediaPath); const durationMs = Math.round(Number(childProbe?.format?.duration ?? 0) * 1000);
    if (durationMs < MIN_MS || durationMs > MAX_MS) throw new Error(`Materialized ${segment.segmentId} duration outside 4-30 second bound: ${durationMs}`);
    const childMedia = { sha256: sha(media), bytes: media.byteLength, durationMs };
    const control = buildDerivedControl({ manifest, rights, segment, childMedia, runId, createdAt });
    const files = { media: mediaPath, manifest: path.join(segmentDir, "manifest.json"), rights: path.join(segmentDir, "rights.json"), currentRights: path.join(segmentDir, "current-rights.json"), derivation: path.join(segmentDir, "derivation.json"), receipt: path.join(segmentDir, "shadow-receipt.json"), event: path.join(segmentDir, "shadow-event.json") };
    write(files.manifest, control.derivedManifest); write(files.rights, control.derivedRights); write(files.currentRights, control.currentRights); write(files.derivation, control.derivation);
    children.push({ segmentId: segment.segmentId, startMs: segment.startMs, endMs: segment.endMs, ...control, files });
  }
  const planId = id("tsp", `${manifest.tenantId}|${manifest.assetId}|${manifest.media.sha256}|${JSON.stringify(segments)}`);
  const index = { schemaVersion: "1.0.0", authority: "development_materialization_only", publicationAuthority: false, planId, tenantId: manifest.tenantId, parentAssetId: manifest.assetId, parentRightsProfileId: rights.rightsProfileId, parentRightsRevision: rights.revision, parentMediaSha256: manifest.media.sha256, createdAt, children: children.map((c) => ({ segmentId: c.segmentId, startMs: c.startMs, endMs: c.endMs, childAssetId: c.childAssetId, childRightsProfileId: c.childRightsProfileId, childRoot: c.childRoot, mediaObjectKey: c.mediaObjectKey, manifestKey: c.manifestKey, rightsKey: c.rightsKey, currentRightsKey: c.currentRightsKey, derivationKey: c.derivationKey, sourceSha256: c.derivedManifest.media.sha256, sourceBytes: c.derivedManifest.media.bytes, durationMs: c.derivedManifest.media.durationMs, files: c.files })) };
  write(INDEX_PATH, index);
  console.log(JSON.stringify({ status: "materialized", planId, children: index.children.length, indexPath: INDEX_PATH }));
}

async function main() { const command = process.argv[2]; if (command === "preflight") return preflight(); if (command === "materialize") return materialize(); throw new Error("Expected preflight | materialize"); }
if ((process.argv[1] ? pathToFileURL(process.argv[1]).href : null) === import.meta.url) Promise.resolve(main()).catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });
