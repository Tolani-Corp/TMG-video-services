import fs from "node:fs";

const failures = [];
const fail = (message) => failures.push(message);
const readJson = (path) => {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); }
  catch (error) { fail(`${path}: ${error instanceof Error ? error.message : "invalid JSON"}`); return {}; }
};
const read = (path) => {
  try { return fs.readFileSync(path, "utf8"); }
  catch (error) { fail(`${path}: ${error instanceof Error ? error.message : "read failure"}`); return ""; }
};

const authority = readJson("config/production-release-authority.json");
const release = readJson("config/production-release-policy.json");
const promotion = readJson("config/provider-promotion-policy.json");
const wrangler = readJson("wrangler.jsonc");
const ingress = readJson("config/wrangler.production-s1-canary-ingress.jsonc");
const packageJson = readJson("package.json");
const workflow = read(".github/workflows/production-release-s0-s1.yml");
const approvalVerifier = read("scripts/verify-production-stage-approval.mjs");
const manifestBuilder = read("scripts/build-production-release-manifest.mjs");
const ingressWorker = read("scripts/production-release-s1-canary-ingress.mjs");

if (authority.schemaVersion !== "1.0.0" || authority.status !== "s0_s1_implemented_unactivated") fail("release authority must be S0/S1 implemented but unactivated");
if (authority.issue !== 40 || authority.implementationIssue !== 42) fail("release authority must remain bound to Issues #40 and #42");
if (authority.frozenInfrastructureFingerprintSha256 !== "feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c") fail("release-authority fingerprint changed");

for (const [key, value] of Object.entries(authority.authority ?? {})) if (value !== false) fail(`release authority ${key} must remain false`);
const implementation = authority.implementation ?? {};
if (implementation.maxExecutableStage !== "S1" || implementation.s0Implemented !== true || implementation.s1Implemented !== true) fail("S0/S1 implementation state is incomplete");
if (implementation.s1ApprovalPresent !== false || implementation.s2PlusImplemented !== false) fail("standing S1 approval or S2+ implementation is forbidden");
if (implementation.normalTrafficPercentageAuthorized !== 0 || implementation.persistentCanaryIngress !== false) fail("normal traffic or persistent canary ingress authority expanded");
if (implementation.rollbackToLastKnownGoodRequired !== true || implementation.postStageReadinessRequired !== true) fail("rollback/readiness controls are required");

const first = authority.firstCapability ?? {};
if (first.id !== "tenant_authenticated_vector_search_canary_v1" || first.implementationState !== "s0_s1_control_implemented_unactivated") fail("first capability implementation state changed");
if (first.ingress !== "ephemeral_service_binding_s1_operator_smoke" || first.reusePublicApiFlagAllowed !== false) fail("S1 must use the separate ephemeral service-binding ingress");
for (const [key, expected] of Object.entries({ purpose: "internal_search", tenantCohort: "production_canary_v1", providerId: "fixture", maxProviderAuthority: "fixture", billingMode: "non_billable", marengoAuthority: "shadow_only" })) {
  if (first[key] !== expected) fail(`first capability ${key} must remain ${expected}`);
}
for (const key of ["externalProviderEgressAllowed", "commercialUseAllowed", "mcpAllowed", "ingestionAllowed", "generalPublicApiAllowed"]) if (first[key] !== false) fail(`first capability ${key} must remain false`);

const stages = authority.canaryStages ?? [];
const expectedStages = [["S0",0],["S1",0],["S2",1],["S3",5],["S4",25],["S5",100]];
if (stages.length !== expectedStages.length) fail("authority must retain S0-S5 design stages");
expectedStages.forEach(([id, ceiling], index) => {
  const stage = stages[index] ?? {};
  if (stage.id !== id || stage.normalTrafficPercentageMax !== ceiling) fail(`${id} stage ceiling changed`);
  if (stage.tenantAllowlistRequired !== true) fail(`${id} must remain allowlisted`);
});
if (stages[1]?.humanStageApprovalRequired !== true || stages[1]?.versionOverrideSmokeAllowed !== true) fail("S1 must require human approval and version-override smoke");

const human = authority.humanApproval ?? {};
if (human.required !== true || human.oneTime !== true || human.approvalMustBeHumanAuthored !== true) fail("human stage approval must remain required/one-time/human-authored");
if (human.automationCanApprove !== false || human.replayAllowed !== false || human.staleOrBroaderApprovalAccepted !== false) fail("automation/replay/stale/broader approvals are forbidden");

const rollback = authority.rollback ?? {};
if (rollback.storageStateRollbackAssumed !== false || rollback.durableObjectLifecycleOrSchemaMigrationAllowedInV1 !== false || rollback.r2SchemaOrDestructiveMutationAllowedInV1 !== false || rollback.vectorIndexDestructiveMutationAllowedInV1 !== false) fail("S0/S1 must not depend on storage rollback or destructive storage mutations");

