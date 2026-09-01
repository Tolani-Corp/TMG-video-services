import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const requestBucket = "tmg-work-requests-prod";
const derivativeBucket = "tmg-work-derivatives-prod";
const publishedBucket = "tmg-published-media-prod";
const workflow = "tmg-processor-chain-v1-1-prod";
const config = "wrangler.review.jsonc";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const runId = process.env.GITHUB_RUN_ID || Date.now().toString();
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "local";
const now = new Date();
const requestId = `wr_${now.toISOString().slice(0, 10).replaceAll("-", "")}_${randomUUID()}`;
const fileId = `file_${randomUUID()}`;
const reviewId = `review_${randomUUID()}`;
const chainId = `pc_${randomUUID()}`;
const instanceId = `chain-${runId}-${runAttempt}-${randomUUID()}`.slice(0, 96);
const requestToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
const tokenHash = createHash("sha256").update(requestToken).digest("hex");
const objectKey = `quarantine/${requestId}/files/${fileId}`;
const manifestKey = `requests/${requestId}/manifest.json`;
const root = mkdtempSync(join(tmpdir(), "tmg-chain-v1-1-"));
const fixturePath = join(root, "fixture.mp4");
const manifestPath = join(root, "manifest.json");
const readbackPath = join(root, "readback.json");
const fixture = Buffer.from(readFileSync("fixtures/processor-chain-canary.mp4.b64", "utf8").trim(), "base64");
const fixtureSha = createHash("sha256").update(fixture).digest("hex");

