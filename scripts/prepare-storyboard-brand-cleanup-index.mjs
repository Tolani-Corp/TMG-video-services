import fs from "node:fs";

const request = JSON.parse(fs.readFileSync("storyboard-brand-request.json", "utf8"));
const brief = JSON.parse(fs.readFileSync("storyboard-brand-creative-brief.json", "utf8"));
const fixture = JSON.parse(fs.readFileSync("storyboard-brand-fixture-index.json", "utf8"));

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160);
}

function intents(variant) {
  if (variant.target.platform === "youtube" && /short/i.test(variant.target.surface)) {
    return ["hook", "problem", "product_showcase", "cta"];
  }
  if (variant.target.platform === "website" || variant.target.platform === "web_app") {
    return ["product_showcase", "feature_value", "cta"];
  }
  return ["hook", "product_showcase", "cta"];
}

const root = `tenants/${request.tenantId}/production-requests/${request.requestId}/outputs/marketing/storyboard-brand-v1-1`;
const keys = new Set();

keys.add(fixture.sourceManifestKey);
keys.add(fixture.creativeBriefKey);
keys.add(`tenants/${request.tenantId}/image-runtime/${request.requestId}/control/image-asset-manifest-v1.1.json`);
keys.add(`${root}/control/storyboard-manifest-v1.1.json`);
keys.add(`${root}/handoff/video-render-plan-v1.json`);
keys.add(`${root}/review/storyboard-brand-review-package-v1.1.json`);
keys.add(fixture.files.source.objectKey);
keys.add(fixture.files.logo.objectKey);
for (const derivative of fixture.files.derivatives) keys.add(derivative.objectKey);

for (const variant of brief.variants) {
  const variantId = safeSegment(variant.variantId);
  const shotIntents = intents(variant);
  for (let index = 0; index < shotIntents.length; index += 1) {
    const shotId = safeSegment(`${String(index + 1).padStart(2, "0")}-${shotIntents[index]}`);
    const shotRoot = `${root}/targets/${variantId}/shots/${shotId}`;
    keys.add(`${shotRoot}/generated.jpg`);
    keys.add(`${shotRoot}/generated.png`);
    keys.add(`${shotRoot}/composed.webp`);
  }
  keys.add(`${root}/targets/${variantId}/cards/title.webp`);
  keys.add(`${root}/targets/${variantId}/cards/end.webp`);
}

fs.writeFileSync("storyboard-brand-cleanup-index.txt", [...keys].join("\n") + "\n");
console.log(JSON.stringify({ cleanupObjectCount: keys.size }));
