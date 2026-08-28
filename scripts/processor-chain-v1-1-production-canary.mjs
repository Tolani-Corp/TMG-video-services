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
const runId = process.env.GITHUB_RUN_ID || Date.now().toString();
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "local";
const now = new Date();
const date = now.toISOString().slice(0, 10).replaceAll("-", "");
const requestId = `wr_${date}_${randomUUID()}`;
const fileId = `file_${randomUUID()}`;
const reviewId = `review_${randomUUID()}`;
const chainId = `pc_${randomUUID()}`;
const instanceId = `chain-${runId}-${runAttempt}-${randomUUID()}`.slice(0, 96);
const requestToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
const tokenHash = createHash("sha256").update(requestToken).digest("hex");
const objectKey = `quarantine/${requestId}/files/${fileId}`;
const manifestKey = `requests/${requestId}/manifest.json`;
const root = mkdtempSync(join(tmpdir(), "tmg-processor-chain-v1-1-"));
const fixturePath = join(root, "processor-chain-fixture.mp4");
const manifestPath = join(root, "manifest.json");
const readbackPath = join(root, "readback.json");
const fixture = Buffer.from("AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOybW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAt10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABaAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAIAAABAAAAAAJVbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACAG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAcBzdGJsAAAAwHN0c2QAAAAAAAAAAQAAALBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAKAAWgBIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANmF2Y0MBZAAK/+EAGWdkAAqs2UKN+TARAAADAAEAAAMAFA8SJZYBAAZo6+PLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAbmAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAoAAAQAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAABgY3R0cwAAAAAAAAAKAAAAAQAACAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAACAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAoAAAABAAAAPHN0c3oAAAAAAAAAAAAAAAoAAAkrAAABvwAAAD0AAAAXAAAAGQAAAYgAAABTAAAAGwAAABsAAABkAAAAFHN0Y28AAAAAAAAAAQAAA+IAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAzAAAACGZyZWUAAA3UbWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMiBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0zIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0xMCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAABnVliIQAEf/+94gfMstvmCsfGVuCcQA4xJm6RyG0k5oqRdM/esR6ywOBzmjGTfQwaZKxVUCQhTWLZaQ3MkRx/5TVwoeXYx/WFSPE7BwNr2R2z8GcvijkQ4yxg2lszO2Hy8WX6zzm56bkj0+pCfllLeBi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", "base64");
const fixtureSha = createHash("sha256").update(fixture).digest("hex");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function evidenceBindingsHash(files) {
  return sha256Json(files.map(({ fileId, sha256, size }) => ({ fileId, sha256, size })).sort((a, b) => a.fileId.localeCompare(b.fileId)));
}

