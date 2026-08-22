import fs from "node:fs";

const outDir = process.env.TMG_RUNTIME_ACCEPTANCE_OUT ?? "production-runtime-acceptance";
const before = JSON.parse(fs.readFileSync(`${outDir}/surface-before.json`, "utf8"));
const after = JSON.parse(fs.readFileSync(`${outDir}/surface-after.json`, "utf8"));

const same = (left, right, label) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`production runtime surface drift detected for ${label}`);
  }
};

for (const key of ["productionWorker", "r2", "vectorize", "workflows", "durableObjectNamespace", "routing"]) {
  same(before.state[key], after.state[key], key);
}

const result = {
  schemaVersion: "1.0.0",
  beforeSurfaceSha256: before.surfaceSha256,
  afterSurfaceSha256: after.surfaceSha256,
  zeroUnexpectedInfrastructureDelta: true,
  permittedMutation: "TenantUsageLedger acceptance-object SQLite rows only",
  publicAuthority: false,
  commercialAuthority: false,
};
fs.writeFileSync(`${outDir}/surface-comparison.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log("production runtime surface comparison passed: zero unexpected infrastructure delta");
