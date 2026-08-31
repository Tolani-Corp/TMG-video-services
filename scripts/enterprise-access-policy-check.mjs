import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("config/enterprise-service.json", "utf8"));
const errors = [];
const fail = (message) => errors.push(message);

if (manifest.schemaVersion !== "tolani.enterprise-service.v1") fail("unexpected enterprise service schema");
if (manifest.serviceId !== "tmg-video") fail("serviceId must remain tmg-video");
if (manifest.productionAuthority !== false) fail("enterprise access adoption does not grant production authority");
if (manifest.gatewayBypassProtection?.required !== true) fail("gateway bypass protection is mandatory");
if (manifest.gatewayBypassProtection?.state === "VERIFIED" && !manifest.gatewayBypassProtection?.evidenceRef) {
  fail("verified bypass protection requires an evidenceRef");
}

for (const iface of manifest.interfaces ?? []) {
  if (iface.internal?.access !== "open-controlled") fail(`${iface.kind}: internal access must be open-controlled`);
  if (iface.internal?.billing !== "exempt") fail(`${iface.kind}: internal calls must be billing-exempt`);
  if (!iface.internal?.scope?.startsWith("tmg.video.")) fail(`${iface.kind}: exact TMG internal scope required`);
  if (iface.external?.access !== "paid-only") fail(`${iface.kind}: external production access must be paid-only`);
  if (iface.external?.billingAuthority !== "stripe") fail(`${iface.kind}: Stripe must remain the external billing authority`);
}

const expectedGroups = new Set([
  "tolani-external-starter",
  "tolani-external-pro",
  "tolani-external-enterprise"
]);
for (const group of manifest.externalConsumerGroups ?? []) expectedGroups.delete(group);
if (expectedGroups.size > 0) fail(`missing paid consumer groups: ${[...expectedGroups].join(",")}`);

if (errors.length > 0) {
  console.error("TMG enterprise access policy failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("TMG enterprise access policy validated: controlled internal access, paid external gate, no production authority.");
