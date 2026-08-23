import fs from "node:fs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const input = process.argv[2] ?? "production-release-control/deployment-status.json";
const payload = JSON.parse(fs.readFileSync(input, "utf8"));
const candidate = required("TMG_RELEASE_CANDIDATE_VERSION_ID");
const lkg = required("TMG_RELEASE_LKG_VERSION_ID");

const findVersions = (value) => {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.versions) && value.versions.length > 0) {
    const normalized = value.versions.map((item) => ({
      id: item.version_id ?? item.versionId ?? item.id,
      percentage: Number(item.percentage ?? item.traffic_percentage ?? item.trafficPercentage),
    }));
    if (normalized.every((item) => typeof item.id === "string" && Number.isFinite(item.percentage))) return normalized;
  }
  for (const nested of Object.values(value)) {
    const found = findVersions(nested);
    if (found) return found;
  }
  return null;
};

const versions = findVersions(payload);
if (!versions) throw new Error("unable to locate deployment versions in Wrangler JSON output");
if (versions.length !== 2) throw new Error(`S1 must contain exactly two versions, found ${versions.length}`);
const candidateEntry = versions.find((item) => item.id === candidate);
const lkgEntry = versions.find((item) => item.id === lkg);
if (!candidateEntry || candidateEntry.percentage !== 0) throw new Error("candidate version must be present at exactly 0% normal traffic");
if (!lkgEntry || lkgEntry.percentage !== 100) throw new Error("last-known-good version must remain at exactly 100% normal traffic");
if (versions.some((item) => ![candidate, lkg].includes(item.id))) throw new Error("unexpected Worker version present in S1 deployment");

console.log(`verified S1 deployment: candidate=${candidate}@0% lkg=${lkg}@100%`);
