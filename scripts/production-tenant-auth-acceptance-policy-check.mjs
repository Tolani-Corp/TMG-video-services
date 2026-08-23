import fs from "node:fs";

const failures = [];
const read = (path) => {
  try { return fs.readFileSync(path, "utf8"); }
  catch (error) { failures.push(`${path}: ${error instanceof Error ? error.message : "read failure"}`); return ""; }
};
const readJson = (path) => {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); }
  catch (error) { failures.push(`${path}: ${error instanceof Error ? error.message : "json failure"}`); return {}; }
};

const workflow = read(".github/workflows/production-tenant-auth-acceptance.yml");
const worker = read("scripts/production-tenant-auth-acceptance-worker.mjs");
const runner = read("scripts/production-tenant-auth-acceptance-runner.mjs");
const auth = read("src/tenant-auth.ts");
const snapshot = read("scripts/snapshot-production-runtime-surface.mjs");
const wrangler = readJson("config/wrangler.production-tenant-auth-acceptance.jsonc");
const identities = readJson("config/production-tenant-identities.json");
const canonicalEntitlements = readJson("config/tenant-entitlements.json");
const acceptanceEntitlements = readJson("config/production-tenant-auth-acceptance-entitlements.json");
const release = readJson("config/production-release-policy.json");

if (wrangler.workers_dev !== false || wrangler.preview_urls !== false) failures.push("tenant auth acceptance harness must disable workers.dev and preview URLs");
const bindings = wrangler.durable_objects?.bindings ?? [];
if (bindings.length !== 1) failures.push("tenant auth acceptance harness must expose exactly one Durable Object binding");
const ledger = bindings[0] ?? {};
if (ledger.name !== "ACCEPTANCE_LEDGER" || ledger.class_name !== "TenantUsageLedger" || ledger.script_name !== "tmg-video-services-production") {
  failures.push("tenant auth acceptance harness must bind only the production TenantUsageLedger");
}
for (const forbiddenKey of ["r2_buckets", "vectorize", "workflows", "services", "routes", "route", "kv_namespaces", "d1_databases", "queues"]) {
  if (wrangler[forbiddenKey] !== undefined) failures.push(`tenant auth acceptance config must not declare ${forbiddenKey}`);
}

if (identities.defaultDecision !== "deny") failures.push("production identity registry must default deny");
const issuer = identities.issuers?.["urn:tolani:tmg:production-acceptance"];
if (!issuer || issuer.environment !== "production" || !issuer.audiences?.includes("urn:tolani:tmg-video-services:production")) {
  failures.push("production acceptance issuer/audience/environment contract is missing");
}
for (const [subject, tenantId, enabled] of [
  ["prod-acceptance-principal-a", "prod_acceptance_auth_a", true],
  ["prod-acceptance-principal-b", "prod_acceptance_auth_b", true],
  ["prod-acceptance-disabled", "prod_acceptance_auth_disabled", false],
]) {
  const principal = issuer?.principals?.[subject];
  if (!principal || principal.tenantId !== tenantId || principal.enabled !== enabled) failures.push(`identity registry mismatch for ${subject}`);
}

if (canonicalEntitlements.defaultDecision !== "deny") failures.push("canonical entitlement registry must remain default deny");
for (const [tenantId, entitlement] of Object.entries(canonicalEntitlements.tenants ?? {})) {
  if (entitlement?.environment === "production") failures.push(`${tenantId} must not have a production entitlement in the canonical G0 registry`);
}
if (acceptanceEntitlements.defaultDecision !== "deny" || acceptanceEntitlements.acceptanceOnly !== true) {
  failures.push("production auth entitlement fixture must be explicit acceptance-only and default deny");
}
for (const tenantId of ["prod_acceptance_auth_a", "prod_acceptance_auth_b"]) {
  const entitlement = acceptanceEntitlements.tenants?.[tenantId];
  if (!entitlement || entitlement.enabled !== true || entitlement.environment !== "production") failures.push(`${tenantId} must be enabled only in the production acceptance fixture`);
  if (JSON.stringify(entitlement?.allowedPurposes) !== JSON.stringify(["internal_search"])) failures.push(`${tenantId} purpose scope must remain internal_search only`);
  if (JSON.stringify(entitlement?.allowedProviderIds) !== JSON.stringify(["fixture"]) || entitlement?.maxProviderAuthority !== "fixture") failures.push(`${tenantId} provider authority must remain fixture-only`);
}
const disabledAcceptance = acceptanceEntitlements.tenants?.prod_acceptance_auth_disabled;
if (!disabledAcceptance || disabledAcceptance.enabled !== false) failures.push("disabled acceptance tenant must remain disabled");
for (const value of Object.values(disabledAcceptance?.quotas ?? {})) {
  if (!Number.isSafeInteger(value) || value <= 0) failures.push("disabled acceptance tenant fixture quotas must remain structurally valid positive integers");
}
if (!worker.includes("production-tenant-auth-acceptance-entitlements.json") || worker.includes('"../config/tenant-entitlements.json"')) {
  failures.push("ephemeral tenant auth harness must use only the isolated acceptance entitlement fixture");
}

