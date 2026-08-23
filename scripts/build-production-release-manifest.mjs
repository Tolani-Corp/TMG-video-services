import crypto from "node:crypto";
import fs from "node:fs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const outDir = process.env.TMG_RELEASE_OUT ?? "production-release-control";
fs.mkdirSync(outDir, { recursive: true });

const candidateMainSha = required("TMG_RELEASE_CANDIDATE_SHA");
const candidateWorkerVersionId = required("TMG_RELEASE_CANDIDATE_VERSION_ID");
const lastKnownGoodWorkerVersionId = required("TMG_RELEASE_LKG_VERSION_ID");
const workflowRunId = required("GITHUB_RUN_ID");
if (!/^[0-9a-f]{40}$/.test(candidateMainSha)) throw new Error("candidate main SHA must be a full lowercase git SHA");
if (candidateWorkerVersionId === lastKnownGoodWorkerVersionId) throw new Error("candidate version must differ from last-known-good version");

const policyBytes = fs.readFileSync("config/production-release-authority.json");
const policySha256 = crypto.createHash("sha256").update(policyBytes).digest("hex");

const manifest = {
  schemaVersion: "1.0.0",
  targetEnvironment: "production",
  candidateMainSha,
  workerName: "tmg-video-services-production",
  candidateWorkerVersionId,
  lastKnownGoodWorkerVersionId,
  capabilityId: "tenant_authenticated_vector_search_canary_v1",
  maxStage: "S1",
  tenantCohortId: "production_canary_v1",
  normalTrafficPercentage: 0,
  frozenInfrastructureFingerprintSha256: "feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c",
  releaseAuthorityPolicySha256: policySha256,
  providerId: "fixture",
  providerAuthority: "fixture",
  billingMode: "non_billable",
  publicAuthority: false,
  storageMigrationAllowed: false,
  createdByWorkflowRunId: workflowRunId,
};

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
const digest = crypto.createHash("sha256").update(serialized).digest("hex");
fs.writeFileSync(`${outDir}/release-manifest.json`, serialized, { flag: "wx" });
fs.writeFileSync(`${outDir}/release-manifest.sha256`, `${digest}  release-manifest.json\n`, { flag: "wx" });
console.log(digest);
