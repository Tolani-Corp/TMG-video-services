import crypto from "node:crypto";
import fs from "node:fs";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes) {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

const request = readJson("storyboard-context-request.json");
const context = readJson("storyboard-campaign-context.json");
const brief = readJson("storyboard-creative-brief.json");
const review = readJson("storyboard-review-package.json");

assert(request.finalStatus === "completed", "context request must complete");
assert(context.schemaVersion === "tmg.campaign-context.v1", "campaign context schema mismatch");
assert(brief.schemaVersion === "tmg.marketing-creative-brief.v1", "creative brief schema mismatch");
assert(review.schemaVersion === "tmg.marketing-storyboard-review-package.v1", "storyboard review schema mismatch");
assert(review.requestId === request.requestId, "storyboard review request identity mismatch");
assert(review.tenantId === "storyboard_acceptance", "storyboard review tenant mismatch");
assert(review.creativeBriefKey === request.creativeBriefKey, "storyboard creative brief key mismatch");
assert(review.renderer?.provider === "cloudflare_workers_ai", "storyboard renderer provider mismatch");
assert(review.renderer?.model === "@cf/black-forest-labs/flux-1-schnell", "storyboard renderer model mismatch");
assert(review.renderer?.generationMode === "storyboard_keyframe", "storyboard generation mode mismatch");
assert(review.renderer?.freeNeuronPreview === true, "storyboard free-neuron marker missing");
assert(review.humanReviewRequired === true, "storyboard review must require human review");
assert(review.publicationAuthority === false, "storyboard review cannot receive publication authority");
assert(review.externalDistributionAuthority === false, "storyboard review cannot receive external distribution authority");
assert(brief.contextQuality?.generationEligible === true, "creative brief must be generation eligible");
assert(Number(brief.contextQuality?.score) >= 45, "creative brief context quality is below generation threshold");
assert(Array.isArray(brief.variants) && brief.variants.length === 3, "expected exactly three creative variants");
assert(Array.isArray(review.frames) && review.frames.length === 3, "expected exactly three storyboard frames");

const expectedProfiles = new Set(["tiktok.organic.v1", "youtube.short.v1", "web.hero.v1"]);
const actualProfiles = new Set(review.frames.map((frame) => frame.targetProfileId));
for (const profile of expectedProfiles) {
  assert(actualProfiles.has(profile), `missing storyboard target profile ${profile}`);
}

const verifiedFrames = [];
for (let index = 0; index < review.frames.length; index += 1) {
  const frame = review.frames[index];
  const path = `storyboard-frame-${index + 1}.bin`;
  const bytes = fs.readFileSync(path);
  assert(frame.schemaVersion === "tmg.marketing-storyboard-frame.v1", `frame ${index + 1} schema mismatch`);
  assert(frame.provider === "cloudflare_workers_ai", `frame ${index + 1} provider mismatch`);
  assert(frame.model === "@cf/black-forest-labs/flux-1-schnell", `frame ${index + 1} model mismatch`);
  assert(frame.generationMode === "storyboard_keyframe", `frame ${index + 1} generation mode mismatch`);
  assert(frame.renderPhase === "preview", `frame ${index + 1} render phase mismatch`);
  assert(frame.humanReviewRequired === true, `frame ${index + 1} must require human review`);
  assert(frame.publicationAuthority === false, `frame ${index + 1} cannot receive publication authority`);
  assert(frame.externalDistributionAuthority === false, `frame ${index + 1} cannot receive external distribution authority`);
  assert(bytes.length === frame.bytes, `frame ${index + 1} byte count mismatch`);
  const digest = sha256(bytes);
  assert(digest === frame.sha256, `frame ${index + 1} SHA-256 mismatch`);
  if (frame.contentType === "image/jpeg") {
    assert(isJpeg(bytes), `frame ${index + 1} is not a valid JPEG payload`);
  } else if (frame.contentType === "image/png") {
    assert(isPng(bytes), `frame ${index + 1} is not a valid PNG payload`);
  } else {
    throw new Error(`frame ${index + 1} has unsupported content type ${String(frame.contentType)}`);
  }
  verifiedFrames.push({
    variantId: frame.variantId,
    targetProfileId: frame.targetProfileId,
    objectKey: frame.objectKey,
    contentType: frame.contentType,
    bytes: frame.bytes,
    sha256: frame.sha256,
  });
}

const evidence = {
  schemaVersion: "tmg.marketing-storyboard-acceptance-evidence.v1",
  requestId: request.requestId,
  contextQualityScore: brief.contextQuality.score,
  renderer: review.renderer,
  verifiedFrames,
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
};
fs.writeFileSync(
  "storyboard-runtime-acceptance-evidence.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence));
