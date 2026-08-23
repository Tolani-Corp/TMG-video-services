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

const policy = readJson("config/production-release-policy.json");
const wrangler = readJson("wrangler.jsonc");
const promotion = readJson("config/provider-promotion-policy.json");
const publicContext = readJson("config/public-product-context.json");
const packageJson = readJson("package.json");
let workflow = "";
try {
  workflow = fs.readFileSync(".github/workflows/production-readiness.yml", "utf8");
} catch (error) {
  failures.push(`production readiness workflow missing: ${error instanceof Error ? error.message : "read error"}`);
}

if (policy.schemaVersion !== "1.0.0") failures.push("production release policy schemaVersion must be 1.0.0");
if (policy.targetEnvironment !== "production") failures.push("targetEnvironment must be production");
if (policy.deploymentMode !== "disabled_envelope") failures.push("production deploymentMode must remain disabled_envelope");
if (policy.activationAllowed !== false || policy.publicTrafficAllowed !== false) {
  failures.push("production activation and public traffic must remain disabled");
}
if (policy.resourcePolicy?.automaticProvisioningAllowed !== false) {
  failures.push("production automatic provisioning must remain disabled");
}

const expected = {
  workerName: "tmg-video-services-production",
  r2Bucket: "tmg-video-assets-prod",
  vectorIndex: "tmg-video-segments-512-prod",
  ingestionWorkflow: "tmg-video-ingestion-prod",
  revocationWorkflow: "tmg-video-revocation-prod",
};
for (const [key, value] of Object.entries(expected)) {
  if (policy.resourcePolicy?.[key] !== value) failures.push(`production resource ${key} must be ${value}`);
}

const gateNames = [
  "repositoryProtection",
  "exactHeadQuality",
  "productionReadinessAudit",
  "tenantUsageLedgerAcceptance",
  "tenantAuthenticationEntitlementAcceptance",
  "explicitReleaseApproval",
];
for (const gate of gateNames) {
  if (policy.requiredGates?.[gate]?.required !== true) failures.push(`production gate ${gate} must remain required`);
  if (policy.requiredGates?.[gate]?.satisfied !== false) failures.push(`production gate ${gate} must remain unsatisfied until evidence is bound`);
}
if (policy.requiredGates?.repositoryProtection?.issue !== 14) {
  failures.push("repositoryProtection must remain bound to Issue #14 until that gate is closed with evidence");
}

if (
  policy.providerAuthority?.defaultProviderId !== "fixture" ||
  policy.providerAuthority?.marengoAuthority !== "shadow_only" ||
  policy.providerAuthority?.externalProviderEgressAllowed !== false ||
  policy.providerAuthority?.authoritativePromotionAllowed !== false ||
  policy.providerAuthority?.commercialUseAllowed !== false
) {
  failures.push("production provider authority must remain fixture-default, Marengo shadow-only, non-commercial, and no-egress");
}

const production = wrangler.env?.production;
if (!production) failures.push("wrangler env.production is required");
if (production?.name !== expected.workerName) failures.push("production Worker name mismatch");
if (production?.workers_dev !== false) failures.push("production workers_dev must be false");
if (production?.routes || production?.route || production?.custom_domains) {
  failures.push("production routes/custom domains must not be declared before release approval");
}

const requiredFalseVars = [
  "TMG_PUBLIC_API_ENABLED",
  "TMG_MCP_ENABLED",
  "TMG_INGEST_WORKFLOW_ENABLED",
  "TMG_TENANT_USAGE_LEDGER_ENABLED",
  "TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED",
];
for (const name of requiredFalseVars) {
  if (production?.vars?.[name] !== "false") failures.push(`production ${name} must remain false`);
  if (policy.runtimeFlags?.[name] !== "false") failures.push(`production policy ${name} must remain false`);
}
if (production?.vars?.TMG_PROVIDER_ACCEPTANCE_STATE !== "unverified") {
  failures.push("production provider acceptance runtime state must remain unverified");
}
if (production?.vars?.TMG_EMBEDDING_PROVIDER_ID !== "fixture") {
  failures.push("production embedding provider must remain fixture");
}
if (production?.vars?.TMG_INGESTION_MODE !== "fixture_only") {
  failures.push("production ingestion mode must remain fixture_only while ingestion workflow is disabled");
}