if (release.activationAllowed !== false || release.publicTrafficAllowed !== false || release.requiredGates?.explicitReleaseApproval?.satisfied !== false) fail("existing production release policy must remain fail-closed");
for (const key of ["TMG_PUBLIC_API_ENABLED", "TMG_MCP_ENABLED", "TMG_INGEST_WORKFLOW_ENABLED", "TMG_TENANT_USAGE_LEDGER_ENABLED", "TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED"]) if (release.runtimeFlags?.[key] !== "false") fail(`${key} must remain false`);
if (release.runtimeFlags?.TMG_PROVIDER_ACCEPTANCE_STATE !== "unverified") fail("provider acceptance state must remain unverified");

if (promotion.authoritativePromotionEnabled !== false) fail("authoritative provider promotion must remain disabled");
for (const target of ["authoritative_embedding", "public_api", "mcp", "commercial_use"]) if (promotion.promotionTargets?.[target]?.allowed !== false) fail(`promotion target ${target} must remain disabled`);
if (promotion.runtimeEnforcement?.abuseControls !== false || promotion.runtimeEnforcement?.billingMapping !== false) fail("abuse controls and billing mapping remain blockers");

const production = wrangler.env?.production ?? {};
if (production.workers_dev !== false || production.routes !== undefined || production.route !== undefined || production.custom_domains !== undefined) fail("production Worker must remain non-routed with workers.dev disabled");
for (const key of ["TMG_PUBLIC_API_ENABLED", "TMG_MCP_ENABLED", "TMG_INGEST_WORKFLOW_ENABLED", "TMG_TENANT_USAGE_LEDGER_ENABLED", "TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED"]) if (production.vars?.[key] !== "false") fail(`wrangler production ${key} must remain false`);
if (production.vars?.TMG_EMBEDDING_PROVIDER_ID !== "fixture") fail("production embedding provider must remain fixture");

if (ingress.workers_dev !== false || ingress.preview_urls !== false) fail("S1 canary ingress must disable workers.dev and preview URLs");
if (ingress.routes !== undefined || ingress.route !== undefined || ingress.custom_domains !== undefined) fail("S1 canary ingress must declare no route/domain");
const services = ingress.services ?? [];
if (services.length !== 1 || services[0]?.binding !== "TARGET_SERVICE" || services[0]?.service !== "tmg-video-services-production") fail("S1 ingress must expose exactly one Service Binding to production Worker");
for (const forbidden of ["r2_buckets", "vectorize", "durable_objects", "workflows", "queues", "d1_databases", "kv_namespaces"]) if (ingress[forbidden] !== undefined) fail(`S1 ingress must not bind ${forbidden}`);

for (const required of [
  "options:\n          - S0\n          - S1",
  "PREPARE_TMG_PRODUCTION_S0_V1",
  "EXECUTE_TMG_PRODUCTION_S1_ZERO_PERCENT_V1",
  "wrangler versions upload",
  '"${TMG_RELEASE_CANDIDATE_VERSION_ID}@0%"',
  '"${TMG_RELEASE_LKG_VERSION_ID}@100%"',
  "verify-production-stage-approval.mjs",
  "Cloudflare-Workers-Version-Overrides",
  "wrangler rollback",
  "snapshot-production-runtime-surface.mjs --phase=before",
  "snapshot-production-runtime-surface.mjs --phase=after",
  "compare-production-runtime-surfaces.mjs",
  "CONSUMED_TMG_RELEASE_APPROVAL_V1",
]) if (!workflow.includes(required) && !ingressWorker.includes(required)) fail(`S0/S1 implementation missing ${required}`);

for (const forbidden of ["@1%", "@5%", "@25%", "TMG_PUBLIC_API_ENABLED:true", "TMG_MCP_ENABLED:true", "wrangler triggers deploy", "r2 bucket delete", "vectorize delete", "workflows trigger"]) if (workflow.includes(forbidden)) fail(`S0/S1 workflow contains forbidden authority/mutation ${forbidden}`);
if (!workflow.includes("test \"$INPUT_RELEASE_ISSUE_NUMBER\" != \"42\"")) fail("Issue #42 must not self-approve S1");
if (!workflow.includes("github.actor == 'TolaniCorp'")) fail("release workflow must be restricted to the authorized operator account");

for (const required of ["approvalId has already been consumed", "approval validity window must not exceed 30 minutes", "approval humanAuthor must equal the GitHub comment author", "noOtherCapabilityAuthorized"]) if (!approvalVerifier.includes(required)) fail(`approval verifier missing ${required}`);
for (const required of ["flag: \"wx\"", "normalTrafficPercentage: 0", "storageMigrationAllowed: false", "providerId: \"fixture\""]) if (!manifestBuilder.includes(required)) fail(`release manifest builder missing ${required}`);
for (const required of ["s1_operator_smoke_only", "candidate_fail_closed_contract_rejected", "publicApiEnabled !== false", "mcpEnabled !== false"]) if (!ingressWorker.includes(required)) fail(`S1 ingress missing ${required}`);

if (!String(packageJson.scripts?.["marketing:check"] ?? "").includes("production-release-authority-policy:check")) fail("marketing:check must enforce release-authority policy");

if (failures.length) {
  console.error("production-release-authority-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("production-release-authority-policy:check passed");
