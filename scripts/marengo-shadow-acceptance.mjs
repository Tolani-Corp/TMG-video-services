import crypto from "node:crypto";
import fs from "node:fs";

const TWELVELABS_BASE = "https://api.twelvelabs.io/v1.3";
const EXPECTED_DIMENSIONS = 512;
const TENANT_ID = "tmg_fixture";
const ASSET_ID = "harmless_marengo_shadow_fixture_001";
const RIGHTS_PROFILE_ID = "harmless_marengo_shadow_rights_v1";
const EMBEDDING_PROFILE_ID = "twelvelabs_marengo3_fused_512_v1";
const COMPATIBILITY_GROUP = "marengo3_fused_512_v1";
const STATE_PATH = process.env.TMG_MARENGO_ACCEPT_STATE_OUT ?? "marengo-shadow-state.json";
const VECTOR_PATH = process.env.TMG_MARENGO_ACCEPT_VECTOR_OUT ?? "marengo-vector.ndjson";
const EVIDENCE_PATH =
  process.env.TMG_MARENGO_ACCEPT_EVIDENCE_OUT ?? "marengo-shadow-acceptance.json";
const MEDIA_PATH =
  process.env.TMG_MARENGO_ACCEPT_MEDIA_PATH ?? "/tmp/tmg-marengo-shadow-rehydrated.mp4";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function fixtureEvidence() {
  const sha256 = required("TMG_MARENGO_FIXTURE_SHA256");
  const bytes = Number(required("TMG_MARENGO_FIXTURE_BYTES"));
  const durationSeconds = Number(required("TMG_MARENGO_FIXTURE_DURATION_SECONDS"));
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid Marengo fixture SHA-256 evidence.");
  if (!Number.isInteger(bytes) || bytes <= 0) throw new Error("Invalid Marengo fixture byte evidence.");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 4 || durationSeconds > 30) {
    throw new Error("Invalid Marengo fixture duration evidence.");
  }
  return { sha256, bytes, durationSeconds };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function vectorId() {
  return crypto
    .createHash("sha256")
    .update(`${TENANT_ID}|${ASSET_ID}|s000|${EMBEDDING_PROFILE_ID}`)
    .digest("hex");
}

function safeBody(body) {
  if (!body || typeof body !== "object") return String(body ?? "");
  if (Array.isArray(body.errors)) {
    return body.errors.map((item) => item?.message ?? item?.code ?? "unknown").join("; ");
  }
  if (typeof body.message === "string") return body.message;
  return "unexpected provider response";
}

