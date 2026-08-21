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

const promotion = readJson("config/provider-promotion-policy.json");
const entitlements = readJson("config/tenant-entitlements.json");
const providerAcceptance = readJson("config/provider-acceptance-registry.json");
const cascadeAcceptance = readJson("config/derived-rights-cascade-acceptance.json");
const modelRegistry = readJson("config/model-compatibility-registry.json");
const publicContext = readJson("config/public-product-context.json");
const wrangler = readJson("wrangler.jsonc");
const pkg = readJson("package.json");

if (promotion.schemaVersion !== "1.0.0") failures.push("provider promotion policy schemaVersion must be 1.0.0");
if (promotion.phase !== "development_shadow") failures.push("provider promotion phase must remain development_shadow");
if (promotion.defaultDecision !== "deny") failures.push("provider promotion defaultDecision must remain deny");
if (promotion.authoritativePromotionEnabled !== false) failures.push("authoritative provider promotion must remain disabled");
if (promotion.requiredEvidence?.providerAcceptanceState !== "development_shadow_verified") {
  failures.push("provider promotion must require development_shadow_verified provider evidence");
}
if (promotion.requiredEvidence?.cascadeAcceptanceState !== "development_cascade_verified") {
  failures.push("provider promotion must require development_cascade_verified cascade evidence");
}
if (promotion.requiredEvidence?.explicitReleaseApproval !== true) {
  failures.push("provider promotion must require explicit release approval");
}

for (const control of ["promotionDecisionEngine", "tenantEntitlementEvaluator", "quotaEvaluator", "usageEventSchema"]) {
  if (promotion.controlPlane?.[control] !== true) failures.push(`control-plane capability ${control} must be present`);
}
for (const control of [
  "tenantAuthentication",
  "tenantIsolation",
  "entitlementGate",
  "quotaPersistence",
  "usageMeterPersistence",
  "abuseControls",
  "billingMapping",
]) {
  if (promotion.runtimeEnforcement?.[control] !== false) {
    failures.push(`runtime control ${control} must remain unverified/disabled until live acceptance`);
  }
}
for (const target of ["authoritative_embedding", "public_api", "mcp", "commercial_use"]) {
  if (promotion.promotionTargets?.[target]?.allowed !== false) {
    failures.push(`promotion target ${target} must remain disabled`);
  }
  if (!promotion.promotionTargets?.[target]?.requires?.includes("explicitReleaseApproval")) {
    failures.push(`promotion target ${target} must require explicitReleaseApproval`);
  }
}

if (entitlements.schemaVersion !== "1.0.0" || entitlements.defaultDecision !== "deny") {
  failures.push("tenant entitlements must use schema 1.0.0 with default deny");
}
const forbiddenPurposes = new Set(["external_api", "mcp", "advertising", "dataset_export", "licensing"]);
for (const [tenantId, tenant] of Object.entries(entitlements.tenants ?? {})) {
  if (tenant?.environment === "production") failures.push(`${tenantId} must not have a production entitlement at G0`);
  if (tenant?.maxProviderAuthority !== "fixture") failures.push(`${tenantId} must remain fixture-authority only at G0`);
  for (const purpose of tenant?.allowedPurposes ?? []) {
    if (forbiddenPurposes.has(purpose)) failures.push(`${tenantId} must not receive external/commercial purpose ${purpose}`);
  }
  for (const providerId of tenant?.allowedProviderIds ?? []) {
    if (providerId !== "fixture") failures.push(`${tenantId} must not receive non-fixture provider runtime entitlement`);
  }
  for (const [quotaName, quotaValue] of Object.entries(tenant?.quotas ?? {})) {
    if (!Number.isSafeInteger(quotaValue) || quotaValue <= 0) failures.push(`${tenantId} quota ${quotaName} must be a positive safe integer`);
  }
}

const marengoAcceptance = providerAcceptance.providers?.["twelvelabs-marengo3"];
if (marengoAcceptance?.state !== "development_shadow_verified" || marengoAcceptance?.authority !== "shadow_only") {
  failures.push("Marengo must remain development_shadow_verified/shadow_only");
}
if (cascadeAcceptance.state !== "development_cascade_verified" || cascadeAcceptance.authority !== "development_cascade_only") {
  failures.push("derived-rights cascade acceptance must remain development-only verified evidence");
}
const marengoRegistry = (modelRegistry.providers ?? []).find((provider) => provider.id === "twelvelabs-marengo3");
if (marengoRegistry?.status !== "shadow") failures.push("model registry must keep Marengo status=shadow");
if (modelRegistry.defaultProviderId !== "fixture" || modelRegistry.externalProviderEgressAllowed !== false) {
  failures.push("fixture must remain the default provider and external provider egress must remain disabled");
}
if (publicContext.publicStatus !== "G0") failures.push("public product context must remain G0");
if (wrangler.vars?.TMG_PUBLIC_API_ENABLED !== "false" || wrangler.vars?.TMG_MCP_ENABLED !== "false") {
  failures.push("public API and MCP must remain disabled");
}
if (wrangler.vars?.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED !== "false") {
  failures.push("authoritative external-provider egress must remain disabled");
}
if (!String(pkg.scripts?.["marketing:check"] ?? "").includes("provider-promotion-policy-check.mjs")) {
  failures.push("marketing:check must enforce provider-promotion-policy-check.mjs");
}

if (failures.length > 0) {
  console.error("provider-promotion-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("provider-promotion-policy:check passed");
