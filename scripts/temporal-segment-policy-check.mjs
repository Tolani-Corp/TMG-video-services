import fs from "node:fs";

const failures = [];
const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const policy = read("config/temporal-segment-policy.json");
const registry = read("config/model-compatibility-registry.json");
const wrangler = read("wrangler.jsonc");
const workflow = fs.readFileSync(".github/workflows/temporal-segment-materialization.yml", "utf8");
const evaluator = fs.readFileSync(".github/workflows/marengo-shadow-evaluation.yml", "utf8");
const ingestionWorkflow = fs.readFileSync("src/workflow.ts", "utf8");
const revocationWorkflow = fs.readFileSync("src/revocation-workflow.ts", "utf8");

if (policy.schemaVersion !== "1.0.0" || policy.state !== "development") failures.push("temporal segment policy must remain development schema v1");
if (policy.authority !== "materialization_only") failures.push("temporal segment plane must remain materialization_only");
if (policy.source?.requiresCurrentVerifiedRights !== true || policy.source?.requiresExactR2Sha256 !== true) failures.push("segment materialization must require current verified rights and exact R2 SHA-256");
if (policy.segments?.minDurationMs !== 4000 || policy.segments?.maxDurationMs !== 30000) failures.push("Marengo segment window must remain 4-30 seconds");
if (policy.segments?.maxSegmentsPerRun > 64) failures.push("segment run cap cannot exceed 64 at G0");
if (policy.segments?.publicationState !== "review") failures.push("derived segments must remain review-only");
for (const key of ["authoritativeRoutingAllowed", "publicApiAllowed", "mcpAllowed", "commercialUseAllowed"]) {
  if (policy.shadowEvaluation?.[key] !== false) failures.push(`shadow segment evaluation cannot grant ${key}`);
}
if (policy.shadowEvaluation?.defaultEnabled !== false) failures.push("shadow evaluation must remain opt-in");
if (registry.defaultProviderId !== "fixture" || registry.externalProviderEgressAllowed !== false) failures.push("authoritative provider defaults changed");
if (wrangler.vars?.TMG_EMBEDDING_PROVIDER_ID !== "fixture" || wrangler.vars?.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED !== "false") failures.push("runtime provider authority changed");
if (!/workflow_dispatch:/.test(workflow) || /\n\s+(push|pull_request):/.test(workflow)) failures.push("segment materialization workflow must be manual-only");
if (!/environment:\s*development/.test(workflow)) failures.push("segment materialization workflow must use development environment");
if (!/run_shadow_evaluation:/.test(workflow) || !/default:\s*false/.test(workflow)) failures.push("shadow evaluation dispatch must default false");
if (!/current\.json/.test(workflow)) failures.push("segment materialization must load canonical current-rights pointer");
if (!/TMG_SHADOW_CURRENT_RIGHTS_PATH/.test(evaluator) || !/TMG_SHADOW_PARENT_CURRENT_RIGHTS_PATH/.test(evaluator)) failures.push("shadow evaluator must enforce current-rights lineage");
if (!/currentRightsKey/.test(ingestionWorkflow) || !/currentRevision/.test(ingestionWorkflow)) failures.push("canonical ingestion must maintain a current-rights pointer");
if (!/currentRightsKey/.test(revocationWorkflow) || !/advance current pointer/.test(revocationWorkflow)) failures.push("revocation must advance the current-rights pointer");

if (failures.length) {
  console.error("temporal-segment-policy:check failed");
  failures.forEach((x) => console.error(`- ${x}`));
  process.exit(1);
}
console.log("temporal-segment-policy:check passed");