async function readResponse(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

async function twelveLabs(path, init = {}, { allowNotFound = false } = {}) {
  const apiKey = required("TWELVELABS_API_KEY");
  const response = await fetch(`${TWELVELABS_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      ...(init.headers ?? {}),
    },
  });
  const body = await readResponse(response);
  if (allowNotFound && response.status === 404) return { response, body };
  if (!response.ok) {
    throw new Error(`TwelveLabs HTTP ${response.status}: ${safeBody(body)}`);
  }
  return { response, body };
}

async function cloudflare(path, init = {}) {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = required("CLOUDFLARE_API_TOKEN");
  const indexName = required("TMG_MARENGO_ACCEPT_VECTOR_INDEX");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${indexName}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    },
  );
  const body = await readResponse(response);
  if (!response.ok || body?.success !== true) {
    throw new Error(`Cloudflare Vectorize HTTP ${response.status}: ${safeBody(body)}`);
  }
  return body.result;
}

function verifyFixture() {
  const expected = fixtureEvidence();
  const media = fs.readFileSync(MEDIA_PATH);
  const digest = sha256(media);
  if (digest !== expected.sha256) {
    throw new Error(`Marengo fixture SHA mismatch: expected ${expected.sha256}, got ${digest}`);
  }
  if (media.byteLength !== expected.bytes) {
    throw new Error(
      `Marengo fixture byte count mismatch: expected ${expected.bytes}, got ${media.byteLength}`,
    );
  }
  return media;
}

async function createAsset(media) {
  const form = new FormData();
  form.set("method", "direct");
  form.set("filename", "tmg-marengo-shadow-fixture.mp4");
  form.set("enable_hls", "false");
  form.set("enable_thumbnail", "false");
  form.set(
    "user_metadata",
    JSON.stringify({
      tmg_purpose: "development_shadow_acceptance",
      tmg_asset_id: ASSET_ID,
      tmg_tenant_id: TENANT_ID,
      publication_state: "review",
    }),
  );
  form.set("file", new Blob([media], { type: "video/mp4" }), "tmg-marengo-shadow-fixture.mp4");

  const { body } = await twelveLabs("/assets", { method: "POST", body: form });
  const id = body?._id;
  if (typeof id !== "string" || !id) {
    throw new Error("TwelveLabs asset creation did not return an asset ID");
  }
  return id;
}

function safeTechnicalMetadata(body) {
  const metadata = body?.technical_metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const allowed = [
    "file_size_bytes",
    "file_mime_type",
    "file_container_format",
    "video_codec",
    "video_width",
    "video_height",
    "video_fps",
    "video_duration_seconds",
    "audio_codec",
    "audio_sample_rate",
    "audio_channels",
  ];
  return Object.fromEntries(allowed.filter((key) => key in metadata).map((key) => [key, metadata[key]]));
}

function recordProviderFailure(assetId, body) {
  let state = {};
  if (fs.existsSync(STATE_PATH)) state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const message =
    typeof body?.error?.message === "string" ? body.error.message : "unspecified provider validation failure";
  const next = {
    ...state,
    providerAssetId: assetId,
    providerAssetStatus: "failed",
    providerFailure: {
      message,
      technicalMetadata: safeTechnicalMetadata(body),
      capturedAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return message;
}

async function waitForAsset(assetId) {
  const deadline = Date.now() + 180_000;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const { body } = await twelveLabs(`/assets/${encodeURIComponent(assetId)}`);
    lastStatus = body?.status ?? "unknown";
    if (lastStatus === "ready") return body;
    if (lastStatus === "failed") {
      const message = recordProviderFailure(assetId, body);
      throw new Error(`TwelveLabs asset processing failed: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`TwelveLabs asset did not become ready; last status=${lastStatus}`);
}

async function createEmbedding(assetId) {
  const { body } = await twelveLabs("/embed-v2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input_type: "video",
      model_name: "marengo3.0",
      video: {
        media_source: { asset_id: assetId },
        embedding_option: ["visual", "audio", "transcription"],
        embedding_scope: ["asset"],
        embedding_type: ["fused_embedding"],
      },
    }),
  });

  if (!Array.isArray(body?.data)) {
    throw new Error("TwelveLabs Embed API v2 did not return a data array");
  }
  const fused = body.data.filter(
    (item) => item?.embedding_option === "fused" && item?.embedding_scope === "asset",
  );
  if (fused.length !== 1) {
    throw new Error(`Expected one fused asset embedding; received ${fused.length}`);
  }
  const values = fused[0]?.embedding;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIMENSIONS) {
    throw new Error(`Expected a ${EXPECTED_DIMENSIONS}-dimensional Marengo vector`);
  }
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("Marengo embedding contains non-finite values");
  }
  return values;
}

function writeVector(values) {
  const fixture = fixtureEvidence();
  const id = vectorId();
  const record = {
    id,
    values,
    namespace: TENANT_ID,
    metadata: {
      tenantId: TENANT_ID,
      assetId: ASSET_ID,
      segmentId: "s000",
      rightsVerified: true,
      publicationState: "review",
      externalApi: false,
      mcp: false,
      advertising: false,
      datasetExport: false,
      licensing: false,
      rightsProfileId: RIGHTS_PROFILE_ID,
      embeddingProfileId: EMBEDDING_PROFILE_ID,
      compatibilityGroup: COMPATIBILITY_GROUP,
      providerId: "twelvelabs-marengo3",
      providerModel: "marengo3.0",
      fixtureSha256: fixture.sha256,
    },
  };
  fs.writeFileSync(VECTOR_PATH, `${JSON.stringify(record)}\n`);
  return record;
}

async function queryUntil(expectedCount, vector, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cloudflare("/query", {
      method: "POST",
      body: JSON.stringify({
        vector,
        topK: 5,
        returnValues: false,
        returnMetadata: "all",
        namespace: TENANT_ID,
        filter: { tenantId: TENANT_ID, rightsVerified: true },
      }),
    });
    if ((last?.count ?? last?.matches?.length ?? 0) === expectedCount) return last;
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error(`Vectorize query did not reach expected count ${expectedCount}`);
}

async function deleteVector(id) {
  const result = await cloudflare("/delete_by_ids", {
    method: "POST",
    body: JSON.stringify({ ids: [id] }),
  });
  if (typeof result?.mutationId !== "string" || !result.mutationId) {
    throw new Error("Vectorize delete_by_ids did not return a mutationId");
  }
  return result.mutationId;
}

async function deleteAsset(assetId) {
  const result = await twelveLabs(`/assets/${encodeURIComponent(assetId)}?force=true`, {
    method: "DELETE",
  });
  if (result.response.status !== 204) {
    throw new Error("TwelveLabs asset delete did not return 204");
  }
}

