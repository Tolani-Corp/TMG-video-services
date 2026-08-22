import fs from "node:fs";

const failures = [];
const readJson = (path) => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    return {};
  }
};

const productionPolicy = readJson("config/production-release-policy.json");
const packageJson = readJson("package.json");
let workflow = "";
let readinessWorkflow = "";
let reconciler = "";
try {
  workflow = fs.readFileSync(".github/workflows/production-reconciliation.yml", "utf8");
} catch (error) {
  failures.push(`production reconciliation workflow missing: ${error instanceof Error ? error.message : "read error"}`);
}
try {
  readinessWorkflow = fs.readFileSync(".github/workflows/production-readiness.yml", "utf8");
} catch (error) {
  failures.push(`production readiness workflow missing: ${error instanceof Error ? error.message : "read error"}`);
}
try {
  reconciler = fs.readFileSync("scripts/reconcile-production-infrastructure.mjs", "utf8");
} catch (error) {
  failures.push(`production reconciliation script missing: ${error instanceof Error ? error.message : "read error"}`);
}

const bootstrapGate = productionPolicy.requiredGates?.productionInfrastructureBootstrap;
const reconciliationGate = productionPolicy.requiredGates?.productionInfrastructureReconciliation;
const bootstrapEvidence = productionPolicy.evidenceBindings?.productionInfrastructureBootstrap;

if (bootstrapGate?.required !== true || bootstrapGate?.satisfied !== false) {
  failures.push("productionInfrastructureBootstrap must remain fail-closed in release policy until the reconciled fingerprint is bound");
}
if (bootstrapEvidence?.status !== "verified") failures.push("successful production bootstrap evidence must be bound");
if (bootstrapEvidence?.runId !== "32590468035") failures.push("bootstrap evidence must bind run 32590468035");
if (bootstrapEvidence?.commitSha !== "724a6ec5b9f27280a2c3527837702055e3b6d737") {
  failures.push("bootstrap evidence must bind the verified bootstrap commit");
}
if (reconciliationGate?.required !== true || reconciliationGate?.satisfied !== false) {
  failures.push("productionInfrastructureReconciliation must remain required and unsatisfied until the fingerprint is repository-bound");
}
if (productionPolicy.activationAllowed !== false || productionPolicy.publicTrafficAllowed !== false) {
  failures.push("production activation/public traffic must remain disabled during reconciliation");
}

if (!/^on:\s*\n\s{2}workflow_dispatch:/m.test(workflow)) failures.push("reconciliation must expose workflow_dispatch");
if (!/^\s{2}issue_comment:\s*$/m.test(workflow) || !workflow.includes("types: [created]")) {
  failures.push("reconciliation must support created Issue #18 authorization comments");
}
for (const trigger of ["push", "pull_request", "schedule"]) {
  if (new RegExp(`^\\s{2}${trigger}:`, "m").test(workflow)) {
    failures.push(`production reconciliation must not declare automatic trigger ${trigger}`);
  }
}
if (!workflow.includes("github.event.issue.number == 18")) failures.push("reconciliation must be restricted to Issue #18");
if (!workflow.includes("github.actor == 'TolaniCorp'")) failures.push("reconciliation must be restricted to TolaniCorp actor");
if (!workflow.includes("RECONCILE_DISABLED_PRODUCTION_INFRASTRUCTURE")) failures.push("reconciliation authorization phrase is missing");
if (!workflow.includes("environment: production")) failures.push("reconciliation must use GitHub environment production");
if (!workflow.includes('test "$GITHUB_REF" = "refs/heads/main"')) failures.push("reconciliation must execute from main");
if (!workflow.includes('test "$EXPECTED_SHA" = "$GITHUB_SHA"')) failures.push("reconciliation must bind exact main SHA");
if (!workflow.includes("check-runs?per_page=100")) failures.push("reconciliation must verify exact-head Quality");
if (!workflow.includes("git merge-base --is-ancestor")) failures.push("reconciliation must prove the bound bootstrap commit is an ancestor");
if (!workflow.includes("Production Infrastructure Bootstrap — run")) failures.push("reconciliation must verify Issue #18 bootstrap evidence");

