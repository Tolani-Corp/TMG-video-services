import fs from "node:fs";

const failures = [];

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    return {};
  }
}

const acceptance = readJson("config/provider-acceptance-registry.json");
const registry = readJson("config/model-compatibility-registry.json");
const wrangler = readJson("wrangler.jsonc");
let workflow = "";
try {
  workflow = fs.readFileSync(".github/workflows/marengo-shadow-evaluation.yml", "utf8");
} catch (error) {
  failures.push(`marengo shadow workflow missing: ${error instanceof Error ? error.message : "read error"}`);
}

const provider = acceptance.providers?.["twelvelabs-marengo3"];
const registeredProvider = (registry.providers ?? []).find(
  (candidate) => candidate.id === "twelvelabs-marengo3",
);

if (acceptance.schemaVersion !== "1.0.0") failures.push("provider acceptance registry schemaVersion must be 1.0.0");
if (!provider) failures.push("Marengo provider acceptance evidence is missing");
if (provider?.state !== "development_shadow_verified") {
  failures.push("Marengo acceptance state must be development_shadow_verified");
}
if (provider?.authority !== "shadow_only") failures.push("Marengo acceptance authority must remain shadow_only");
if (provider?.profileId !== "twelvelabs_marengo3_fused_512_v1") failures.push("Marengo acceptance profile mismatch");
if (provider?.compatibilityGroup !== "marengo3_fused_512_v1" || provider?.dimensions !== 512) {
  failures.push("Marengo acceptance compatibility contract must remain marengo3_fused_512_v1/512");
}
if (!/^[a-f0-9]{40}$/.test(provider?.evidence?.headSha ?? "")) failures.push("Marengo acceptance evidence headSha is invalid");
if (!/^sha256:[a-f0-9]{64}$/.test(provider?.evidence?.artifactDigest ?? "")) {
  failures.push("Marengo acceptance artifact digest must be pinned by SHA-256");
}
if (!/^[a-f0-9]{64}$/.test(provider?.evidence?.fixtureSha256 ?? "")) failures.push("Marengo acceptance fixture SHA-256 is invalid");
if (!Number.isInteger(provider?.evidence?.workflowRunId) || provider.evidence.workflowRunId <= 0) {
  failures.push("Marengo acceptance workflow run ID is invalid");
}
if (!Number.isFinite(Date.parse(provider?.evidence?.acceptedAt ?? ""))) failures.push("Marengo acceptance timestamp is invalid");

for (const gate of ["authoritativeRoutingAllowed", "publicApiAllowed", "mcpAllowed", "commercialUseAllowed"]) {
  if (provider?.promotion?.[gate] !== false) failures.push(`Marengo acceptance must keep ${gate}=false`);
}
if (provider?.promotion?.requiresExplicitReleaseApproval !== true) {
  failures.push("Marengo promotion must require explicit release approval");
}

if (!registeredProvider || registeredProvider.status !== "shadow") {
  failures.push("model compatibility registry must keep Marengo status=shadow");
}
if (registry.defaultProviderId !== "fixture" || registry.externalProviderEgressAllowed !== false) {
  failures.push("model compatibility registry must keep fixture default and external egress disabled");
}
if (wrangler.vars?.TMG_EMBEDDING_PROVIDER_ID !== "fixture") failures.push("wrangler default provider must remain fixture");
if (wrangler.vars?.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED !== "false") failures.push("wrangler external provider egress must remain false");
if (wrangler.vars?.TMG_PROVIDER_ACCEPTANCE_STATE !== "unverified") {
  failures.push("runtime provider acceptance must remain unverified; evidence registry is not runtime authority");
}

if (!/^on:\s*\n\s{2}workflow_dispatch:/m.test(workflow)) {
  failures.push("Marengo shadow evaluation workflow must remain manual workflow_dispatch only");
}
for (const forbidden of ["push:", "pull_request:", "schedule:"]) {
  if (new RegExp(`^\\s{2}${forbidden.replace(":", "\\:")}`, "m").test(workflow)) {
    failures.push(`Marengo shadow evaluation workflow must not declare ${forbidden}`);
  }
}
if (!/environment:\s*development/.test(workflow)) failures.push("Marengo shadow evaluation must use the development GitHub Environment");
if (!/TMG_MARENGO_SHADOW_INDEX:\s*tmg-marengo-shadow-eval-512-dev/.test(workflow)) {
  failures.push("Marengo shadow evaluation must remain isolated in the development-only Vectorize index");
}
if (/environment:\s*production/.test(workflow)) failures.push("Marengo shadow evaluation must never target the production environment");

if (failures.length > 0) {
  console.error("provider-acceptance:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("provider-acceptance:check passed");