function assert(value, message) { if (!value) throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function sha256Json(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function evidenceHash(files) { return sha256Json(files.map(({ fileId: id, sha256, size }) => ({ fileId: id, sha256, size })).sort((a, b) => a.fileId.localeCompare(b.fileId))); }
function run(args, allowFailure = false) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], { encoding: "utf8", env: process.env });
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(result.stdout || ""); process.stderr.write(result.stderr || "");
    throw new Error(`wrangler ${args.join(" ")} failed with exit ${result.status}`);
  }
  return { status: result.status ?? -1, output: `${result.stdout || ""}${result.stderr || ""}` };
}
function putManifest(manifest) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run(["r2", "object", "put", `${requestBucket}/${manifestKey}`, "--file", manifestPath, "--content-type", "application/json", "--remote"]);
}
function getManifest() {
  run(["r2", "object", "get", `${requestBucket}/${manifestKey}`, "--file", readbackPath, "--remote"]);
  return JSON.parse(readFileSync(readbackPath, "utf8"));
}
function sendEvent(type, payload) {
  run(["workflows", "instances", "send-event", workflow, instanceId, "--type", type, "--payload", JSON.stringify(payload), "--config", config]);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForState(expected, attempts = 100) {
  let manifest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(2500);
    manifest = getManifest();
    const state = manifest.workflow?.processorChain?.state;
    if (state === expected) return manifest;
    if (state === "failed" || manifest.status === "failed") throw new Error(`Processor chain failed before ${expected}: ${JSON.stringify(manifest.workflow?.processorChain || {})}`);
  }
  throw new Error(`Timed out waiting for ${expected}; last=${manifest?.workflow?.processorChain?.state}`);
}
async function listObjects(bucket, prefix) {
  assert(accountId && apiToken, "Cloudflare API credentials are required for R2 publication isolation check.");
  const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`);
  url.searchParams.set("prefix", prefix);
  url.searchParams.set("per_page", "100");
  const response = await fetch(url, { headers: { authorization: `Bearer ${apiToken}`, accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  assert(response.ok && body.success !== false, `R2 list failed for ${bucket}: HTTP ${response.status}`);
  if (Array.isArray(body.result)) return body.result;
  if (Array.isArray(body.result?.objects)) return body.result.objects;
  return [];
}
async function cleanup(manifest) {
  const keys = manifest?.workflow?.processorChain?.derivativeReceipt?.outputs?.map((item) => item.key) || [];
  for (const [bucket, key] of [[requestBucket, objectKey], [requestBucket, manifestKey], ...keys.map((key) => [derivativeBucket, key])]) run(["r2", "object", "delete", `${bucket}/${key}`, "--remote"], true);
  rmSync(root, { recursive: true, force: true });
}

writeFileSync(fixturePath, fixture);
assert(fixture.byteLength === 4526, `Unexpected fixture size ${fixture.byteLength}`);
assert(fixtureSha === "9992d2f0fce158d577197d9d7c9375ed0f1aece035644f78bdb4119255506105", "Synthetic fixture SHA mismatch");

const seed = {
  schema: "tmg.work-request.v1", requestId, status: "action_required", createdAt: now.toISOString(), updatedAt: now.toISOString(),
  requester: { name: "TMG Processor Chain Canary", email: "processor-chain-canary@tolanimediagroup.com", organization: "Tolani Media Group" },
  request: { serviceType: "media-processing", title: "Processor Chain v1.1 production acceptance", description: "Harmless synthetic H.264 fixture.", desiredOutcome: "Prove governed deep inspection and private derivatives.", targetDate: null },
  rights: { authorizedToShare: true, humanReviewAcknowledged: true },
  controls: { processingAuthorized: true, publicationAuthorized: false, externalProviderEgressAuthorized: false }, tokenHash,
  files: [{ fileId, name: "synthetic-canary.mp4", size: fixture.byteLength, type: "video/mp4", sha256: fixtureSha, status: "uploaded", objectKey, uploadedAt: now.toISOString() }],
  review: { state: "approved", reviewId, reviewerEmail: "processor-chain-canary@tolanimediagroup.com", note: "Synthetic Tolani-controlled production acceptance; private processing only.", at: now.toISOString() },
  workflow: {
    instanceId: `preflight-${instanceId}`, dispatchState: "checkpoint", phase: "action_required", progress: 94, processorId: "media-inspection", processorState: "local_adapter_complete",
    events: [{ id: `evt_${randomUUID()}`, at: now.toISOString(), phase: "processing", state: "complete", title: "Synthetic preliminary media inspection complete", detail: "Valid preliminary processor receipt seeded for deterministic production acceptance." }],
    processorResults: { "media-inspection": { schema: "tmg.processor-result.v1", processorId: "media-inspection", adapter: "media-inspection-v1", executedAt: now.toISOString(), status: "action_required", confidence: "system_verified", details: { syntheticCanary: true } } },
    processorChain: { schema: "tmg.processor-chain.v1.1", chainId, instanceId, state: "requested", sourceFileId: fileId, startedBy: "processor-chain-canary@tolanimediagroup.com", startedAt: now.toISOString() },
  },
};

let current = seed;
let succeeded = false;
try {
  run(["r2", "object", "put", `${requestBucket}/${objectKey}`, "--file", fixturePath, "--content-type", "video/mp4", "--remote"]);
  putManifest(seed);
  const params = JSON.stringify({ requestId, reviewId, chainId, chainInstanceId: instanceId, startedBy: "processor-chain-canary@tolanimediagroup.com" });
  assert(/queued successfully|created|triggered/i.test(run(["workflows", "trigger", workflow, params, "--id", instanceId, "--config", config]).output), "Processor Chain trigger did not report success.");

  current = await waitForState("waiting_technical_authority");
  assert(current.workflow?.progress === 95, "Chain did not hold before deep technical authority.");
  const grantedAt = new Date().toISOString();
  const technicalAuthority = {
    schema: "tmg.processor-authority.v1", authorityId: `pa_${randomUUID()}`, processorId: "technical-inspection", state: "authorized", requestId, serviceType: "media-processing", reviewId, workflowInstanceId: instanceId,
    grantedBy: "processor-chain-canary@tolanimediagroup.com", grantedAt, expiresAt: new Date(Date.now() + 3600000).toISOString(), localExecutionOnly: true, publicationAuthorized: false, externalProviderEgressAuthorized: false,
    allowedActions: ["read_bound_media", "run_ffprobe", "decode_media", "record_technical_receipt"], evidenceBindings: [{ fileId, sha256: fixtureSha, size: fixture.byteLength }], note: "Exact production canary deep-inspection authority.",
  };
  current.workflow.processorChain.technicalAuthority = technicalAuthority;
  current.processorAuthorizations = { ...(current.processorAuthorizations || {}), "technical-inspection": technicalAuthority };
  putManifest(current);
  sendEvent("technical-authorized", { authorityId: technicalAuthority.authorityId, requestId, reviewId });

  current = await waitForState("waiting_rights_verdict", 120);
  const technical = current.workflow?.processorChain?.technicalReceipt;
  assert(technical?.schema === "tmg.technical-inspection-receipt.v1" && technical.probeSucceeded === true && technical.decodeSucceeded === true && technical.decodeExitCode === 0, "Deep ffprobe/full decode receipt did not pass.");
  assert(technical.streams?.some((stream) => stream.type === "video" && stream.codec === "h264" && stream.width === 160 && stream.height === 90), "Expected H.264 160x90 stream missing.");
  assert(Number(technical.format?.durationSeconds) > 0.9 && Number(technical.format?.durationSeconds) < 1.1, `Unexpected duration ${technical.format?.durationSeconds}`);
  assert(Array.isArray(technical.corruptionSignals) && technical.corruptionSignals.length === 0, "Synthetic fixture reported corruption.");
  assert(current.workflow?.progress === 97, "Chain did not hold for human rights verdict.");

  const rightsBase = {
    schema: "tmg.rights-sufficiency-verdict.v1", verdictId: `rv_${randomUUID()}`, requestId, reviewId, chainInstanceId: instanceId, state: "sufficient",
    permittedUses: ["frame_extraction", "transcode", "derivative_generation"], permittedTerritories: ["US"], technicalReceiptSha256: technical.receiptSha256, evidenceBindingsSha256: evidenceHash(current.files),
    decidedBy: "processor-chain-canary@tolanimediagroup.com", decidedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), note: "Synthetic Tolani-controlled fixture is sufficient for private derivative acceptance only.",
  };
  const rightsVerdict = { ...rightsBase, receiptSha256: sha256Json(rightsBase) };
  current.workflow.processorChain.rightsVerdict = rightsVerdict;
  putManifest(current);
  sendEvent("rights-verdict-recorded", { verdictId: rightsVerdict.verdictId, requestId, reviewId });

  current = await waitForState("waiting_derivative_authority");
  assert(current.workflow?.progress === 98, "Chain did not hold before exact derivative recipe authority.");
  const derivativeAuthority = {
    schema: "tmg.derivative-authority.v1", authorityId: `da_${randomUUID()}`, requestId, reviewId, chainInstanceId: instanceId, state: "authorized", recipeId: "preview-pack-v1",
    allowedActions: ["decode_video", "run_ffmpeg", "extract_frames", "transcode", "generate_derivative"], sourceFileId: fileId, sourceSha256: fixtureSha,
    technicalReceiptSha256: technical.receiptSha256, rightsVerdictSha256: rightsVerdict.receiptSha256, outputPrefix: `derived/${requestId}/${chainId}/preview-pack-v1`, publicationAuthorized: false, externalProviderEgressAuthorized: false,
    grantedBy: "processor-chain-canary@tolanimediagroup.com", grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), note: "Exact private preview-pack production canary authority.",
  };
  current.workflow.processorChain.derivativeAuthority = derivativeAuthority;
  putManifest(current);
  sendEvent("derivative-authorized", { authorityId: derivativeAuthority.authorityId, requestId, reviewId });

  current = await waitForState("derivative_complete", 140);
  const receipt = current.workflow?.processorChain?.derivativeReceipt;
  assert(current.workflow?.progress === 99 && receipt?.schema === "tmg.derivative-receipt.v1" && receipt.recipeId === "preview-pack-v1", "Derivative chain did not reach the private-complete checkpoint.");
  const expected = new Set(["poster.jpg", "frame-1.jpg", "frame-2.jpg", "frame-3.jpg", "web-720p.mp4"]);
  assert(receipt.outputs?.length === 5, `Expected five preview-pack outputs, got ${receipt.outputs?.length}`);
  for (const output of receipt.outputs) {
    assert(expected.has(output.key.split("/").pop()) && /^[a-f0-9]{64}$/.test(output.sha256) && output.size > 0, `Invalid derivative output receipt: ${output.key}`);
    run(["r2", "object", "get", `${derivativeBucket}/${output.key}`, "--file", join(root, `verify-${randomUUID()}`), "--remote"]);
  }
  assert(current.controls.publicationAuthorized === false && current.controls.externalProviderEgressAuthorized === false, "Derivative execution widened request authority.");
  assert((await listObjects(publishedBucket, `published/${requestId}/`)).length === 0, "Processor Chain unexpectedly published an object.");

  const statusResponse = await fetch(`https://tolanimediagroup.com/work-requests/${encodeURIComponent(requestId)}/status`, { headers: { accept: "application/json", "x-work-request-token": requestToken } });
  const customer = await statusResponse.json().catch(() => ({}));
  assert(statusResponse.ok && customer.schema === "tmg.work-request-processing-status.v1", `Customer live status failed: HTTP ${statusResponse.status}`);
  assert(customer.lifecycle?.progress === 99 && customer.lifecycle?.phase === "action_required", "Customer live view does not reflect private derivative completion.");
  assert(customer.context?.controls?.publicationAuthorized === false && customer.context?.controls?.externalProviderEgressAuthorized === false, "Customer authority view widened unexpectedly.");
  const titles = new Set((customer.events || []).map((event) => event.title));
  for (const title of ["FFmpeg technical inspection started", "Deep technical inspection completed", "Human rights sufficiency verdict required", "Authorized derivative recipe started", "FFmpeg derivative recipe completed", "Publication and provider egress remain separately gated"]) assert(titles.has(title), `Customer live view missing event: ${title}`);
  const serialized = JSON.stringify(customer);
  assert(!serialized.includes(requestToken) && !serialized.includes(tokenHash) && !serialized.includes(objectKey) && !serialized.includes("derived/"), "Customer live view leaked private token/object data.");
  assert(!serialized.includes(technicalAuthority.authorityId) && !serialized.includes(derivativeAuthority.authorityId), "Customer live view leaked authority identifiers.");

  console.log(JSON.stringify({
    ok: true, schema: "tmg.processor-chain-v1.1-production-canary.v1", requestId, instanceId,
    technical: { durationSeconds: technical.format.durationSeconds, streams: technical.streams.map((stream) => ({ type: stream.type, codec: stream.codec, width: stream.width ?? null, height: stream.height ?? null })), decodeSucceeded: technical.decodeSucceeded, corruptionSignals: technical.corruptionSignals.length },
    rights: { state: rightsVerdict.state, permittedUses: rightsVerdict.permittedUses, permittedTerritories: rightsVerdict.permittedTerritories },
    derivative: { recipeId: receipt.recipeId, outputs: receipt.outputs.map((output) => ({ name: output.key.split("/").pop(), size: output.size, sha256: output.sha256 })) },
    customerProgress: customer.lifecycle.progress, publicationAuthorized: current.controls.publicationAuthorized, externalProviderEgressAuthorized: current.controls.externalProviderEgressAuthorized,
  }, null, 2));
  succeeded = true;
} finally {
  await cleanup(current);
  if (!succeeded) console.error("Processor Chain v1.1 acceptance failed; temporary R2 request/derivative cleanup attempted.");
}
