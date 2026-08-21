import fs from "node:fs";

const workflow = fs.readFileSync(".github/workflows/derived-rights-cascade.yml", "utf8");
const script = fs.readFileSync("scripts/derived-rights-cascade.mjs", "utf8");
const wrangler = fs.readFileSync("wrangler.jsonc", "utf8");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const acceptance = JSON.parse(fs.readFileSync("config/derived-rights-cascade-acceptance.json", "utf8"));
const providerRegistry = JSON.parse(fs.readFileSync("config/provider-acceptance-registry.json", "utf8"));

const fail = (message) => {
  console.error(`derived-rights-cascade-policy: ${message}`);
  process.exit(1);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};

if (!workflow.includes("workflow_dispatch:")) fail("workflow must be manual-only");
if (/\n\s*(push|pull_request|schedule):/.test(workflow)) fail("cascade workflow must not have automatic triggers");
if (!workflow.includes("environment: development")) fail("cascade must use development environment");
if (!workflow.includes("plan_id:")) fail("immutable materialization plan ID must be explicit");
if (!workflow.includes("reason:")) fail("cascade reason must be explicit");
if (/r2 object delete/.test(workflow)) fail("cascade must preserve R2 media/control evidence");
if (!script.includes("/delete_by_ids")) fail("cascade must use exact Vectorize deletion by ID");
if (!script.includes('evidenceState: "revoked"')) fail("cascade must revoke child rights before cleanup");
if (!script.includes("development_cascade_only")) fail("cascade authority marker missing");
if (!wrangler.includes('"TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED": "false"')) fail("authoritative external provider egress must remain disabled");
if (!wrangler.includes('"TMG_PUBLIC_API_ENABLED": "false"') || !wrangler.includes('"TMG_MCP_ENABLED": "false"')) fail("public API/MCP must remain disabled");
if (!String(pkg.scripts?.["marketing:check"] ?? "").includes("derived-rights-cascade-policy-check.mjs")) fail("marketing:check must enforce cascade policy");

assert(acceptance.schemaVersion === "1.0.0", "acceptance schema version must remain 1.0.0");
assert(acceptance.state === "development_cascade_verified", "acceptance state must remain development_cascade_verified");
assert(acceptance.authority === "development_cascade_only", "acceptance must not grant authority beyond development cascade");

const evidence = acceptance.evidence ?? {};
assert(evidence.repository === "Tolani-Corp/TMG-video-services", "acceptance repository mismatch");
assert(evidence.acceptancePr === 11, "acceptance PR must remain #11");
assert(evidence.headSha === "88c7cfa23c60cbe549d0f252dbe8815ec782a27b", "acceptance head SHA mismatch");
assert(evidence.mergeCommitSha === "45269255ceb4d1d42bb7ea4056cd4611ce97a6e7", "acceptance merge commit mismatch");
assert(evidence.workflowRunId === 32502061624, "acceptance workflow run mismatch");
assert(evidence.artifactId === 9454136044, "acceptance artifact ID mismatch");
assert(evidence.artifactName === "tmg-derived-rights-cascade-acceptance-32502061624", "acceptance artifact name mismatch");
assert(evidence.artifactDigest === "sha256:4aad5e7e2a8bcda593c33e5f57af42e65c14be8c0c96e79454deb497b3b06ed0", "acceptance artifact digest mismatch");
assert(evidence.artifactExpiresAt === "2026-11-19T16:16:18Z", "acceptance artifact expiry must be explicit");
assert(evidence.r2EvidenceBucket === "tmg-cascade-accept-32502061624", "preserved R2 evidence bucket mismatch");
assert(evidence.isolatedVectorIndex === "tmg-cascade-accept-32502061624", "isolated Vectorize index mismatch");
assert(evidence.vectorIndexCleanupVerified === true, "isolated Vectorize cleanup must remain verified");
assert(evidence.acceptedAt === "2026-08-21T16:24:59.787Z", "acceptance timestamp mismatch");

const plan = acceptance.plan ?? {};
assert(plan.planId === "tsp_4647e174e110bdb71a34ba6925e5c79141da9e92", "accepted immutable plan mismatch");
assert(plan.parentAssetId === "harmless_temporal_parent_001", "accepted parent asset mismatch");
assert(plan.parentSha256 === "953f70eee561caeaa321e02cfa49f5f43807934c7f26c9243333a0979ccc9705", "accepted parent SHA mismatch");
assert(plan.materializedRightsRevision === 1 && plan.changedRightsRevision === 2, "accepted parent rights transition must remain 1 -> 2");

const proof = acceptance.proof ?? {};
assert(proof.childCount === 3, "accepted child count must remain three");
assert(proof.revokedChildRights === 3, "all three child rights records must be revoked");
assert(proof.deletedShadowVectors === 3, "all three shadow vectors must be deleted");
assert(proof.postDeleteVectorCount === 0, "accepted post-delete vector count must remain zero");
assert(proof.preservedChildMedia === 3, "all three child media objects must remain preserved");
assert(proof.preservedLineageRecords === 3, "all three lineage records must remain preserved");
assert(Array.isArray(proof.deleteMutationIds) && proof.deleteMutationIds.length === 3, "three delete mutation IDs are required");
assert(new Set(proof.deleteMutationIds).size === 3, "delete mutation IDs must be distinct");
for (const mutationId of proof.deleteMutationIds) {
  assert(typeof mutationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mutationId), "invalid Vectorize delete mutation ID");
}

const promotion = acceptance.promotion ?? {};
for (const key of ["authoritativeRoutingAllowed", "publicApiAllowed", "mcpAllowed", "commercialUseAllowed", "automaticCascadeAllowed"]) {
  assert(promotion[key] === false, `${key} must remain false`);
}
assert(promotion.requiresExplicitReleaseApproval === true, "explicit release approval must remain required");

const marengo = providerRegistry.providers?.["twelvelabs-marengo3"];
assert(marengo?.state === "development_shadow_verified", "Marengo provider must remain development-shadow verified only");
assert(marengo?.authority === "shadow_only", "Marengo provider authority must remain shadow_only");
assert(marengo?.promotion?.authoritativeRoutingAllowed === false, "Marengo authoritative routing must remain disabled");
assert(marengo?.promotion?.publicApiAllowed === false, "Marengo public API authority must remain disabled");
assert(marengo?.promotion?.mcpAllowed === false, "Marengo MCP authority must remain disabled");
assert(marengo?.promotion?.commercialUseAllowed === false, "Marengo commercial authority must remain disabled");
assert(marengo?.promotion?.requiresExplicitReleaseApproval === true, "Marengo promotion must still require explicit release approval");

console.log("derived-rights-cascade-policy:check passed");
