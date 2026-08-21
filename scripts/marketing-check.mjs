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

const context = readJson("config/public-product-context.json");
const binding = readJson("config/ecosystem-policy-binding.json");
const retrieval = readJson("config/retrieval-policy.json");
const providers = readJson("config/model-compatibility-registry.json");
const wrangler = readJson("wrangler.jsonc");
const fixture = readJson("fixtures/harmless/control.json");

for (const key of [
  "schemaVersion",
  "entityId",
  "classification",
  "publicStatus",
  "commercialAuthority",
  "primaryCTA",
  "operationalHandoff",
  "analytics",
  "contentOwner",
  "evidenceOwner",
]) {
  if (!context[key]) failures.push(`public-product-context: missing ${key}`);
}

if (!new Set(["G0", "G1", "G2", "G3", "G4"]).has(context.publicStatus)) {
  failures.push(`public-product-context: invalid publicStatus ${context.publicStatus}`);
}

if (context.reviewExpiresAt && Date.parse(context.reviewExpiresAt) < Date.now()) {
  failures.push("public-product-context: review expired");
}

if (context.publicStatus === "G0") {
  if (context.canonicalDomain) failures.push("G0 repository must not declare a canonical public domain");
  for (const offer of context.offers ?? []) {
    if (offer.status !== "internal_only") failures.push(`G0 offer ${offer.id} must be internal_only`);
  }
  if ((context.approvedClaims ?? []).length > 0) {
    failures.push("G0 repository must not contain approved public claims");
  }
  for (const flag of ["TMG_PUBLIC_API_ENABLED", "TMG_MCP_ENABLED", "TMG_INGEST_WORKFLOW_ENABLED"]) {
    if (wrangler.vars?.[flag] !== "false") failures.push(`G0 default ${flag} must remain false`);
  }
  if (wrangler.vars?.TMG_INGESTION_MODE !== "fixture_only") {
    failures.push("G0 ingestion mode must remain fixture_only");
  }
  if (wrangler.vars?.TMG_EMBEDDING_PROVIDER_ID !== "fixture") {
    failures.push("G0 default embedding provider must remain fixture");
  }
  if (wrangler.vars?.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED !== "false") {
    failures.push("G0 external provider egress must remain disabled");
  }
  if (wrangler.vars?.TMG_PROVIDER_ACCEPTANCE_STATE !== "unverified") {
    failures.push("G0 provider acceptance state must remain unverified until acceptance evidence is explicitly promoted");
  }
}

if (!context.primaryCTA?.owner || !context.primaryCTA?.downstreamState || !context.primaryCTA?.event) {
  failures.push("primary CTA missing owner/downstreamState/event");
}

if (binding.canonicalPortfolioAuthority !== "Tolani-Corp/TolaniCorp-HQ") {
  failures.push("ecosystem policy binding must point to Tolani-Corp/TolaniCorp-HQ");
}

if (binding.currentPublicStatus !== context.publicStatus) {
  failures.push("ecosystem policy binding public status must match local public context");
}

if (context.publicStatus === "G0" && (binding.externalPublicationAllowed || binding.commercializationAllowed)) {
  failures.push("G0 ecosystem policy binding cannot allow publication or commercialization");
}

if (retrieval.defaultDecision !== "deny") {
  failures.push("retrieval policy must remain deny-by-default");
}

for (const purpose of ["external_api", "mcp", "advertising", "dataset_export", "licensing"]) {
  const rule = retrieval.purposes?.[purpose];
  if (!rule?.requiresVerifiedRightsEvidence || !rule?.requiresApprovedPublicationState || !rule?.requiresExplicitPurposeGrant) {
    failures.push(`${purpose}: external/commercial retrieval must require verified rights, approved publication, and explicit purpose grant`);
  }
}

if (providers.defaultProviderId !== "fixture") {
  failures.push("model registry default provider must remain fixture at G0");
}
if (providers.externalProviderEgressAllowed !== false) {
  failures.push("model registry external provider egress must remain false at G0");
}
const fixtureProvider = (providers.providers ?? []).find((provider) => provider.id === "fixture");
if (!fixtureProvider || fixtureProvider.status !== "enabled" || fixtureProvider.egressClass !== "none") {
  failures.push("fixture provider must remain enabled and no-egress");
}
for (const provider of providers.providers ?? []) {
  if (provider.id !== "fixture" && provider.status === "enabled") {
    failures.push(`external/non-fixture provider ${provider.id} cannot be enabled at G0`);
  }
}

const marengoProvider = (providers.providers ?? []).find(
  (provider) => provider.id === "twelvelabs-marengo3",
);
if (
  !marengoProvider ||
  marengoProvider.status !== "shadow" ||
  marengoProvider.egressClass !== "external" ||
  marengoProvider.acceptanceRequirement !== "development_acceptance"
) {
  failures.push("Marengo 3.0 must remain shadow-only, external-egress, and development-acceptance gated at G0");
}
if (marengoProvider?.profile?.compatibilityGroup === fixtureProvider?.profile?.compatibilityGroup) {
  failures.push("Marengo and deterministic fixture embeddings must never share a compatibility group");
}
const marengoGroup = (providers.compatibilityGroups ?? []).find(
  (group) => group.id === marengoProvider?.profile?.compatibilityGroup,
);
if (!marengoGroup || marengoGroup.vectorIndexBinding === "VIDEO_INDEX") {
  failures.push("Marengo must use a reserved, isolated Vectorize binding rather than the fixture VIDEO_INDEX");
}

if (fixture.manifest?.source?.sourceClass !== "fixture") {
  failures.push("harmless fixture must remain sourceClass=fixture");
}
if (fixture.manifest?.publicationState !== "review") {
  failures.push("harmless fixture must remain publicationState=review");
}
if (fixture.rights?.evidenceState !== "verified") {
  failures.push("harmless fixture must retain explicit fixture evidence");
}
for (const [grant, value] of Object.entries(fixture.rights?.grants ?? {})) {
  if (value !== false) failures.push(`harmless fixture grant ${grant} must remain false`);
}

if (failures.length > 0) {
  console.error("marketing:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("marketing:check passed");