function run(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], { encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`wrangler ${args.join(" ")} failed with exit ${result.status}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function writeManifest(manifest) {
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(expected, attempts = 80) {
  let manifest = null;
  for (let i = 0; i < attempts; i += 1) {
    await sleep(2500);
    manifest = getManifest();
    const state = manifest.workflow?.processorChain?.state;
    if (state === expected) return manifest;
    if (state === "failed" || manifest.status === "failed") {
      throw new Error(`Processor chain failed before ${expected}: ${JSON.stringify(manifest.workflow?.processorChain || manifest.workflow?.outcome || {})}`);
    }
  }
  throw new Error(`Timed out waiting for ${expected}; last=${manifest?.workflow?.processorChain?.state}`);
}

async function cleanup(manifest) {
  const derivativeKeys = manifest?.workflow?.processorChain?.derivativeReceipt?.outputs?.map((item) => item.key) || [];
  for (const [bucket, key] of [[requestBucket, objectKey], [requestBucket, manifestKey], ...derivativeKeys.map((key) => [derivativeBucket, key])]) {
    try { run(["r2", "object", "delete", `${bucket}/${key}`, "--remote"]); } catch (error) { console.warn(`cleanup warning ${bucket}/${key}: ${error.message}`); }
  }
  rmSync(root, { recursive: true, force: true });
}

writeFileSync(fixturePath, fixture);
assert(fixture.byteLength === 4526, `Unexpected fixture size ${fixture.byteLength}`);
assert(fixtureSha === "9992d2f0fce158d577197d9d7c9375ed0f1aece035644f78bdb4119255506105", "Synthetic fixture SHA mismatch");

const manifest = {
  schema: "tmg.work-request.v1",
  requestId,
  status: "action_required",
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  requester: { name: "TMG Processor Chain Canary", email: "processor-chain-canary@tolanimediagroup.com", organization: "Tolani Media Group" },
  request: {
    serviceType: "media-processing",
    title: "Processor Chain v1.1 production acceptance",
    description: "Harmless synthetic MP4 fixture for governed FFmpeg/container execution acceptance.",
    desiredOutcome: "Prove deep technical inspection, human rights verdict continuation, private derivative generation, and preserved publication/provider gates.",
    targetDate: null,
  },
  rights: { authorizedToShare: true, humanReviewAcknowledged: true },
  controls: { processingAuthorized: true, publicationAuthorized: false, externalProviderEgressAuthorized: false },
  tokenHash,
  files: [{ fileId, name: "synthetic-canary.mp4", size: fixture.byteLength, type: "video/mp4", sha256: fixtureSha, status: "uploaded", objectKey, uploadedAt: now.toISOString() }],
  review: { state: "approved", reviewId, reviewerEmail: "processor-chain-canary@tolanimediagroup.com", note: "Automated production acceptance; private processing only.", at: now.toISOString() },
  workflow: {
    instanceId: `preflight-${instanceId}`,
    dispatchState: "checkpoint",
    phase: "action_required",
    progress: 94,
    processorId: "media-inspection",
    processorState: "local_adapter_complete",
    events: [{ id: `evt_${randomUUID()}`, at: now.toISOString(), phase: "processing", state: "complete", title: "Synthetic preliminary media inspection complete", detail: "Production canary seeded with a valid preliminary processor receipt." }],
    processorResults: {
      "media-inspection": { schema: "tmg.processor-result.v1", processorId: "media-inspection", adapter: "media-inspection-v1", executedAt: now.toISOString(), status: "action_required", confidence: "system_verified", details: { syntheticCanary: true } },
    },
    processorChain: {
      schema: "tmg.processor-chain.v1.1",
      chainId,
      instanceId,
      state: "requested",
      sourceFileId: fileId,
      startedBy: "processor-chain-canary@tolanimediagroup.com",
      startedAt: now.toISOString(),
    },
  },
};

let finalManifest = manifest;
let succeeded = false;
try {
  run(["r2", "object", "put", `${requestBucket}/${objectKey}`, "--file", fixturePath, "--content-type", "video/mp4", "--remote"]);
  writeManifest(manifest);

  const params = JSON.stringify({ requestId, reviewId, chainId, chainInstanceId: instanceId, startedBy: "processor-chain-canary@tolanimediagroup.com" });
  const trigger = run(["workflows", "trigger", workflow, params, "--id", instanceId, "--config", config]);
  assert(/queued successfully|created|triggered/i.test(trigger), "Processor Chain Workflow trigger did not report success.");

  let current = await waitForState("waiting_technical_authority");
  assert(current.workflow?.progress === 95, "Chain did not hold at 95% before deep technical authority.");
  assert(current.controls.publicationAuthorized === false && current.controls.externalProviderEgressAuthorized === false, "Authority widened before technical inspection.");

  const grantedAt = new Date().toISOString();
  const technicalAuthority = {
    schema: "tmg.processor-authority.v1",
    authorityId: `pa_${randomUUID()}`,
    processorId: "technical-inspection",
    state: "authorized",
    requestId,
    serviceType: "media-processing",
    reviewId,
    workflowInstanceId: instanceId,
    grantedBy: "processor-chain-canary@tolanimediagroup.com",
    grantedAt,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    localExecutionOnly: true,
    publicationAuthorized: false,
    externalProviderEgressAuthorized: false,
    allowedActions: ["read_bound_media", "run_ffprobe", "decode_media", "record_technical_receipt"],
    evidenceBindings: [{ fileId, sha256: fixtureSha, size: fixture.byteLength }],
    note: "Production canary authorizes exact local ffprobe/full decode only.",
  };
  current.workflow.processorChain.technicalAuthority = technicalAuthority;
  current.processorAuthorizations = { ...(current.processorAuthorizations || {}), "technical-inspection": technicalAuthority };
  writeManifest(current);
  sendEvent("technical-authorized", { authorityId: technicalAuthority.authorityId, requestId, reviewId });

  current = await waitForState("waiting_rights_verdict");
  const technical = current.workflow?.processorChain?.technicalReceipt;
  assert(technical?.schema === "tmg.technical-inspection-receipt.v1", "Technical receipt missing.");
  assert(technical.probeSucceeded === true && technical.decodeSucceeded === true && technical.decodeExitCode === 0, "ffprobe/full decode did not pass.");
  assert(Array.isArray(technical.streams) && technical.streams.some((stream) => stream.type === "video" && stream.codec === "h264" && stream.width === 160 && stream.height === 90), "Expected H.264 160x90 video stream not found.");
  assert(Number(technical.format?.durationSeconds) > 0.9 && Number(technical.format?.durationSeconds) < 1.1, `Unexpected duration ${technical.format?.durationSeconds}`);
  assert(Array.isArray(technical.corruptionSignals) && technical.corruptionSignals.length === 0, `Unexpected corruption signals: ${technical.corruptionSignals}`);
  assert(current.workflow?.progress === 97, "Chain did not hold at 97% for human rights verdict.");

  const rightsBase = {
    schema: "tmg.rights-sufficiency-verdict.v1",
    verdictId: `rv_${randomUUID()}`,
    requestId,
    reviewId,
    chainInstanceId: instanceId,
    state: "sufficient",
    permittedUses: ["frame_extraction", "transcode", "derivative_generation"],
    permittedTerritories: ["US"],
    technicalReceiptSha256: technical.receiptSha256,
    evidenceBindingsSha256: evidenceBindingsHash(current.files),
    decidedBy: "processor-chain-canary@tolanimediagroup.com",
    decidedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    note: "Automated production canary human-verdict surrogate for synthetic Tolani-owned fixture only; private derivative generation permitted.",
  };
  const rightsVerdict = { ...rightsBase, receiptSha256: sha256Json(rightsBase) };
  current.workflow.processorChain.rightsVerdict = rightsVerdict;
  writeManifest(current);
  sendEvent("rights-verdict-recorded", { verdictId: rightsVerdict.verdictId, requestId, reviewId });

  current = await waitForState("waiting_derivative_authority");
  assert(current.workflow?.progress === 98, "Chain did not hold at 98% before derivative authority.");

  const derivativeAuthority = {
    schema: "tmg.derivative-authority.v1",
    authorityId: `da_${randomUUID()}`,
    requestId,
    reviewId,
    chainInstanceId: instanceId,
    state: "authorized",
    recipeId: "preview-pack-v1",
    allowedActions: ["decode_video", "run_ffmpeg", "extract_frames", "transcode", "generate_derivative"],
    sourceFileId: fileId,
    sourceSha256: fixtureSha,
    technicalReceiptSha256: technical.receiptSha256,
    rightsVerdictSha256: rightsVerdict.receiptSha256,
    outputPrefix: `derived/${requestId}/${chainId}/preview-pack-v1`,
    publicationAuthorized: false,
    externalProviderEgressAuthorized: false,
    grantedBy: "processor-chain-canary@tolanimediagroup.com",
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    note: "Production canary authorizes exact private preview-pack recipe only.",
  };
  current.workflow.processorChain.derivativeAuthority = derivativeAuthority;
  writeManifest(current);
  sendEvent("derivative-authorized", { authorityId: derivativeAuthority.authorityId, requestId, reviewId });

  finalManifest = await waitForState("derivative_complete", 120);
  const chain = finalManifest.workflow?.processorChain;
  const receipt = chain?.derivativeReceipt;
  assert(finalManifest.workflow?.progress === 99, "Processor Chain did not advance to 99% after exact derivative authority.");
  assert(receipt?.schema === "tmg.derivative-receipt.v1" && receipt.recipeId === "preview-pack-v1", "Derivative receipt missing or wrong recipe.");
  assert(Array.isArray(receipt.outputs) && receipt.outputs.length === 5, `Expected 5 preview-pack outputs, got ${receipt.outputs?.length}`);
  const expectedNames = new Set(["poster.jpg", "frame-1.jpg", "frame-2.jpg", "frame-3.jpg", "web-720p.mp4"]);
  for (const output of receipt.outputs) {
    assert(expectedNames.has(output.key.split("/").pop()), `Unexpected derivative ${output.key}`);
    assert(/^[a-f0-9]{64}$/.test(output.sha256) && output.size > 0, `Invalid output integrity metadata ${output.key}`);
    run(["r2", "object", "get", `${derivativeBucket}/${output.key}`, "--file", join(root, `output-${randomUUID()}`), "--remote"]);
  }
  assert(finalManifest.controls.publicationAuthorized === false, "Derivative chain unexpectedly granted publication authority.");
  assert(finalManifest.controls.externalProviderEgressAuthorized === false, "Derivative chain unexpectedly granted provider egress authority.");

  const publishedList = run(["r2", "object", "list", publishedBucket, "--prefix", `published/${requestId}/`, "--remote", "--json"]);
  const published = JSON.parse(publishedList || "[]");
  assert(Array.isArray(published) && published.length === 0, "Production canary unexpectedly published a derivative.");

  const response = await fetch(`https://tolanimediagroup.com/work-requests/${encodeURIComponent(requestId)}/status`, {
    headers: { accept: "application/json", "x-work-request-token": requestToken },
  });
  const customer = await response.json().catch(() => ({}));
  assert(response.ok && customer.schema === "tmg.work-request-processing-status.v1", `Customer status projection failed: HTTP ${response.status}`);
  assert(customer.lifecycle?.progress === 99 && customer.lifecycle?.phase === "action_required", "Customer live view did not reflect the private derivative checkpoint.");
  assert(customer.context?.controls?.publicationAuthorized === false && customer.context?.controls?.externalProviderEgressAuthorized === false, "Customer view authority widened unexpectedly.");
  const titles = new Set((customer.events || []).map((event) => event.title));
  for (const title of ["FFmpeg technical inspection started", "Deep technical inspection completed", "Human rights sufficiency verdict required", "Authorized derivative recipe started", "FFmpeg derivative recipe completed", "Publication and provider egress remain separately gated"]) {
    assert(titles.has(title), `Customer live view missing event: ${title}`);
  }
  const serializedCustomer = JSON.stringify(customer);
  assert(!serializedCustomer.includes(requestToken) && !serializedCustomer.includes(tokenHash), "Customer live view leaked token material.");
  assert(!serializedCustomer.includes(objectKey) && !serializedCustomer.includes("derived/"), "Customer live view leaked private object paths.");
  assert(!serializedCustomer.includes(technicalAuthority.authorityId) && !serializedCustomer.includes(derivativeAuthority.authorityId), "Customer live view leaked authority identifiers.");

  console.log(JSON.stringify({
    ok: true,
    schema: "tmg.processor-chain-v1.1-production-canary.v1",
    requestId,
    instanceId,
    fixture: { sha256: fixtureSha, size: fixture.byteLength },
    technical: {
      durationSeconds: technical.format.durationSeconds,
      streams: technical.streams.map((stream) => ({ type: stream.type, codec: stream.codec, width: stream.width ?? null, height: stream.height ?? null })),
      decodeSucceeded: technical.decodeSucceeded,
      corruptionSignals: technical.corruptionSignals.length,
    },
    rights: { state: rightsVerdict.state, permittedUses: rightsVerdict.permittedUses, permittedTerritories: rightsVerdict.permittedTerritories },
    derivative: { recipeId: receipt.recipeId, outputs: receipt.outputs.map((output) => ({ name: output.key.split("/").pop(), size: output.size, sha256: output.sha256 })) },
    customerProgress: customer.lifecycle.progress,
    publicationAuthorized: finalManifest.controls.publicationAuthorized,
    externalProviderEgressAuthorized: finalManifest.controls.externalProviderEgressAuthorized,
  }, null, 2));
  succeeded = true;
} finally {
  await cleanup(finalManifest);
  if (!succeeded) console.error("Processor Chain v1.1 canary failed; temporary request and derivative evidence cleanup attempted.");
}