async function verifyAssetDeleted(assetId) {
  const { response } = await twelveLabs(
    `/assets/${encodeURIComponent(assetId)}`,
    {},
    { allowNotFound: true },
  );
  if (response.status !== 404) {
    throw new Error(`Expected deleted TwelveLabs asset to return 404; got ${response.status}`);
  }
}

async function prepare() {
  required("TWELVELABS_API_KEY");
  required("CLOUDFLARE_API_TOKEN");
  required("CLOUDFLARE_ACCOUNT_ID");
  required("TMG_MARENGO_ACCEPT_VECTOR_INDEX");
  const media = verifyFixture();
  const assetId = await createAsset(media);
  fs.writeFileSync(
    STATE_PATH,
    `${JSON.stringify(
      { providerAssetId: assetId, providerAssetDeleted: false, createdAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  );
  const asset = await waitForAsset(assetId);
  const vector = await createEmbedding(assetId);
  const record = writeVector(vector);
  fs.writeFileSync(
    STATE_PATH,
    `${JSON.stringify(
      {
        providerAssetId: assetId,
        providerAssetDeleted: false,
        providerAssetStatus: asset?.status,
        providerTechnicalMetadata: safeTechnicalMetadata(asset),
        vectorId: record.id,
        dimensions: vector.length,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Marengo shadow embedding prepared: dimensions=${vector.length} vectorId=${record.id}`);
}

async function verifyAndRevoke() {
  const fixture = fixtureEvidence();
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const record = JSON.parse(fs.readFileSync(VECTOR_PATH, "utf8").trim());
  const postInsert = await queryUntil(1, record.values);
  const match = postInsert?.matches?.[0];
  if (!match || match.id !== record.id) {
    throw new Error("Internal Marengo retrieval did not return the expected vector ID");
  }
  const metadata = match.metadata ?? {};
  if (metadata.publicationState !== "review" || metadata.rightsVerified !== true) {
    throw new Error("Retrieved Marengo vector is not review-only with verified fixture rights");
  }
  for (const grant of ["externalApi", "mcp", "advertising", "datasetExport", "licensing"]) {
    if (metadata[grant] !== false) {
      throw new Error(`Retrieved Marengo vector unexpectedly grants ${grant}`);
    }
  }

  const deleteMutationId = await deleteVector(record.id);
  const postDelete = await queryUntil(0, record.values);
  await deleteAsset(state.providerAssetId);
  await verifyAssetDeleted(state.providerAssetId);

  const evidence = {
    schemaVersion: "1.0.0",
    status: "passed",
    purpose: "marengo_development_shadow_egress_acceptance",
    tenantId: TENANT_ID,
    assetId: ASSET_ID,
    fixture: {
      sha256: fixture.sha256,
      bytes: fixture.bytes,
      durationSeconds: fixture.durationSeconds,
      publicationState: "review",
      rightsProfileId: RIGHTS_PROFILE_ID,
      grants: {
        externalApi: false,
        mcp: false,
        advertising: false,
        datasetExport: false,
        licensing: false,
      },
    },
    provider: {
      id: "twelvelabs-marengo3",
      model: "marengo3.0",
      mode: "shadow",
      assetCreated: true,
      assetReady: true,
      assetDeleted: true,
      technicalMetadata: state.providerTechnicalMetadata ?? null,
      dimensions: EXPECTED_DIMENSIONS,
      compatibilityGroup: COMPATIBILITY_GROUP,
    },
    vectorize: {
      index: required("TMG_MARENGO_ACCEPT_VECTOR_INDEX"),
      vectorId: record.id,
      postInsertCount: postInsert?.count ?? postInsert?.matches?.length ?? 0,
      deleteMutationId,
      postDeleteCount: postDelete?.count ?? postDelete?.matches?.length ?? 0,
    },
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(
    STATE_PATH,
    `${JSON.stringify(
      { ...state, providerAssetDeleted: true, deleteMutationId, completedAt: evidence.completedAt },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify(evidence));
}

async function cleanup() {
  if (!fs.existsSync(STATE_PATH)) return;
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  if (!state.providerAssetId || state.providerAssetDeleted === true) return;
  try {
    await deleteAsset(state.providerAssetId);
    state.providerAssetDeleted = true;
    state.cleanupAt = new Date().toISOString();
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
    console.log("Cleaned up TwelveLabs shadow asset.");
  } catch (error) {
    console.error(`Provider cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "verify-revoke") await verifyAndRevoke();
else if (command === "cleanup") await cleanup();
else {
  throw new Error(
    "Usage: node scripts/marengo-shadow-acceptance.mjs <prepare|verify-revoke|cleanup>",
  );
}
