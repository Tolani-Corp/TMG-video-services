import { readFile } from "node:fs/promises";

const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJsonc(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

async function main() {
  const [
    migration,
    api,
    store,
    rootConfigText,
    apiConfigText,
    accessAuth,
    bootstrap,
    activationWorkflow,
    readinessWorkflow,
    readinessScript,
  ] = await Promise.all([
    readFile("migrations/0001_intake_control_plane.sql", "utf8"),
    readFile("src/intake-api.ts", "utf8"),
    readFile("src/intake-store.ts", "utf8"),
    readFile("wrangler.jsonc", "utf8"),
    readFile("wrangler.intake-api.jsonc", "utf8"),
    readFile("src/access-auth.ts", "utf8"),
    readFile("src/ui-bootstrap.ts", "utf8"),
    readFile(".github/workflows/intake-console-activation.yml", "utf8"),
    readFile(".github/workflows/intake-cloudflare-readiness.yml", "utf8"),
    readFile("scripts/intake-cloudflare-readiness.mjs", "utf8"),
  ]);
  const rootConfig = parseJsonc(rootConfigText);
  const apiConfig = parseJsonc(apiConfigText);

  for (const constraint of [
    "processing_authority INTEGER NOT NULL DEFAULT 0 CHECK (processing_authority = 0)",
    "publication_authority INTEGER NOT NULL DEFAULT 0 CHECK (publication_authority = 0)",
    "commercial_authority INTEGER NOT NULL DEFAULT 0 CHECK (commercial_authority = 0)",
    "processable INTEGER NOT NULL DEFAULT 0 CHECK (processable = 0)",
    "billable INTEGER NOT NULL DEFAULT 0 CHECK (billable = 0)",
    "release_authority INTEGER NOT NULL DEFAULT 0 CHECK (release_authority = 0)",
    "authority_effect TEXT NOT NULL DEFAULT 'none_g0' CHECK (authority_effect = 'none_g0')",
  ]) {
    assert(migration.includes(constraint), `G0 authority constraint missing: ${constraint}`);
  }
  assert(migration.includes("CHECK (verified_by IS NULL OR verified_by <> submitted_by)"), "Independent rights review SQL guard is missing");

  assert(accessAuth.includes("ctx.access.getIdentity()"), "Console API must use Cloudflare Access identity context");
  assert(!accessAuth.includes("CF-Access-Authenticated-User-Email"), "Do not trust raw Access identity headers");

  assert(api.includes("rights must be independently verified before source bytes can enter quarantine"), "Rights-first media gate is missing");
  assert(api.includes("x-tmg-content-sha256"), "Integrity-bound upload header is missing");
  assert(api.includes("sha256: declaredSha"), "R2 SHA-256 integrity enforcement is missing");
  assert(api.includes("env.MEDIA_BUCKET"), "Private R2 binding is required for intake uploads");
  assert(!api.includes("INGEST_WORKFLOW"), "Authenticated intake API must not dispatch the ingestion Workflow at G0");
  assert(!api.includes("VIDEO_INDEX"), "Authenticated intake API must not write Vectorize at G0");
  assert(store.includes("blocked_processing_authority"), "Job creation must remain processing-blocked");
  assert(store.includes("processingAuthority: false"), "Job audit must record missing processing authority");

  assert(rootConfig.vars?.TMG_INTAKE_ENABLED === "false", "Root Worker intake must remain disabled in committed config");
  assert(rootConfig.vars?.TMG_CONTROL_DB_BINDING_STATE === "unprovisioned", "Root Worker database state must remain unprovisioned");
  assert(rootConfig.d1_databases?.[0]?.database_id === PLACEHOLDER_DB_ID, "Root committed D1 binding must remain an explicit placeholder until bootstrap succeeds");
  assert(rootConfig.env?.production?.vars?.TMG_INTAKE_ENABLED === "false", "Production intake must remain disabled");
  assert(rootConfig.env?.production?.d1_databases?.[0]?.database_id === PLACEHOLDER_DB_ID, "Production D1 must not be provisioned by this increment");

  assert(apiConfig.workers_dev === false, "Intake API Worker must not expose a workers.dev route");
  assert(apiConfig.vars?.TMG_INTAKE_ENABLED === "false", "Committed intake API config must remain disabled");
  assert(apiConfig.vars?.TMG_CONTROL_DB_BINDING_STATE === "unprovisioned", "Committed intake API DB state must remain unprovisioned");
  assert(apiConfig.d1_databases?.[0]?.database_id === PLACEHOLDER_DB_ID, "Intake API D1 binding must remain placeholder before controlled activation");
  const routePatterns = (apiConfig.routes ?? []).map((route) => route.pattern);
  assert(routePatterns.includes("console.tolanimediagroup.com/v1/console/*"), "Console session route contract is missing");
  assert(routePatterns.includes("console.tolanimediagroup.com/v1/intake/*"), "Intake API route contract is missing");
  assert(!routePatterns.some((route) => route.includes("app.tolanimediagroup.com")), "Customer app domain must remain untouched");

  assert(bootstrap.includes("processingAuthority: false"), "UI bootstrap must deny processing authority");
  assert(bootstrap.includes("publicationAuthority: false"), "UI bootstrap must deny publication authority");
  assert(bootstrap.includes("commercialAuthority: false"), "UI bootstrap must deny commercial authority");

  assert(activationWorkflow.includes("workflow_dispatch:"), "Console activation must require explicit workflow dispatch");
  assert(!activationWorkflow.includes("pull_request:"), "Console activation must never mutate Cloudflare from a pull_request trigger");
  assert(!activationWorkflow.includes("push:"), "Console activation must never mutate Cloudflare from a push trigger");
  const readinessIndex = activationWorkflow.indexOf("Prove Cloudflare credential and resource readiness without mutations");
  const mutationPreparationIndex = activationWorkflow.indexOf("Prepare D1, zone, and Access before domain attachment");
  assert(readinessIndex >= 0, "Console activation is missing the read-only Cloudflare readiness gate");
  assert(mutationPreparationIndex > readinessIndex, "Read-only Cloudflare readiness must execute before mutation-capable preparation");
  assert(activationWorkflow.includes("Wait for exact-head Quality success"), "Console activation must retain exact-head Quality gating");
  assert(activationWorkflow.includes("intake-cloudflare-readiness.json"), "Activation evidence must include credential-readiness evidence");

  assert(readinessWorkflow.includes("workflow_dispatch:"), "Credential readiness must be manually dispatched");
  assert(!readinessWorkflow.includes("pull_request:"), "Credential readiness must not run automatically on pull requests");
  assert(!readinessWorkflow.includes("push:"), "Credential readiness must not run automatically on push");
  assert(readinessWorkflow.includes("TMG Intake Credential Readiness"), "Credential readiness status context is missing");
  assert(readinessWorkflow.includes("read-only Cloudflare readiness"), "Credential readiness HOLD description must state the read-only boundary");

  assert(readinessScript.includes('method: "GET"'), "Credential readiness probe must use explicit GET requests");
  assert(!/method:\s*"(?:POST|PUT|PATCH|DELETE)"/.test(readinessScript), "Credential readiness script must remain mutation-free");
  assert(readinessScript.includes("mutationAttempted: false"), "Credential readiness evidence must explicitly deny mutation attempts");
  for (const probePath of [
    "/user/tokens/verify",
    "/d1/database?name=",
    "/access/apps?per_page=100",
    "/workers/scripts",
    "/workers/domains?hostname=",
    "/workers/routes",
  ]) {
    assert(readinessScript.includes(probePath), `Credential readiness probe missing Cloudflare visibility check: ${probePath}`);
  }
  assert(!readinessScript.includes("app.tolanimediagroup.com"), "Credential readiness must not touch the reserved customer app domain");

  console.log("TMG authenticated intake control-plane policy: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