for (const expected of [
  "tmg-video-services-production",
  "tmg-video-assets-prod",
  "tmg-video-segments-512-prod",
  "tmg-video-ingestion-prod",
  "tmg-video-revocation-prod",
  "TenantUsageLedger",
]) {
  if (!workflow.includes(expected) && !reconciler.includes(expected)) failures.push(`reconciliation missing expected resource ${expected}`);
}

if (!workflow.includes("r2 bucket info")) failures.push("reconciliation must inspect R2 read-only");
if (!workflow.includes("vectorize get")) failures.push("reconciliation must inspect Vectorize read-only");
if (!workflow.includes("workflows describe")) failures.push("reconciliation must inspect Workflows read-only");
if (!workflow.includes("wrangler deploy --env production --dry-run")) failures.push("reconciliation must dry-run the production Worker");
if (!workflow.includes("node scripts/reconcile-production-infrastructure.mjs")) failures.push("reconciliation must execute the canonical reconciler");
if (!workflow.includes("Candidate fingerprint SHA-256")) failures.push("reconciliation must publish only a candidate fingerprint before readiness replay");
if (!workflow.includes("not frozen until an independent Production Readiness replay succeeds")) {
  failures.push("reconciliation must explicitly defer fingerprint freeze until an independent readiness replay");
}
if (!readinessWorkflow.includes("RUN_READ_ONLY_PRODUCTION_READINESS")) {
  failures.push("Production Readiness must expose the separate Issue #18 authorization path used after reconciliation");
}

for (const requiredRead of [
  "/vectorize/v2/indexes/${expected.vectorIndex}/metadata_index/list",
  "/workers/scripts/${expected.workerName}/settings",
  "/workers/durable_objects/namespaces?per_page=1000",
]) {
  if (!reconciler.includes(requiredRead)) failures.push(`reconciler missing Cloudflare read path ${requiredRead}`);
}
for (const invariant of [
  "dimensions !== 512",
  'metric !== "cosine"',
  "expectedMetadataIndexes",
  '"MEDIA_BUCKET", "r2_bucket"',
  '"VIDEO_INDEX", "vectorize"',
  '"TENANT_USAGE_LEDGER", "durable_object_namespace"',
  '"INGEST_WORKFLOW", "workflow"',
  '"REVOKE_WORKFLOW", "workflow"',
  "use_sqlite !== true",
  'TMG_PUBLIC_API_ENABLED: "false"',
  'TMG_MCP_ENABLED: "false"',
  'TMG_INGEST_WORKFLOW_ENABLED: "false"',
  'TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false"',
  'TMG_TENANT_USAGE_LEDGER_ENABLED: "false"',
]) {
  if (!reconciler.includes(invariant)) failures.push(`reconciler missing fail-closed invariant: ${invariant}`);
}

for (const forbidden of [
  "r2 bucket create",
  "r2 bucket delete",
  "vectorize create",
  "vectorize delete",
  "workflows trigger",
  "workflows delete",
  "wrangler delete",
  "secret put",
  "method: \"POST\"",
  "method: \"PUT\"",
  "method: \"PATCH\"",
  "method: \"DELETE\"",
]) {
  if (workflow.includes(forbidden) || reconciler.includes(forbidden)) {
    failures.push(`production reconciliation contains forbidden mutation: ${forbidden}`);
  }
}

if (!String(packageJson.scripts?.["marketing:check"] ?? "").includes("production-reconciliation-policy-check.mjs")) {
  failures.push("marketing:check must enforce production-reconciliation-policy-check.mjs");
}

if (failures.length > 0) {
  console.error("production-reconciliation-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("production-reconciliation-policy:check passed");
