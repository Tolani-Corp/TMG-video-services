import crypto from "node:crypto";
import fs from "node:fs";

const failures = [];
const fingerprintPath = "config/production-infrastructure-fingerprint.json";
const checksumPath = "config/production-infrastructure-fingerprint.sha256";
const policyPath = "config/production-release-policy.json";
const frozenSha = "feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c";
const sourceCommitSha = "6dbd16c2fc9a9fc1fda1db9a9a6640c640de2bd6";
const reconciliationRunId = "32592457936";
const readinessRunId = "32592545975";

const fail = (message) => failures.push(message);
const readJson = (path) => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    return {};
  }
};

let fingerprintRaw = "";
let checksumRaw = "";
try {
  fingerprintRaw = fs.readFileSync(fingerprintPath, "utf8");
} catch (error) {
  fail(`${fingerprintPath}: ${error instanceof Error ? error.message : "read error"}`);
}
try {
  checksumRaw = fs.readFileSync(checksumPath, "utf8");
} catch (error) {
  fail(`${checksumPath}: ${error instanceof Error ? error.message : "read error"}`);
}

const fingerprint = readJson(fingerprintPath);
const policy = readJson(policyPath);
const actualSha = crypto.createHash("sha256").update(fingerprintRaw).digest("hex");
if (actualSha !== frozenSha) fail(`fingerprint SHA-256 drifted: ${actualSha}`);
if (checksumRaw.trim() !== `${frozenSha}  production-infrastructure-fingerprint.json`) {
  fail("fingerprint checksum file does not bind the frozen SHA-256");
}

if (fingerprint.schemaVersion !== "1.0.0") fail("fingerprint schemaVersion must be 1.0.0");
if (fingerprint.targetEnvironment !== "production") fail("fingerprint targetEnvironment must be production");
if (fingerprint.cloudflareAccountId !== "d20586cf099d39fcbeb5db4043e20f6f") fail("fingerprint Cloudflare account mismatch");
if (fingerprint.sourceCommitSha !== sourceCommitSha) fail("fingerprint source commit mismatch");

const resources = fingerprint.resources ?? {};
if (resources.r2?.name !== "tmg-video-assets-prod") fail("fingerprint R2 name mismatch");
if (resources.vectorize?.name !== "tmg-video-segments-512-prod") fail("fingerprint Vectorize name mismatch");
if (resources.vectorize?.dimensions !== 512) fail("fingerprint Vectorize dimensions must be 512");
if (resources.vectorize?.metric !== "cosine") fail("fingerprint Vectorize metric must be cosine");

const expectedIndexes = [
  ["advertising", "boolean"],
  ["datasetExport", "boolean"],
  ["externalApi", "boolean"],
  ["licensing", "boolean"],
  ["mcp", "boolean"],
  ["publicationState", "string"],
  ["rightsVerified", "boolean"],
  ["tenantId", "string"],
].map(([propertyName, indexType]) => ({ propertyName, indexType }));
if (JSON.stringify(resources.vectorize?.metadataIndexes ?? []) !== JSON.stringify(expectedIndexes)) {
  fail("fingerprint metadata index set/order/type mismatch");
}

const worker = resources.worker ?? {};
if (worker.name !== "tmg-video-services-production") fail("fingerprint Worker name mismatch");
if (worker.compatibilityDate !== "2026-08-20") fail("fingerprint Worker compatibility date mismatch");
const expectedBindings = [
  {
    name: "INGEST_WORKFLOW",
    type: "workflow",
    class_name: "IngestionWorkflow",
    workflow_name: "tmg-video-ingestion-prod",
  },
  { name: "MEDIA_BUCKET", type: "r2_bucket", bucket_name: "tmg-video-assets-prod" },
  {
    name: "REVOKE_WORKFLOW",
    type: "workflow",
    class_name: "RevocationWorkflow",
    workflow_name: "tmg-video-revocation-prod",
  },
  {
    name: "TENANT_USAGE_LEDGER",
    type: "durable_object_namespace",
    namespace_id: "737c0b2361c2407ba3c765bcb269504f",
    class_name: "TenantUsageLedger",
  },
  { name: "VIDEO_INDEX", type: "vectorize", index_name: "tmg-video-segments-512-prod" },
];
if (JSON.stringify(worker.bindings ?? []) !== JSON.stringify(expectedBindings)) {
  fail("fingerprint Worker binding contract mismatch");
}

