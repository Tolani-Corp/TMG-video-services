import fs from "node:fs";

const input = process.argv[2] ?? "production-release-control/deployment-status-before.json";
const payload = JSON.parse(fs.readFileSync(input, "utf8"));

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
if (!versions) throw new Error("unable to locate active deployment versions");
if (versions.length !== 1 || versions[0].percentage !== 100) {
  throw new Error(`S0 requires exactly one last-known-good version at 100%; found ${JSON.stringify(versions)}`);
}
process.stdout.write(`${versions[0].id}\n`);
