import fs from "node:fs";

const failures = [];
const fail = (message) => failures.push(message);
const readJson = (path) => {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    return {};
  }
};

const design = readJson("config/production-release-authority.json");
const release = readJson("config/production-release-policy.json");
const promotion = readJson("config/provider-promotion-policy.json");
const wrangler = readJson("wrangler.jsonc");
const packageJson = readJson("package.json");

const expectedSourceSha = "4e62a9f042bb18110d954b37e4bcf7b4c3958e46";
const expectedFingerprint = "feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c";

if (design.schemaVersion !== "1.0.0") fail("release authority schemaVersion must remain 1.0.0");
if (design.status !== "design_only") fail("release authority must remain design_only until a separate implementation is reviewed");
if (design.issue !== 40) fail("release authority design must remain bound to Issue #40");
if (design.sourceMainSha !== expectedSourceSha) fail("release authority design source main SHA changed");
if (design.frozenInfrastructureFingerprintSha256 !== expectedFingerprint) fail("release authority design fingerprint changed");

const authority = design.authority ?? {};
for (const key of [
  "activationAuthorized",
  "deploymentMutationAuthorized",
  "routeMutationAuthorized",
  "publicTrafficAuthorized",
  "publicApiAuthorized",
  "mcpAuthorized",
  "ingestionAuthorized",
  "productionLedgerRuntimeAuthorized",
  "externalProviderEgressAuthorized",
  "providerPromotionAuthorized",
  "billingAuthorized",
  "commercialUseAuthorized",
]) {
  if (authority[key] !== false) fail(`release authority ${key} must remain false in design-only state`);
}

const model = design.releaseModel ?? {};
if (model.type !== "capability_scoped_human_approved" || model.defaultDecision !== "deny") {
  fail("release model must remain capability-scoped, human-approved, and default-deny");
}
for (const key of ["infrastructureExistenceGrantsAuthority", "acceptanceEvidenceGrantsAuthority", "successfulDeploymentGrantsAuthority"]) {
  if (model[key] !== false) fail(`${key} must remain false`);
}
if (model.stageApprovalGrantsOnlyNamedCapabilityAndStage !== true) fail("stage approval must grant only the named capability and stage");

const first = design.firstCapability ?? {};
const expectedFirst = {
  id: "tenant_authenticated_vector_search_canary_v1",
  implementationState: "not_implemented",
  purpose: "internal_search",
  tenantCohort: "production_canary_v1",
  defaultDeny: true,
  ingress: "separate_canary_ingress_required",
  reusePublicApiFlagAllowed: false,
  providerId: "fixture",
  maxProviderAuthority: "fixture",
  externalProviderEgressAllowed: false,
  marengoAuthority: "shadow_only",
  billingMode: "non_billable",
  commercialUseAllowed: false,
  mcpAllowed: false,
  ingestionAllowed: false,
  generalPublicApiAllowed: false,
};
for (const [key, value] of Object.entries(expectedFirst)) {
  if (first[key] !== value) fail(`first capability ${key} must equal ${JSON.stringify(value)}`);
}

const stages = design.canaryStages ?? [];
const expectedStages = [
  ["S0", 0, false, false],
  ["S1", 0, true, true],
  ["S2", 1, true, true],
  ["S3", 5, true, true],
  ["S4", 25, true, true],
  ["S5", 100, true, true],
];
if (stages.length !== expectedStages.length) {
  fail("release authority must define exactly S0-S5 canary stages");
} else {
  expectedStages.forEach(([id, percentage, overrideAllowed, approvalRequired], index) => {
    const stage = stages[index] ?? {};
    if (stage.id !== id) fail(`canary stage ${index} must be ${id}`);
    if (stage.normalTrafficPercentageMax !== percentage) fail(`${id} traffic ceiling must remain ${percentage}%`);
    if (stage.versionOverrideSmokeAllowed !== overrideAllowed) fail(`${id} version override policy changed`);
    if (stage.humanStageApprovalRequired !== approvalRequired) fail(`${id} human approval requirement changed`);
    if (stage.tenantAllowlistRequired !== true) fail(`${id} must remain tenant-allowlisted`);
  });
}

