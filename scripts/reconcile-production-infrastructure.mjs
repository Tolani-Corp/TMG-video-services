import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const sourceCommitSha = process.env.GITHUB_SHA;
const outDir = process.env.TMG_RECONCILIATION_OUT ?? "production-reconciliation";

const expected = {
  workerName: process.env.TMG_PROD_WORKER ?? "tmg-video-services-production",
  r2Bucket: process.env.TMG_PROD_R2_BUCKET ?? "tmg-video-assets-prod",
  vectorIndex: process.env.TMG_PROD_VECTOR_INDEX ?? "tmg-video-segments-512-prod",
  ingestionWorkflow: process.env.TMG_PROD_INGEST_WORKFLOW ?? "tmg-video-ingestion-prod",
  revocationWorkflow: process.env.TMG_PROD_REVOKE_WORKFLOW ?? "tmg-video-revocation-prod",
};

if (!accountId || !apiToken || !sourceCommitSha) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and GITHUB_SHA are required");
}

fs.mkdirSync(outDir, { recursive: true });

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(outDir, file), "utf8"));
const unwrap = (value) => value?.result ?? value;
const fail = (message) => {
  throw new Error(`production reconciliation failed: ${message}`);
};

async function cfJson(url) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: "application/json",
    },
  });
  const body = await response.json();
  if (!response.ok || body?.success !== true) {
    throw new Error(`Cloudflare read ${response.status}: ${JSON.stringify(body?.errors ?? body)}`);
  }
  return body.result;
}

const r2 = unwrap(readJson("r2.json"));
const r2Name = r2?.name ?? r2?.bucket_name ?? expected.r2Bucket;
if (r2Name !== expected.r2Bucket) fail(`R2 bucket mismatch ${String(r2Name)}`);

const vector = unwrap(readJson("vectorize.json"));
const dimensions = vector?.config?.dimensions;
const metric = vector?.config?.metric;
if (dimensions !== 512 || metric !== "cosine") {
  fail(`Vectorize contract mismatch dimensions=${String(dimensions)} metric=${String(metric)}`);
}

const metadataResult = await cfJson(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${expected.vectorIndex}/metadata_index/list`,
);
const normalizeIndexType = (value) => {
  if (["String", "string"].includes(value)) return "string";
  if (["Bool", "boolean"].includes(value)) return "boolean";
  if (["Number", "number"].includes(value)) return "number";
  return value;
};
const metadataIndexes = (metadataResult?.metadataIndexes ?? [])
  .map((item) => ({ propertyName: item.propertyName, indexType: normalizeIndexType(item.indexType) }))
  .sort((a, b) => a.propertyName.localeCompare(b.propertyName));
const expectedMetadataIndexes = [
  ["advertising", "boolean"],
  ["datasetExport", "boolean"],
  ["externalApi", "boolean"],
  ["licensing", "boolean"],
  ["mcp", "boolean"],
  ["publicationState", "string"],
  ["rightsVerified", "boolean"],
  ["tenantId", "string"],
].map(([propertyName, indexType]) => ({ propertyName, indexType }));
if (JSON.stringify(metadataIndexes) !== JSON.stringify(expectedMetadataIndexes)) {
  fail(`metadata index set mismatch ${JSON.stringify(metadataIndexes)}`);
}

const workerSettings = await cfJson(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${expected.workerName}/settings`,
);
const bindings = Array.isArray(workerSettings?.bindings) ? workerSettings.bindings : [];
const byName = new Map(bindings.map((binding) => [binding.name, binding]));
const expectBinding = (name, type, field, value) => {
  const binding = byName.get(name);
  if (!binding) fail(`Worker binding ${name} is missing`);
  if (binding.type !== type) fail(`Worker binding ${name} type=${String(binding.type)} expected=${type}`);
  if (field && binding[field] !== value) {
    fail(`Worker binding ${name} ${field}=${String(binding[field])} expected=${value}`);
  }
  return binding;
};

const mediaBinding = expectBinding("MEDIA_BUCKET", "r2_bucket", "bucket_name", expected.r2Bucket);
const vectorBinding = expectBinding("VIDEO_INDEX", "vectorize", "index_name", expected.vectorIndex);
const ledgerBinding = expectBinding("TENANT_USAGE_LEDGER", "durable_object_namespace", "class_name", "TenantUsageLedger");
const ingestBinding = expectBinding("INGEST_WORKFLOW", "workflow", "workflow_name", expected.ingestionWorkflow);
const revokeBinding = expectBinding("REVOKE_WORKFLOW", "workflow", "workflow_name", expected.revocationWorkflow);
if (ingestBinding.class_name && ingestBinding.class_name !== "IngestionWorkflow") {
  fail(`INGEST_WORKFLOW class=${String(ingestBinding.class_name)}`);
}
if (revokeBinding.class_name && revokeBinding.class_name !== "RevocationWorkflow") {
  fail(`REVOKE_WORKFLOW class=${String(revokeBinding.class_name)}`);
}

