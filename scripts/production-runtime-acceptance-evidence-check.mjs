import fs from "node:fs";

const failures = [];
const fail = (message) => failures.push(message);
const policy = JSON.parse(fs.readFileSync("config/production-release-policy.json", "utf8"));
const evidence = policy.evidenceBindings?.tenantUsageLedgerAcceptance;

const expected = {
  status: "verified",
  target: "live_production",
  runId: "32606309623",
  commitSha: "6d270c4756a00930988e4cbbd4495fc5ca7ca5fa",
  frozenFingerprintSha256: "feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c",
  acceptanceTenant: "prod_acceptance_fixture_v1",
  durableObjectNamespaceId: "737c0b2361c2407ba3c765bcb269504f",
  artifactId: "9484215245",
  artifactZipSha256: "7f7c51de551e30d436b820dc00a1bcf94dc7ad6ba1829813755cb21fa9dd5f1e",
  evidencePackageSha256: "d125b05b017a5d15d3601cddcae8553755ee4725c8befdb44c9e12722ac3e59b",
  tenantIsolation: "verified",
  idempotency: "verified",
  quotaBeforeInsert: "verified",
  utcWindows: "verified",
  sessionPersistence: "verified",
  zeroUnexpectedInfrastructureDelta: true,
  postAcceptanceReadinessRunId: "32606382461",
  postAcceptanceReadinessCommitSha: "6d270c4756a00930988e4cbbd4495fc5ca7ca5fa",
  mutationAuthority: false,
  activationAuthority: false,
  publicTrafficAuthority: false,
  providerPromotionAuthority: false,
  billingAuthority: false,
  commercialAuthority: false
};

if (!evidence) {
  fail("tenantUsageLedgerAcceptance evidence binding is missing");
} else {
  for (const [key, value] of Object.entries(expected)) {
    if (evidence[key] !== value) {
      fail(`tenantUsageLedgerAcceptance.${key} must equal ${JSON.stringify(value)}`);
    }
  }
}

const gate = policy.requiredGates?.tenantUsageLedgerAcceptance;
if (gate?.required !== true || gate?.satisfied !== false) {
  fail("tenantUsageLedgerAcceptance must remain required and unsatisfied; verified evidence alone is not runtime activation authority");
}
if (policy.activationAllowed !== false || policy.publicTrafficAllowed !== false) {
  fail("production activation and public traffic must remain disabled after evidence binding");
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
  console.error("production-runtime-acceptance-evidence:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("production-runtime-acceptance-evidence:check passed");