const expectedRuntimeFlags = {
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
if (JSON.stringify(worker.runtimeFlags ?? {}) !== JSON.stringify(expectedRuntimeFlags)) {
  fail("fingerprint Worker runtime flags are not the frozen disabled envelope");
}

const expectedWorkflows = [
  { name: "tmg-video-ingestion-prod", className: "IngestionWorkflow" },
  { name: "tmg-video-revocation-prod", className: "RevocationWorkflow" },
];
if (JSON.stringify(resources.workflows ?? []) !== JSON.stringify(expectedWorkflows)) {
  fail("fingerprint Workflow contract mismatch");
}

const durable = resources.durableObjectNamespace ?? {};
if (durable.id !== "737c0b2361c2407ba3c765bcb269504f") fail("fingerprint Durable Object namespace id mismatch");
if (durable.className !== "TenantUsageLedger") fail("fingerprint Durable Object class mismatch");
if (durable.script !== "tmg-video-services-production") fail("fingerprint Durable Object script mismatch");
if (durable.useSqlite !== true) fail("fingerprint TenantUsageLedger must remain SQLite-backed");

for (const [authority, value] of Object.entries(fingerprint.authorities ?? {})) {
  if (value !== false) fail(`fingerprint authority ${authority} must remain false`);
}
for (const authority of [
  "activation",
  "publicTraffic",
  "externalProviderEgress",
  "ingestionExecution",
  "mcp",
  "billing",
  "commercialUse",
]) {
  if (fingerprint.authorities?.[authority] !== false) fail(`fingerprint authority ${authority} is missing or not false`);
}

if (policy.activationAllowed !== false || policy.publicTrafficAllowed !== false) {
  fail("production release policy activation/public traffic must remain disabled");
}
if (policy.providerAuthority?.defaultProviderId !== "fixture") fail("fixture must remain the default provider");
if (policy.providerAuthority?.marengoAuthority !== "shadow_only") fail("Marengo must remain shadow-only");
for (const key of ["externalProviderEgressAllowed", "authoritativePromotionAllowed", "commercialUseAllowed"]) {
  if (policy.providerAuthority?.[key] !== false) fail(`providerAuthority.${key} must remain false`);
}
for (const [key, expected] of Object.entries({
  TMG_PUBLIC_API_ENABLED: "false",
  TMG_MCP_ENABLED: "false",
  TMG_INGEST_WORKFLOW_ENABLED: "false",
  TMG_TENANT_USAGE_LEDGER_ENABLED: "false",
  TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false",
  TMG_PROVIDER_ACCEPTANCE_STATE: "unverified",
})) {
  if (policy.runtimeFlags?.[key] !== expected) fail(`release policy runtime flag ${key} mismatch`);
}
for (const [gate, definition] of Object.entries(policy.requiredGates ?? {})) {
  if (definition?.required !== true) fail(`required gate ${gate} must remain required`);
  if (definition?.satisfied !== false) fail(`required gate ${gate} must remain fail-closed`);
}
if (policy.requiredGates?.tenantUsageLedgerAcceptance?.satisfied !== false) {
  fail("tenantUsageLedgerAcceptance must remain unsatisfied until the separate runtime-acceptance increment");
}
if (policy.requiredGates?.explicitReleaseApproval?.satisfied !== false) {
  fail("explicitReleaseApproval must remain unsatisfied");
}

const reconciliation = policy.evidenceBindings?.productionInfrastructureReconciliation ?? {};
if (reconciliation.status !== "verified") fail("reconciliation evidence status must be verified");
if (reconciliation.runId !== reconciliationRunId) fail("reconciliation run binding mismatch");
if (reconciliation.commitSha !== sourceCommitSha) fail("reconciliation commit binding mismatch");
if (reconciliation.fingerprintSha256 !== frozenSha) fail("reconciliation fingerprint binding mismatch");
for (const key of ["mutationAuthority", "activationAuthority", "publicTrafficAuthority"]) {
  if (reconciliation[key] !== false) fail(`reconciliation ${key} must remain false`);
}

const readiness = policy.evidenceBindings?.productionReadinessAudit ?? {};
if (readiness.status !== "verified") fail("readiness evidence status must be verified");
if (readiness.runId !== readinessRunId) fail("readiness run binding mismatch");
if (readiness.commitSha !== sourceCommitSha) fail("readiness commit binding mismatch");
for (const key of ["whoami", "r2", "vectorize", "ingestionWorkflow", "revocationWorkflow", "deployDryRun"]) {
  if (readiness[key] !== "pass") fail(`readiness ${key} must be pass`);
}
if (readiness.mutationAuthority !== false || readiness.activationAuthority !== false) {
  fail("readiness evidence must not grant mutation/activation authority");
}

const frozen = policy.evidenceBindings?.productionInfrastructureFingerprint ?? {};
if (frozen.status !== "frozen") fail("production infrastructure fingerprint must be marked frozen");
if (frozen.file !== fingerprintPath || frozen.checksumFile !== checksumPath) fail("frozen fingerprint file binding mismatch");
if (frozen.sha256 !== frozenSha) fail("frozen fingerprint SHA binding mismatch");
if (frozen.sourceCommitSha !== sourceCommitSha) fail("frozen fingerprint source commit mismatch");
if (frozen.reconciliationRunId !== reconciliationRunId) fail("frozen reconciliation run mismatch");
if (frozen.readinessRunId !== readinessRunId) fail("frozen readiness run mismatch");

if (failures.length > 0) {
  console.error("production-fingerprint-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`production-fingerprint-policy:check passed sha256=${actualSha}`);