const expectedRuntime = {
  TMG_PUBLIC_API_ENABLED: "false",
  TMG_MCP_ENABLED: "false",
  TMG_INGEST_WORKFLOW_ENABLED: "false",
  TMG_INGESTION_MODE: "fixture_only",
  TMG_POLICY_VERSION: "2026-08-20.v3",
  TMG_EMBEDDING_DIMENSIONS: "512",
  TMG_EMBEDDING_PROVIDER_ID: "fixture",
  TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false",
  TMG_PROVIDER_ACCEPTANCE_STATE: "unverified",
  TMG_TENANT_USAGE_LEDGER_ENABLED: "false",
};
const runtimeFlags = {};
for (const [name, value] of Object.entries(expectedRuntime)) {
  const binding = expectBinding(name, "plain_text", "text", value);
  runtimeFlags[name] = binding.text;
}

const durableNamespaces = await cfJson(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/durable_objects/namespaces?per_page=1000`,
);
const matchingNamespaces = (durableNamespaces ?? []).filter(
  (item) => item.class === "TenantUsageLedger" && item.script === expected.workerName,
);
if (matchingNamespaces.length !== 1) {
  fail(`expected exactly one TenantUsageLedger namespace for ${expected.workerName}; found ${matchingNamespaces.length}`);
}
const durableNamespace = matchingNamespaces[0];
if (durableNamespace.use_sqlite !== true) fail("TenantUsageLedger namespace is not SQLite-backed");
if (ledgerBinding.namespace_id && durableNamespace.id && ledgerBinding.namespace_id !== durableNamespace.id) {
  fail(`TenantUsageLedger namespace id mismatch worker=${ledgerBinding.namespace_id} account=${durableNamespace.id}`);
}

const normalizeBinding = (binding) => {
  const result = { name: binding.name, type: binding.type };
  for (const key of [
    "bucket_name",
    "index_name",
    "namespace_id",
    "class_name",
    "workflow_name",
    "script_name",
  ]) {
    if (binding[key] !== undefined) result[key] = binding[key];
  }
  return result;
};

const infrastructureFingerprint = {
  schemaVersion: "1.0.0",
  targetEnvironment: "production",
  cloudflareAccountId: accountId,
  sourceCommitSha,
  resources: {
    r2: {
      name: expected.r2Bucket,
      jurisdiction: r2?.jurisdiction ?? null,
      storageClass: r2?.storage_class ?? r2?.storageClass ?? null,
    },
    vectorize: {
      name: expected.vectorIndex,
      id: vector?.id ?? null,
      dimensions,
      metric,
      metadataIndexes,
    },
    worker: {
      name: expected.workerName,
      compatibilityDate: workerSettings?.compatibility_date ?? null,
      mainModule: workerSettings?.main_module ?? null,
      bindings: [mediaBinding, vectorBinding, ledgerBinding, ingestBinding, revokeBinding]
        .map(normalizeBinding)
        .sort((a, b) => a.name.localeCompare(b.name)),
      runtimeFlags,
    },
    workflows: [
      { name: expected.ingestionWorkflow, className: "IngestionWorkflow" },
      { name: expected.revocationWorkflow, className: "RevocationWorkflow" },
    ],
    durableObjectNamespace: {
      id: durableNamespace.id ?? null,
      name: durableNamespace.name ?? null,
      className: durableNamespace.class ?? "TenantUsageLedger",
      script: durableNamespace.script ?? expected.workerName,
      useSqlite: durableNamespace.use_sqlite === true,
    },
  },
  authorities: {
    activation: false,
    publicTraffic: false,
    externalProviderEgress: false,
    ingestionExecution: false,
    mcp: false,
    billing: false,
    commercialUse: false,
  },
};

const canonical = `${JSON.stringify(infrastructureFingerprint, null, 2)}\n`;
const digest = crypto.createHash("sha256").update(canonical).digest("hex");
fs.writeFileSync(path.join(outDir, "infrastructure-fingerprint.json"), canonical);
fs.writeFileSync(path.join(outDir, "infrastructure-fingerprint.sha256"), `${digest}  infrastructure-fingerprint.json\n`);
fs.writeFileSync(
  path.join(outDir, "reconciliation-summary.json"),
  `${JSON.stringify({
    schemaVersion: "1.0.0",
    targetEnvironment: "production",
    sourceCommitSha,
    fingerprintSha256: digest,
    r2Verified: true,
    vectorizeVerified: true,
    metadataIndexesVerified: true,
    workerBindingsVerified: true,
    workflowsVerified: true,
    durableObjectNamespaceVerified: true,
    mutationAuthority: false,
    activationAuthority: false,
  }, null, 2)}\n`,
);

console.log(`production infrastructure reconciliation passed fingerprint=${digest}`);