for (const required of [
  "header.alg !== \"EdDSA\"",
  "credential_signature_invalid",
  "credential_issuer_rejected",
  "credential_audience_rejected",
  "credential_environment_rejected",
  "credential_expired",
  "principal_not_registered",
  "principal_disabled",
  "expiresAt - issuedAt > 900",
  "evaluateAuthenticatedTenantEntitlement",
]) if (!auth.includes(required)) failures.push(`tenant auth implementation missing ${required}`);

for (const required of [
  "caller_tenant_override_forbidden",
  "credential_replay",
  "eventId: `auth:${principal.credentialId}`",
  "production_acceptance_non_billable",
  "commercialReleaseApproved: false",
  "ACCEPTANCE_LEDGER.getByName",
]) if (!worker.includes(required)) failures.push(`tenant auth harness missing ${required}`);

for (const required of [
  "authentication_negative_matrix",
  "caller_tenant_override_forbidden",
  "entitlement_default_deny_matrix",
  "tenant_isolation_and_authorized_usage",
  "persistent_cross_session_credential_replay_rejection",
]) if (!runner.includes(required)) failures.push(`tenant auth runner missing ${required}`);

for (const required of [
  "github.event.issue.number == 34",
  "github.actor == 'TolaniCorp'",
  "RUN_LIVE_PRODUCTION_TENANT_AUTH_ENTITLEMENT_ACCEPTANCE_V1",
  "environment: production",
  "Issue #29 must be closed green first",
  "feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c",
  "wrangler dev",
  "--remote",
  "snapshot-production-runtime-surface.mjs --phase=before",
  "snapshot-production-runtime-surface.mjs --phase=after",
  "compare-production-runtime-surfaces.mjs",
  "rm -f \"$PRIVATE_JWK\" \"$PUBLIC_JWK\" \"$REPLAY_TOKEN\"",
]) if (!workflow.includes(required)) failures.push(`tenant auth workflow missing ${required}`);

for (const automatic of ["push:", "pull_request:", "schedule:"]) {
  if (new RegExp(`^\\s{2}${automatic.replace(':', '')}:`, "m").test(workflow)) failures.push(`tenant auth acceptance must not declare automatic trigger ${automatic}`);
}
for (const forbidden of [
  "wrangler deploy --config config/wrangler.production-tenant-auth-acceptance.jsonc",
  "r2 bucket create",
  "r2 bucket delete",
  "vectorize create",
  "vectorize delete",
  "workflows trigger",
  "secret put",
]) if (workflow.includes(forbidden)) failures.push(`tenant auth acceptance contains forbidden production mutation ${forbidden}`);

if (!snapshot.includes("TMG_ACCEPTANCE_WORKER_NAME") || !snapshot.includes("acceptancePersistentScripts")) failures.push("production surface snapshot must track the tenant auth ephemeral worker");
if (release.evidenceBindings?.tenantUsageLedgerAcceptance?.status !== "verified") failures.push("live Runtime Acceptance v1 evidence must remain bound before auth acceptance");
if (release.activationAllowed !== false || release.publicTrafficAllowed !== false) failures.push("production activation/public traffic must remain false");
for (const key of ["TMG_PUBLIC_API_ENABLED", "TMG_MCP_ENABLED", "TMG_INGEST_WORKFLOW_ENABLED", "TMG_TENANT_USAGE_LEDGER_ENABLED", "TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED"]) {
  if (release.runtimeFlags?.[key] !== "false") failures.push(`${key} must remain false during tenant auth acceptance`);
}
if (release.providerAuthority?.authoritativePromotionAllowed !== false || release.providerAuthority?.commercialUseAllowed !== false) failures.push("provider/commercial authority must remain false");

if (failures.length) {
  console.error("production-tenant-auth-acceptance-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("production-tenant-auth-acceptance-policy:check passed");