const transition = design.stageTransitionEvidence ?? {};
for (const key of [
  "exactProtectedMainShaRequired",
  "exactWorkerVersionIdRequired",
  "releaseManifestSha256Required",
  "qualitySuccessRequired",
  "productionReadinessSuccessRequired",
  "zeroUnexpectedInfrastructureDeltaRequired",
  "previousStageEvidenceRequired",
  "humanApprovalRequired",
  "noStorageMigrationRequiredForV1",
]) {
  if (transition[key] !== true) fail(`stage transition evidence ${key} must remain required`);
}

const guardrails = design.healthGuardrails ?? {};
if (guardrails.errorRateRollbackPercent !== 2) fail("v1 error-rate rollback threshold must remain 2%");
if (guardrails.latencyRollbackMultiplierVsAcceptedBaseline !== 2.5) fail("v1 latency rollback multiplier must remain 2.5x");
for (const key of ["zeroCrossTenantExposureRequired", "zeroRightsBoundaryViolationsRequired", "zeroUnauthorizedBillableEventsRequired"]) {
  if (guardrails[key] !== true) fail(`health guardrail ${key} must remain true`);
}
for (const required of [
  "authentication_bypass",
  "tenant_crossover",
  "entitlement_bypass",
  "denied_operation_side_effect",
  "rights_or_publication_boundary_violation",
  "quota_or_ledger_corruption",
  "unexpected_route_or_binding_drift",
  "unauthorized_provider_activity",
  "unauthorized_billing_activity",
  "unauthorized_commercial_activity",
]) {
  if (!guardrails.hardStopEvents?.includes(required)) fail(`hard-stop event ${required} is missing`);
}

const rollback = design.rollback ?? {};
const expectedRollbackOrder = [
  "fail_capability_closed",
  "revoke_canary_tenant_eligibility_and_credentials",
  "deny_or_remove_canary_ingress",
  "rollback_worker_to_last_known_good_version_at_100_percent",
  "run_read_only_reconciliation_and_production_readiness",
];
if (JSON.stringify(rollback.order) !== JSON.stringify(expectedRollbackOrder)) fail("rollback order changed");
for (const key of [
  "lastKnownGoodVersionMustBeRecordedBeforeStageMutation",
  "futureStorageMigrationRequiresSeparateRecoveryGate",
]) {
  if (rollback[key] !== true) fail(`rollback control ${key} must remain true`);
}
for (const key of [
  "storageStateRollbackAssumed",
  "durableObjectLifecycleOrSchemaMigrationAllowedInV1",
  "r2SchemaOrDestructiveMutationAllowedInV1",
  "vectorIndexDestructiveMutationAllowedInV1",
]) {
  if (rollback[key] !== false) fail(`rollback/storage control ${key} must remain false`);
}

const eligibility = design.tenantEligibility ?? {};
if (eligibility.defaultDecision !== "deny") fail("tenant eligibility must remain default-deny");
for (const key of [
  "productionIdentityEnabledRequired",
  "cryptographicAuthenticationRequired",
  "canonicalTenantBindingRequired",
  "explicitCanaryCohortRequired",
  "persistentQuotaRequired",
  "rightsPolicySatisfiedRequired",
]) {
  if (eligibility[key] !== true) fail(`tenant eligibility ${key} must remain required`);
}
if (eligibility.approvedPurposeRequired !== "internal_search") fail("tenant eligibility purpose must remain internal_search");
if (eligibility.providerIdRequired !== "fixture" || eligibility.maxProviderAuthorityRequired !== "fixture") fail("tenant eligibility must remain fixture-only");
if (eligibility.unresolvedIsolationReplayOrAbuseFindingAllowed !== false) fail("unresolved isolation/replay/abuse findings must block canary eligibility");
if (eligibility.billingModeRequired !== "non_billable" || eligibility.generalCommercialRepresentationAllowed !== false) fail("v1 canary must remain non-billable and non-commercial");

const provider = design.providerAuthority ?? {};
if (provider.authoritativeProviderId !== "fixture" || provider.marengoAuthority !== "shadow_only") fail("release-authority provider scope must remain fixture-only with Marengo shadow-only");
for (const key of ["externalProviderEgressAllowed", "authoritativeEmbeddingPromotionAllowed", "externalProviderCommercialClaimsAllowed"]) {
  if (provider[key] !== false) fail(`provider authority ${key} must remain false`);
}
if (provider.separateProviderAcceptanceAndPromotionRequired !== true) fail("external provider use must require separate acceptance and promotion");