const prodR2 = production?.r2_buckets?.find((binding) => binding.binding === "MEDIA_BUCKET");
if (prodR2?.bucket_name !== expected.r2Bucket) failures.push("production MEDIA_BUCKET must use the prod bucket");
const prodVector = production?.vectorize?.find((binding) => binding.binding === "VIDEO_INDEX");
if (prodVector?.index_name !== expected.vectorIndex) failures.push("production VIDEO_INDEX must use the prod index");
const prodLedger = production?.durable_objects?.bindings?.find((binding) => binding.name === "TENANT_USAGE_LEDGER");
if (prodLedger?.class_name !== "TenantUsageLedger") failures.push("production TENANT_USAGE_LEDGER binding mismatch");
const ingestWorkflow = production?.workflows?.find((binding) => binding.binding === "INGEST_WORKFLOW");
const revokeWorkflow = production?.workflows?.find((binding) => binding.binding === "REVOKE_WORKFLOW");
if (ingestWorkflow?.name !== expected.ingestionWorkflow || ingestWorkflow?.class_name !== "IngestionWorkflow") {
  failures.push("production ingestion Workflow binding mismatch");
}
if (revokeWorkflow?.name !== expected.revocationWorkflow || revokeWorkflow?.class_name !== "RevocationWorkflow") {
  failures.push("production revocation Workflow binding mismatch");
}

const serializedProduction = JSON.stringify(production);
for (const devResource of ["tmg-video-assets-dev", "tmg-video-segments-512-dev", "tmg-video-ingestion-dev", "tmg-video-revocation-dev"]) {
  if (serializedProduction.includes(devResource)) failures.push(`production environment must not reference development resource ${devResource}`);
}

if (promotion.authoritativePromotionEnabled !== false) failures.push("authoritative provider promotion must remain disabled");
for (const target of ["authoritative_embedding", "public_api", "mcp", "commercial_use"]) {
  if (promotion.promotionTargets?.[target]?.allowed !== false) failures.push(`promotion target ${target} must remain disabled`);
}
if (publicContext.publicStatus !== "G0") failures.push("public product context must remain G0");

if (!workflow.includes("environment: production")) failures.push("production readiness workflow must use GitHub environment production");
if (!workflow.includes("wrangler deploy --env production --dry-run")) failures.push("production readiness workflow must compile with deploy --dry-run");
if (!workflow.includes("CLOUDFLARE_ACCOUNT_ID: d20586cf099d39fcbeb5db4043e20f6f")) {
  failures.push("production readiness workflow must use the proven TMG Cloudflare account ID");
}
if (workflow.includes("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}")) {
  failures.push("Cloudflare account ID is non-secret repository configuration and must not depend on a missing production secret");
}
if (!workflow.includes("issues: write")) failures.push("production readiness workflow must be able to publish sanitized audit evidence to Issue #18");
if (!workflow.includes("gh issue comment 18")) failures.push("production readiness workflow must self-report sanitized results to Issue #18");
for (const forbidden of [
  "r2 bucket create",
  "vectorize create",
  "workflows trigger",
  "secret put",
  "wrangler deploy --env production\n",
  "wrangler delete",
  "r2 bucket delete",
  "vectorize delete",
]) {
  if (workflow.includes(forbidden)) failures.push(`production readiness workflow contains forbidden mutation: ${forbidden}`);
}
if (!workflow.includes("r2 bucket info tmg-video-assets-prod")) failures.push("production audit must inspect the expected R2 bucket");
if (!workflow.includes("vectorize get tmg-video-segments-512-prod")) failures.push("production audit must inspect the expected Vectorize index");
if (!workflow.includes("workflows describe tmg-video-ingestion-prod")) failures.push("production audit must inspect the ingestion Workflow");
if (!workflow.includes("workflows describe tmg-video-revocation-prod")) failures.push("production audit must inspect the revocation Workflow");

if (!String(packageJson.scripts?.["marketing:check"] ?? "").includes("production-release-policy-check.mjs")) {
  failures.push("marketing:check must enforce production-release-policy-check.mjs");
}

if (failures.length > 0) {
  console.error("production-release-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("production-release-policy:check passed");
