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
const wrangler = readJson("wrangler.jsonc");
const packageJson = readJson("package.json");
let workflow = "";
try {
  workflow = fs.readFileSync(".github/workflows/production-bootstrap.yml", "utf8");
} catch (error) {
  failures.push(`production bootstrap workflow missing: ${error instanceof Error ? error.message : "read error"}`);
}

if (productionPolicy.resourcePolicy?.automaticProvisioningAllowed !== false) {
  failures.push("automatic production provisioning must remain disabled");
}
if (productionPolicy.resourcePolicy?.manualBootstrapMode !== "gated_workflow_only") {
  failures.push("manual production bootstrap must remain gated_workflow_only");
}
if (productionPolicy.requiredGates?.productionInfrastructureBootstrap?.required !== true) {
  failures.push("productionInfrastructureBootstrap gate must remain required");
}
if (productionPolicy.requiredGates?.productionInfrastructureBootstrap?.satisfied !== false) {
  failures.push("productionInfrastructureBootstrap gate must remain unsatisfied until live evidence is bound");
}
if (productionPolicy.activationAllowed !== false || productionPolicy.publicTrafficAllowed !== false) {
  failures.push("production activation/public traffic must remain disabled during bootstrap");
}

if (!/^on:\s*\n\s{2}workflow_dispatch:/m.test(workflow)) {
  failures.push("production bootstrap must expose workflow_dispatch");
}
for (const trigger of ["push", "pull_request", "schedule"] ) {
  if (new RegExp(`^\\s{2}${trigger}:`, "m").test(workflow)) {
    failures.push(`production bootstrap must not declare automatic trigger ${trigger}`);
  }
}
if (!workflow.includes("environment: production")) failures.push("production bootstrap must use GitHub environment production");
if (!workflow.includes("expected_sha:")) failures.push("production bootstrap must require expected_sha input");
if (!workflow.includes("authorization:")) failures.push("production bootstrap must require explicit authorization input");
if (!workflow.includes("BOOTSTRAP_DISABLED_PRODUCTION_INFRASTRUCTURE")) {
  failures.push("production bootstrap authorization phrase is missing");
}
if (!workflow.includes('test "$GITHUB_REF" = "refs/heads/main"')) failures.push("bootstrap must require dispatch from main");
if (!workflow.includes('test "$EXPECTED_SHA" = "$GITHUB_SHA"')) failures.push("bootstrap must bind expected_sha to dispatched main SHA");
if (!workflow.includes("repos/${GITHUB_REPOSITORY}/branches/main")) failures.push("bootstrap must verify main branch protection");
if (!workflow.includes("gh issue view 14")) failures.push("bootstrap must require Issue #14 closure");
if (!workflow.includes("check-runs?per_page=100")) failures.push("bootstrap must verify exact-head GitHub check evidence");
if (!workflow.includes('.name == "validate"') || !workflow.includes('.conclusion == "success"')) {
  failures.push("bootstrap must require successful validate check on exact head");
}

const governancePosition = workflow.indexOf("Enforce production bootstrap governance");
const r2CreatePosition = workflow.indexOf("r2 bucket create");
const vectorCreatePosition = workflow.indexOf("vectorize create");
const deployPosition = workflow.indexOf("wrangler deploy --env production");
if (governancePosition < 0 || r2CreatePosition < 0 || vectorCreatePosition < 0 || deployPosition < 0) {
  failures.push("bootstrap must contain governance, R2 create, Vectorize create, and production deploy stages");
} else if (!(governancePosition < r2CreatePosition && governancePosition < vectorCreatePosition && governancePosition < deployPosition)) {
  failures.push("bootstrap governance must execute before every Cloudflare mutation stage");
}

for (const expected of [
  "tmg-video-assets-prod",
  "tmg-video-segments-512-prod",
  "tmg-video-ingestion-prod",
  "tmg-video-revocation-prod",
]) {
  if (!workflow.includes(expected)) failures.push(`bootstrap missing expected production resource ${expected}`);
}
if (!workflow.includes("--dimensions 512 --metric cosine")) failures.push("production Vectorize creation must remain 512d cosine");
if (!workflow.includes("node scripts/ensure-metadata-indexes.mjs")) failures.push("bootstrap must create/verify governance metadata indexes before deployment");
if (!workflow.includes("pnpm production:dry-run")) failures.push("bootstrap must dry-run the exact production bundle before mutation");
if (!workflow.includes("gh issue comment 18")) failures.push("bootstrap must publish sanitized evidence to Issue #18");

for (const forbidden of [
  "r2 bucket delete",
  "vectorize delete",
  "wrangler delete",
  "workflows delete",
  "workflows trigger",
  "secret put",
  "TMG_PUBLIC_API_ENABLED: \"true\"",
  "TMG_MCP_ENABLED: \"true\"",
  "TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: \"true\"",
]) {
  if (workflow.includes(forbidden)) failures.push(`production bootstrap contains forbidden operation/state: ${forbidden}`);
}

const production = wrangler.env?.production;
if (production?.workers_dev !== false) failures.push("production workers_dev must remain false during bootstrap");
if (production?.routes || production?.route || production?.custom_domains) failures.push("production bootstrap must not have a public route/custom domain");
for (const name of [
  "TMG_PUBLIC_API_ENABLED",
  "TMG_MCP_ENABLED",
  "TMG_INGEST_WORKFLOW_ENABLED",
  "TMG_TENANT_USAGE_LEDGER_ENABLED",
  "TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED",
]) {
  if (production?.vars?.[name] !== "false") failures.push(`production ${name} must remain false during bootstrap`);
}
if (production?.vars?.TMG_PROVIDER_ACCEPTANCE_STATE !== "unverified") failures.push("production provider acceptance must remain unverified during bootstrap");
if (production?.vars?.TMG_EMBEDDING_PROVIDER_ID !== "fixture") failures.push("production provider must remain fixture during bootstrap");

if (!String(packageJson.scripts?.["marketing:check"] ?? "").includes("production-bootstrap-policy-check.mjs")) {
  failures.push("marketing:check must enforce production-bootstrap-policy-check.mjs");
}

if (failures.length > 0) {
  console.error("production-bootstrap-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("production-bootstrap-policy:check passed");