const commercial = design.billingCommercialGates ?? {};
for (const key of [
  "firstCanaryBillable",
  "abuseControlsSatisfied",
  "billingMappingSatisfied",
  "publicApiReleaseAllowed",
  "mcpReleaseAllowed",
  "commercialReleaseAllowed",
  "invoiceableUsageEventsAllowed",
]) {
  if (commercial[key] !== false) fail(`billing/commercial gate ${key} must remain false`);
}
for (const required of [
  "abuse_controls_acceptance",
  "billing_mapping_acceptance",
  "usage_to_invoice_reconciliation",
  "dispute_and_refund_semantics",
  "explicit_commercial_release_approval",
]) {
  if (!commercial.futureBillingRequires?.includes(required)) fail(`future billing prerequisite ${required} is missing`);
}

const human = design.humanApproval ?? {};
if (human.required !== true || human.oneTime !== true || human.approvalMustBeHumanAuthored !== true) fail("human stage approval must remain required, one-time, and human-authored");
if (human.automationCanApprove !== false || human.replayAllowed !== false || human.staleOrBroaderApprovalAccepted !== false) fail("automation, replay, stale, or broader approvals must remain rejected");
for (const required of [
  "protected_main_sha",
  "worker_version_id",
  "release_manifest_sha256",
  "capability_id",
  "stage_id",
  "tenant_cohort_id",
  "not_after",
]) {
  if (!human.approvalMustBind?.includes(required)) fail(`human approval binding ${required} is missing`);
}
if (human.approvalMustStateNoOtherCapabilityAuthorized !== true) fail("human approval must explicitly limit authority to the named capability");

// Cross-check existing production policy remains fail-closed and evidence-only.
if (release.activationAllowed !== false || release.publicTrafficAllowed !== false) fail("existing production release policy must remain disabled");
for (const key of ["TMG_PUBLIC_API_ENABLED", "TMG_MCP_ENABLED", "TMG_INGEST_WORKFLOW_ENABLED", "TMG_TENANT_USAGE_LEDGER_ENABLED", "TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED"]) {
  if (release.runtimeFlags?.[key] !== "false") fail(`production runtime flag ${key} must remain false`);
}
if (release.runtimeFlags?.TMG_PROVIDER_ACCEPTANCE_STATE !== "unverified") fail("production provider acceptance runtime state must remain unverified");
if (release.requiredGates?.explicitReleaseApproval?.satisfied !== false) fail("explicit release approval must remain unsatisfied");
if (release.evidenceBindings?.tenantUsageLedgerAcceptance?.status !== "verified") fail("Runtime Acceptance v1 evidence must remain bound");
if (release.evidenceBindings?.tenantAuthenticationEntitlementAcceptance?.status !== "verified") fail("tenant auth/entitlement acceptance evidence must remain bound");

if (promotion.authoritativePromotionEnabled !== false) fail("authoritative provider promotion must remain disabled");
for (const target of ["authoritative_embedding", "public_api", "mcp", "commercial_use"]) {
  if (promotion.promotionTargets?.[target]?.allowed !== false) fail(`provider promotion target ${target} must remain disabled`);
}
if (promotion.runtimeEnforcement?.abuseControls !== false || promotion.runtimeEnforcement?.billingMapping !== false) {
  fail("abuse controls and billing mapping must remain unsatisfied blockers in this design increment");
}

const production = wrangler.env?.production ?? {};
if (production.workers_dev !== false) fail("production workers_dev must remain false");
if (production.routes !== undefined || production.route !== undefined || production.custom_domains !== undefined) fail("design-only increment must not add production routes or custom domains");
for (const key of ["TMG_PUBLIC_API_ENABLED", "TMG_MCP_ENABLED", "TMG_INGEST_WORKFLOW_ENABLED", "TMG_TENANT_USAGE_LEDGER_ENABLED", "TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED"]) {
  if (production.vars?.[key] !== "false") fail(`wrangler production ${key} must remain false`);
}
if (production.vars?.TMG_EMBEDDING_PROVIDER_ID !== "fixture") fail("wrangler production embedding provider must remain fixture");

if (!String(packageJson.scripts?.["marketing:check"] ?? "").includes("production-release-authority-policy:check")) {
  fail("marketing:check must enforce production-release-authority-policy:check");
}

if (failures.length) {
  console.error("production-release-authority-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("production-release-authority-policy:check passed");
