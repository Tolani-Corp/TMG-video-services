import fs from "node:fs";

const request = JSON.parse(fs.readFileSync("image-acceptance-request.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync("image-asset-manifest.json", "utf8"));
const review = JSON.parse(fs.readFileSync("image-campaign-review-package.json", "utf8"));

if (manifest.schemaVersion !== "tmg.image-asset-manifest.v1") throw new Error("unexpected image manifest schema");
if (review.schemaVersion !== "tmg.image-campaign-review-package.v1") throw new Error("unexpected image review package schema");
if (manifest.requestId !== request.requestId || review.requestId !== request.requestId) throw new Error("image request identity mismatch");
if (manifest.source.sha256 !== request.source.expectedSha256) throw new Error("source SHA evidence mismatch");
if (manifest.approvedLogo.sha256 !== request.logo.expectedSha256) throw new Error("logo SHA evidence mismatch");
if (manifest.rights.evidenceState !== "verified" || manifest.rights.logoOverlayAuthorized !== true) throw new Error("image rights evidence did not survive processing");
if (manifest.provenance.processor !== "cloudflare_images_binding") throw new Error("unexpected image processor provenance");
if (manifest.derivatives.length !== 4 || review.derivatives.length !== 4) throw new Error("expected four image derivatives");
if (manifest.governance.publicationAuthority !== false || review.publicationAuthority !== false) throw new Error("image runtime acquired publication authority");
if (manifest.governance.externalDistributionAuthority !== false || review.externalDistributionAuthority !== false) throw new Error("image runtime acquired distribution authority");
if (!manifest.derivatives.every((item) => item.exactApprovedLogoOverlayApplied === true)) throw new Error("approved logo overlay missing from derivative evidence");

const expected = new Map([
  ["tiktok.cover.v1", [1080, 1920]],
  ["youtube.thumbnail.v1", [1280, 720]],
  ["instagram.square.v1", [1080, 1080]],
  ["web.hero.v1", [1600, 900]],
]);
for (const item of manifest.derivatives) {
  const dimensions = expected.get(item.presetId);
  if (!dimensions || item.width !== dimensions[0] || item.height !== dimensions[1]) throw new Error(`unexpected dimensions for ${item.presetId}`);
  if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.bytes <= 0 || item.mimeType !== "image/webp") throw new Error(`invalid derivative evidence for ${item.presetId}`);
}

for (let index = 1; index <= 4; index += 1) {
  const bytes = fs.readFileSync(`image-output-${index}.webp`);
  if (bytes.length < 12 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw new Error(`image-output-${index}.webp is not a WebP artifact`);
  }
}

fs.writeFileSync("image-runtime-acceptance-evidence.json", JSON.stringify({
  schemaVersion: "tmg.image-runtime-acceptance-evidence.v1",
  requestId: request.requestId,
  sourceSha256: manifest.source.sha256,
  approvedLogoSha256: manifest.approvedLogo.sha256,
  presets: manifest.derivatives.map((item) => ({ presetId: item.presetId, sha256: item.sha256, bytes: item.bytes })),
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
}, null, 2) + "\n");

console.log("TMG Image Runtime acceptance evidence verified");
