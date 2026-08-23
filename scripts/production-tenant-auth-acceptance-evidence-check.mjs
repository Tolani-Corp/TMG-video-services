import fs from "node:fs";

const failures = [];
const fail = (message) => failures.push(message);
const policy = JSON.parse(fs.readFileSync("config/production-release-policy.json", "utf8"));
const evidence = policy.evidenceBindings?.tenantAuthenticationEntitlementAcceptance;

const expected = {
  status: "verified",
  target: "live_production",
  runId: "32618053032",
  commitSha: "aa4b482b38ca924e384f9abe8838b9cd9e0e6c90",
  frozenFingerprintSha256: "feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c",
  credentialAlgorithm: "Ed25519/EdDSA",
  artifactId: "9487551638",
  artifactZipSha256: "ea0097c076cab6f736e061dfea42db9a24d0f71e49eebb1863f7835ced5a37e5",
  evidencePackageSha256: "57fb494b00820c2c508c56c344f7e06b4d19c0c593fbffa3159398adeb7116b5",
  tenantAuthentication: "verified",
  canonicalTenantBinding: "verified",
  callerTenantOverride: "forbidden",
  tenantIsolation: "verified",
  entitlementGate: "verified",
  deniedOperationsSideEffectFree: true,
  persistentCredentialReplayRejection: "verified",
  zeroUnexpectedInfrastructureDelta: true,
  postAcceptanceReadinessRunId: "32618129969",
  postAcceptanceReadinessCommitSha: "aa4b482b38ca924e384f9abe8838b9cd9e0e6c90",
  postAcceptanceReadinessArtifactId: "9487566392",
  postAcceptanceReadinessArtifactZipSha256: "7cfcafcca5459fcf1d61847dbcbfbf08402ba0a632bb9eb5368ea671ed8a924d",
  mutationAuthority: false,
  activationAuthority: false,
  publicTrafficAuthority: false,
  providerPromotionAuthority: false,
  billingAuthority: false,
  commercialAuthority: false
};

if (!evidence) {
  fail("tenantAuthenticationEntitlementAcceptance evidence binding is missing");
} else {
  for (const [key, value] of Object.entries(expected)) {
    if (evidence[key] !== value) {
      fail(`tenantAuthenticationEntitlementAcceptance.${key} must equal ${JSON.stringify(value)}`);
    }
  }
}

const runtimeEvidence = policy.evidenceBindings?.tenantUsageLedgerAcceptance;
if (runtimeEvidence?.status !== "verified" || runtimeEvidence?.runId !== "32606309623" || runtimeEvidence?.zeroUnexpectedInfrastructureDelta !== true) {
  fail("accepted TenantUsageLedger runtime evidence must remain bound before tenant auth evidence can remain valid");
}

const gate = policy.requiredGates?.tenantAuthenticationEntitlementAcceptance;
if (gate?.required !== true || gate?.satisfied !== false) {
  fail("tenantAuthenticationEntitlementAcceptance must remain required and unsatisfied; verified evidence alone is not release or activation authority");
}

if (policy.activationAllowed !== false || policy.publicTrafficAllowed !== false) {
  fail("production activation and public traffic must remain disabled after tenant auth evidence binding");
}

for (const [key, expectedValue] of Object.entries({
  TMG_PUBLIC_API_ENABLED: "false",
  TMG_MCP_ENABLED: "false",
  TMG_INGEST_WORKFLOW_ENABLED: "false",
  TMG_TENANT_USAGE_LEDGER_ENABLED: "false",
  TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false",
  TMG_PROVIDER_ACCEPTANCE_STATE: "unverified"
})) {
  if (policy.runtimeFlags?.[key] !== expectedValue) {
    fail(`runtime flag ${key} must remain ${expectedValue}`);
  }
}

if (policy.providerAuthority?.defaultProviderId !== "fixture") fail("fixture must remain the default production provider");
if (policy.providerAuthority?.marengoAuthority !== "shadow_only") fail("Marengo must remain shadow_only");
for (const key of ["externalProviderEgressAllowed", "authoritativePromotionAllowed", "commercialUseAllowed"]) {
  if (policy.providerAuthority?.[key] !== false) fail(`providerAuthority.${key} must remain false`);
}
if (policy.requiredGates?.explicitReleaseApproval?.satisfied !== false) {
  fail("explicit release approval must remain unsatisfied");
}

if (failures.length) {
  console.error("production-tenant-auth-acceptance-evidence:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("production-tenant-auth-acceptance-evidence:check passed");
