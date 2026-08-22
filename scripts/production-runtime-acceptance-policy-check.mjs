import fs from "node:fs";

const failures = [];
const fail = (message) => failures.push(message);
const readText = (path) => {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : "read error"}`);
    return "";
  }
};
const readJson = (path) => {
  try {
    return JSON.parse(readText(path));
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    return {};
  }
};

const acceptancePolicy = readJson("config/production-runtime-acceptance-policy.json");
const releasePolicy = readJson("config/production-release-policy.json");
const packageJson = readJson("package.json");
const wranglerText = readText("config/wrangler.production-runtime-acceptance.jsonc");
const harness = readText("scripts/production-runtime-acceptance-worker.mjs");
const runner = readText("scripts/production-runtime-acceptance-runner.mjs");
const snapshot = readText("scripts/snapshot-production-runtime-surface.mjs");
const compare = readText("scripts/compare-production-runtime-surfaces.mjs");
const workflow = readText(".github/workflows/production-runtime-acceptance.yml");

const frozenSha = "feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c";
const frozenSourceSha = "6dbd16c2fc9a9fc1fda1db9a9a6640c640de2bd6";
const productionWorker = "tmg-video-services-production";
const namespaceId = "737c0b2361c2407ba3c765bcb269504f";
const tenant = "prod_acceptance_fixture_v1";

if (acceptancePolicy.schemaVersion !== "1.0.0") fail("runtime acceptance policy schemaVersion must be 1.0.0");
if (acceptancePolicy.targetEnvironment !== "production" || acceptancePolicy.targetScope !== "live_production_namespace") {
  fail("runtime acceptance policy must target the live production namespace");
}
if (acceptancePolicy.issue !== 29) fail("runtime acceptance policy must be governed by Issue #29");
if (acceptancePolicy.authorizationPhrase !== "RUN_LIVE_PRODUCTION_RUNTIME_ACCEPTANCE_V1") {
  fail("runtime acceptance authorization phrase mismatch");
}
if (acceptancePolicy.frozenFingerprintSha256 !== frozenSha) fail("runtime acceptance frozen fingerprint mismatch");
if (acceptancePolicy.frozenSourceCommitSha !== frozenSourceSha) fail("runtime acceptance frozen source commit mismatch");
if (acceptancePolicy.productionWorker !== productionWorker) fail("runtime acceptance production Worker mismatch");
if (acceptancePolicy.durableObjectClass !== "TenantUsageLedger") fail("runtime acceptance Durable Object class mismatch");
if (acceptancePolicy.durableObjectNamespaceId !== namespaceId) fail("runtime acceptance Durable Object namespace mismatch");
if (acceptancePolicy.acceptanceTenantId !== tenant || acceptancePolicy.acceptanceObjectPrefix !== tenant) {
  fail("runtime acceptance tenant/object prefix mismatch");
}
if (acceptancePolicy.providerId !== "fixture" || acceptancePolicy.providerAuthority !== "fixture") {
  fail("runtime acceptance must remain fixture-only");
}
if (acceptancePolicy.purpose !== "internal_search") fail("runtime acceptance purpose must remain internal_search");
if (acceptancePolicy.billingDisposition !== "development_non_billable" || acceptancePolicy.commercialReleaseApproved !== false) {
  fail("runtime acceptance must remain non-billable and non-commercial");
}
for (const [authority, value] of Object.entries(acceptancePolicy.authority ?? {})) {
  if (value !== false) fail(`runtime acceptance authority ${authority} must remain false`);
}
for (const requiredAuthority of [
  "publicApi",
  "mcp",
  "ingestion",
  "externalProviderEgress",
  "providerPromotion",
  "billing",
  "commercialUse",
  "publicTraffic",
]) {
  if (acceptancePolicy.authority?.[requiredAuthority] !== false) fail(`runtime acceptance authority ${requiredAuthority} missing or enabled`);
}

const harnessPolicy = acceptancePolicy.harness ?? {};
if (harnessPolicy.mode !== "wrangler_dev_remote") fail("acceptance harness must use wrangler_dev_remote");
if (harnessPolicy.workerName !== "tmg-video-runtime-acceptance") fail("acceptance harness Worker name mismatch");
for (const key of [
  "workersDev",
  "previewUrls",
  "persistentDeployAllowed",
  "customRoutesAllowed",
  "customDomainsAllowed",
  "r2BindingAllowed",
  "vectorizeBindingAllowed",
  "workflowBindingAllowed",
]) {
  if (harnessPolicy[key] !== false) fail(`acceptance harness policy ${key} must remain false`);
}

for (const expected of [
  '"name": "tmg-video-runtime-acceptance"',
  '"workers_dev": false',
  '"preview_urls": false',
  '"name": "ACCEPTANCE_LEDGER"',
  '"class_name": "TenantUsageLedger"',
  '"script_name": "tmg-video-services-production"',
]) {
  if (!wranglerText.includes(expected)) fail(`acceptance Wrangler config missing ${expected}`);
}
for (const forbidden of [
  '"r2_buckets"',
  '"vectorize"',
  '"workflows"',
  '"routes"',
  '"route"',
  '"triggers"',
  '"d1_databases"',
  '"kv_namespaces"',
  '"hyperdrive"',
  '"queues"',
  '"ai"',
]) {
  if (wranglerText.includes(forbidden)) fail(`acceptance Wrangler config contains forbidden binding/route surface ${forbidden}`);
}
const doBindingCount = (wranglerText.match(/"class_name"\s*:\s*"TenantUsageLedger"/g) ?? []).length;
if (doBindingCount !== 1) fail(`acceptance Wrangler config must contain exactly one TenantUsageLedger binding; found ${doBindingCount}`);

for (const expected of [
  "authorization",
  "TMG_ACCEPTANCE_TOKEN",
  "ACCEPTANCE_LEDGER.getByName",
  "internal_search",
  "fixture",
  "development_non_billable",
  "commercialReleaseApproved: false",
  "tenant_binding_mismatch",
]) {
  if (!harness.includes(expected) && expected !== "tenant_binding_mismatch") fail(`acceptance harness missing invariant ${expected}`);
}
if (!harness.includes('`${env.TMG_ACCEPTANCE_OBJECT_PREFIX}-`')) fail("acceptance harness must restrict Durable Object names to governed prefix");
if (!harness.includes('`${env.TMG_ACCEPTANCE_TENANT}_cross_tenant_probe`')) fail("acceptance harness cross-tenant probe must be fixed and non-arbitrary");
for (const forbidden of [
  "fetch(\"https://",
  "fetch('https://",
  "MEDIA_BUCKET",
  "VIDEO_INDEX",
  "INGEST_WORKFLOW",
  "REVOKE_WORKFLOW",
  "eligible_for_billing",
  "providerAuthority: \"authoritative\"",
  "providerAuthority: \"shadow\"",
]) {
  if (harness.includes(forbidden)) fail(`acceptance harness contains forbidden capability ${forbidden}`);
}

for (const expected of [
  "tenant_binding_mismatch",
  "idempotency_conflict",
  "request_quota_exceeded",
  "media_duration_quota_exceeded",
  "vector_quota_exceeded",
  "2026-08-21T23:59:59.000Z",
  "2026-08-22T00:00:00.000Z",
  "2026-08-22T01:00:00.000Z",
  "persistence_across_sessions",
]) {
  if (!runner.includes(expected)) fail(`acceptance matrix missing ${expected}`);
}

for (const expected of [
  "/r2/buckets/${expectedR2}/objects",
  "/vectorize/v2/indexes/${expectedVector}/list",
  "/vectorize/v2/indexes/${expectedVector}/info",
  "/workflows/${workflowName}/instances",
  "/workers/scripts/${expectedWorker}/settings",
  "/workers/scripts/${expectedWorker}/subdomain",
  "/workers/durable_objects/namespaces?per_page=1000",
  "/workers/domains",
  "/workers/routes",
  "/workers/scripts",
]) {
  if (!snapshot.includes(expected)) fail(`runtime surface snapshot missing GET-only evidence path ${expected}`);
}
for (const forbidden of [
  'method: "POST"',
  'method: "PUT"',
  'method: "PATCH"',
  'method: "DELETE"',
  "r2 object put",
  "r2 object delete",
  "vectorize insert",
  "vectorize upsert",
  "vectorize delete",
  "workflows trigger",
]) {
  if (snapshot.includes(forbidden)) fail(`runtime surface snapshot contains forbidden mutation ${forbidden}`);
}
for (const expected of [
  "productionWorker",
  "r2",
  "vectorize",
  "workflows",
  "durableObjectNamespace",
  "routing",
  "zero unexpected infrastructure delta",
]) {
  if (!compare.includes(expected)) fail(`runtime surface comparison missing ${expected}`);
}

for (const expected of [
  "github.event.issue.number == 29",
  "github.actor == 'TolaniCorp'",
  "RUN_LIVE_PRODUCTION_RUNTIME_ACCEPTANCE_V1",
  "environment: production",
  'test "$GITHUB_REF" = "refs/heads/main"',
  'test "$EXPECTED_SHA" = "$GITHUB_SHA"',
  "check-runs?per_page=100",
  frozenSha,
  "snapshot-production-runtime-surface.mjs --phase=before",
  "wrangler dev",
  "--remote",
  "production-runtime-acceptance-runner.mjs --phase=1",
  "production-runtime-acceptance-runner.mjs --phase=2",
  "snapshot-production-runtime-surface.mjs --phase=after",
  "compare-production-runtime-surfaces.mjs",
  "actions/upload-artifact@v4",
  "Issue #18",
]) {
  if (!workflow.includes(expected) && expected !== "Issue #18") fail(`runtime acceptance workflow missing ${expected}`);
}
if (!workflow.includes('gh issue comment 18')) fail("runtime acceptance workflow must bind sanitized evidence back to Issue #18");
for (const trigger of ["push", "pull_request", "schedule"]) {
  if (new RegExp(`^\\s{2}${trigger}:`, "m").test(workflow)) fail(`runtime acceptance workflow must not declare automatic trigger ${trigger}`);
}
for (const forbidden of [
  "wrangler deploy --config config/wrangler.production-runtime-acceptance.jsonc",
  "wrangler versions upload",
  "wrangler route",
  "r2 object put",
  "r2 object delete",
  "vectorize insert",
  "vectorize upsert",
  "vectorize delete",
  "workflows trigger",
  "secret put",
]) {
  if (workflow.includes(forbidden)) fail(`runtime acceptance workflow contains forbidden persistent/mutation command ${forbidden}`);
}

if (releasePolicy.activationAllowed !== false || releasePolicy.publicTrafficAllowed !== false) {
  fail("production release policy activation/public traffic must remain false");
}
for (const [key, expected] of Object.entries({
  TMG_PUBLIC_API_ENABLED: "false",
  TMG_MCP_ENABLED: "false",
  TMG_INGEST_WORKFLOW_ENABLED: "false",
  TMG_TENANT_USAGE_LEDGER_ENABLED: "false",
  TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false",
  TMG_PROVIDER_ACCEPTANCE_STATE: "unverified",
})) {
  if (releasePolicy.runtimeFlags?.[key] !== expected) fail(`release policy runtime flag ${key} must remain ${expected}`);
}
if (releasePolicy.providerAuthority?.defaultProviderId !== "fixture") fail("fixture must remain the production default provider");
if (releasePolicy.providerAuthority?.marengoAuthority !== "shadow_only") fail("Marengo must remain shadow_only");
for (const key of ["externalProviderEgressAllowed", "authoritativePromotionAllowed", "commercialUseAllowed"]) {
  if (releasePolicy.providerAuthority?.[key] !== false) fail(`release policy providerAuthority.${key} must remain false`);
}
if (releasePolicy.requiredGates?.tenantUsageLedgerAcceptance?.required !== true || releasePolicy.requiredGates?.tenantUsageLedgerAcceptance?.satisfied !== false) {
  fail("tenantUsageLedgerAcceptance must remain required and unsatisfied until live acceptance evidence is reviewed");
}
if (releasePolicy.requiredGates?.explicitReleaseApproval?.satisfied !== false) fail("explicitReleaseApproval must remain unsatisfied");

if (!String(packageJson.scripts?.["production-runtime-acceptance-policy:check"] ?? "").includes("production-runtime-acceptance-policy-check.mjs")) {
  fail("package.json must expose production-runtime-acceptance-policy:check");
}
if (!String(packageJson.scripts?.["marketing:check"] ?? "").includes("production-runtime-acceptance-policy:check")) {
  fail("marketing:check must enforce production-runtime-acceptance-policy:check");
}

if (failures.length > 0) {
  console.error("production-runtime-acceptance-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("production-runtime-acceptance-policy:check passed");
