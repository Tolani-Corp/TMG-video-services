import crypto from "node:crypto";
import fs from "node:fs";

const outDir = process.env.TMG_RUNTIME_ACCEPTANCE_OUT ?? "production-runtime-acceptance";
const beforeEnvelope = JSON.parse(fs.readFileSync(`${outDir}/surface-before.json`, "utf8"));
const afterEnvelope = JSON.parse(fs.readFileSync(`${outDir}/surface-after.json`, "utf8"));
const before = beforeEnvelope.state ?? beforeEnvelope;
const after = afterEnvelope.state ?? afterEnvelope;

const same = (left, right, label) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`production runtime surface drift detected for ${label}`);
  }
};

for (const key of ["productionWorker", "r2", "vectorize", "workflows", "durableObjectNamespace", "routing"]) {
  same(before[key], after[key], key);
}

const canonicalHash = (value) => crypto.createHash("sha256").update(`${JSON.stringify(value)}\n`).digest("hex");
const beforeSurfaceSha256 = beforeEnvelope.surfaceSha256 ?? canonicalHash(before);
const afterSurfaceSha256 = afterEnvelope.surfaceSha256 ?? canonicalHash(after);

const result = {
  schemaVersion: "1.0.0",
  beforeSurfaceSha256,
  afterSurfaceSha256,
  zeroUnexpectedInfrastructureDelta: true,
  permittedMutation: "TenantUsageLedger acceptance-object SQLite rows only",
  publicAuthority: false,
  commercialAuthority: false,
};
fs.writeFileSync(`${outDir}/surface-comparison.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log("production runtime surface comparison passed: zero unexpected infrastructure delta");
