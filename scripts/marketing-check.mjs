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

if (failures.length > 0) {
  console.error("marketing:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("marketing:check passed");
