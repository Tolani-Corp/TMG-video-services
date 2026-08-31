import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha(path) {
  return sha256(fs.readFileSync(path));
}

function isSha(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function assertWebp(path, label) {
  const bytes = fs.readFileSync(path);
  assert(bytes.length > 20, `${label} is unexpectedly small`);
  assert(bytes.subarray(0, 4).toString("ascii") === "RIFF", `${label} missing RIFF signature`);
  assert(bytes.subarray(8, 12).toString("ascii") === "WEBP", `${label} missing WEBP signature`);
}

function assertGeneratedImage(path, contentType, label) {
  const bytes = fs.readFileSync(path);
  if (contentType === "image/jpeg") {
    assert(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, `${label} missing JPEG signature`);
    return;
  }
  if (contentType === "image/png") {
    assert(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, `${label} missing PNG signature`);
    return;
  }
  throw new Error(`${label} has unsupported declared content type ${contentType}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").slice(0, 4000)}`);
  }
  return result.stdout;
}

const sourceManifest = readJson("storyboard-brand-image-manifest.json");
const enhanced = readJson("storyboard-brand-enhanced-image-manifest.json");
const manifest = readJson("storyboard-brand-manifest.json");
const renderPlan = readJson("storyboard-brand-video-render-plan.json");
const review = readJson("storyboard-brand-review-package.json");
const motion = readJson("storyboard-brand-motion-preview-evidence.json");
const fixtureIndex = readJson("storyboard-brand-fixture-index.json");

assert(sourceManifest.schemaVersion === "tmg.image-asset-manifest.v1", "source ImageAssetManifest schema mismatch");
assert(enhanced.schemaVersion === "tmg.image-asset-manifest.v1.1", "enhanced ImageAssetManifest schema mismatch");
assert(manifest.schemaVersion === "tmg.storyboard-manifest.v1.1", "StoryboardManifest schema mismatch");
assert(renderPlan.schemaVersion === "tmg.video-render-plan.v1", "VideoRenderPlan schema mismatch");
assert(review.schemaVersion === "tmg.storyboard-brand-review-package.v1.1", "review package schema mismatch");
assert(motion.schemaVersion === "tmg.storyboard-brand-motion-preview-evidence.v1.1", "motion evidence schema mismatch");

assert(enhanced.requestId === sourceManifest.requestId && manifest.requestId === sourceManifest.requestId, "request identity mismatch");
assert(enhanced.tenantId === sourceManifest.tenantId && manifest.tenantId === sourceManifest.tenantId, "tenant identity mismatch");
assert(enhanced.sourceManifest.objectKey === fixtureIndex.sourceManifestKey, "enhanced manifest source key mismatch");
assert(enhanced.sourceManifest.sha256 === fileSha("storyboard-brand-image-manifest.json"), "enhanced manifest source SHA mismatch");
assert(enhanced.composition.exactApprovedLogoRequired === true, "exact approved logo is not mandatory");
assert(enhanced.composition.exactProductAssetUseRequiresAuthorizedDerivative === true, "product asset authorization gate missing");
assert(enhanced.rights.evidenceState === "verified", "enhanced image rights are not verified");
assert(enhanced.rights.sourceReuseAuthorized === true && enhanced.rights.logoOverlayAuthorized === true, "enhanced image reuse grants missing");
assert(enhanced.governance.humanReviewRequired === true, "enhanced manifest human review missing");
assert(enhanced.governance.publicationAuthority === false && enhanced.governance.externalDistributionAuthority === false, "enhanced manifest gained distribution authority");
assert(enhanced.composition.assets.filter((asset) => asset.role === "platform_derivative").length === 4, "expected four authorized platform derivatives");
assert(enhanced.composition.assets.every((asset) => asset.reuseAuthority === "authorized"), "composition asset lacks explicit authorization");

const seedFiles = [
  ["storyboard-brand-source.webp", sourceManifest.source.sha256],
  ["storyboard-brand-logo.webp", sourceManifest.approvedLogo.sha256],
  ["storyboard-brand-tiktok.webp", sourceManifest.derivatives.find((item) => item.presetId === "tiktok.cover.v1")?.sha256],
  ["storyboard-brand-youtube.webp", sourceManifest.derivatives.find((item) => item.presetId === "youtube.thumbnail.v1")?.sha256],
  ["storyboard-brand-instagram.webp", sourceManifest.derivatives.find((item) => item.presetId === "instagram.square.v1")?.sha256],
  ["storyboard-brand-web.webp", sourceManifest.derivatives.find((item) => item.presetId === "web.hero.v1")?.sha256],
];
for (const [path, expectedSha] of seedFiles) {
  assert(isSha(expectedSha), `seed file ${path} missing expected SHA`);
  assert(fileSha(path) === expectedSha, `seed file ${path} SHA mismatch`);
  assertWebp(path, path);
}

assert(manifest.renderer.conceptModel === "@cf/black-forest-labs/flux-1-schnell", "unexpected concept renderer");
assert(manifest.renderer.compositionProvider === "cloudflare_images_binding", "unexpected composition renderer");
assert(manifest.renderer.deterministicExactAssetComposition === true, "deterministic exact composition is not asserted");
assert(manifest.governance.humanReviewRequired === true, "StoryboardManifest review gate missing");
assert(manifest.governance.publicationAuthority === false && manifest.governance.externalDistributionAuthority === false, "StoryboardManifest gained distribution authority");
assert(Array.isArray(manifest.targets) && manifest.targets.length === 3, "expected three StoryboardManifest targets");
assert(JSON.stringify(manifest.targets.map((target) => target.shots.length)) === JSON.stringify([3, 4, 3]), "unexpected multi-shot topology");
const totalShots = manifest.targets.reduce((sum, target) => sum + target.shots.length, 0);
assert(totalShots === 10, `expected 10 storyboard shots, got ${totalShots}`);
assert(review.targetCount === 3 && review.shotCount === 10, "review package target/shot counts mismatch");
assert(review.storyboardManifestKey === renderPlan.storyboardManifestKey, "review/render-plan storyboard reference mismatch");
assert(review.videoRenderPlanKey.includes("/handoff/video-render-plan-v1.json"), "review package missing canonical VideoRenderPlan handoff");
assert(review.humanReviewRequired === true && review.publicationAuthority === false && review.externalDistributionAuthority === false, "review package governance mismatch");

let productComposedCount = 0;
for (let targetIndex = 0; targetIndex < manifest.targets.length; targetIndex += 1) {
  const target = manifest.targets[targetIndex];
  const targetDuration = target.shots.reduce((sum, shot) => sum + Number(shot.durationSeconds), 0);
  assert(Math.abs(targetDuration - Number(target.targetProfile.durationSeconds)) <= 0.11, `planned shot timing does not sum to target duration for ${target.variantId}`);
  const planTarget = renderPlan.targets.find((candidate) => candidate.variantId === target.variantId);
  assert(planTarget, `VideoRenderPlan missing target ${target.variantId}`);
  assert(planTarget.shots.length === target.shots.length, `VideoRenderPlan shot count mismatch ${target.variantId}`);

  for (let shotIndex = 0; shotIndex < target.shots.length; shotIndex += 1) {
    const shot = target.shots[shotIndex];
    const generated = shot.generatedFrame;
    const composed = shot.composedFrame;
    const generatedFile = `storyboard-brand-generated-${targetIndex + 1}-${shotIndex + 1}.bin`;
    const composedFile = `storyboard-brand-composed-${targetIndex + 1}-${shotIndex + 1}.webp`;
    assert(generated.model === "@cf/black-forest-labs/flux-1-schnell", `generated model mismatch ${shot.shotId}`);
    assert(generated.diffusionSteps === 4 && generated.providerSeedApplied === false, `generated provider contract mismatch ${shot.shotId}`);
    assert(generated.promptSha256 === sha256(Buffer.from(shot.fluxPrompt)), `generated prompt SHA mismatch ${shot.shotId}`);
    assert(fileSha(generatedFile) === generated.sha256, `generated frame SHA mismatch ${shot.shotId}`);
    assertGeneratedImage(generatedFile, generated.contentType, `generated frame ${shot.shotId}`);
    assert(generated.humanReviewRequired === true && generated.publicationAuthority === false && generated.externalDistributionAuthority === false, `generated frame governance mismatch ${shot.shotId}`);

    assertWebp(composedFile, `composed frame ${shot.shotId}`);
    assert(fileSha(composedFile) === composed.sha256, `composed frame SHA mismatch ${shot.shotId}`);
    assert(composed.generatedFrameSha256 === generated.sha256, `composed frame source SHA mismatch ${shot.shotId}`);
    assert(composed.approvedLogoSha256 === enhanced.approvedLogo.sha256, `composed frame approved logo SHA mismatch ${shot.shotId}`);
    assert(composed.exactApprovedLogoOverlayApplied === true, `exact approved logo not applied ${shot.shotId}`);
    const needsProduct = shot.intent === "product_showcase" || shot.intent === "feature_value";
    assert(composed.exactApprovedProductAssetApplied === needsProduct, `product composition flag mismatch ${shot.shotId}`);
    if (needsProduct) {
      productComposedCount += 1;
      assert(isSha(composed.approvedProductAssetSha256), `approved product asset SHA missing ${shot.shotId}`);
      assert(shot.composition.exactProductAsset?.sha256 === composed.approvedProductAssetSha256, `product asset SHA mismatch ${shot.shotId}`);
    } else {
      assert(shot.composition.exactProductAsset === undefined, `non-product shot has exact product asset ${shot.shotId}`);
    }
    assert(composed.humanReviewRequired === true && composed.publicationAuthority === false && composed.externalDistributionAuthority === false, `composed frame governance mismatch ${shot.shotId}`);

    const renderShot = planTarget.shots.find((candidate) => candidate.shotId === shot.shotId);
    assert(renderShot?.referenceFrameObjectKey === composed.objectKey, `VideoRenderPlan frame object mismatch ${shot.shotId}`);
    assert(renderShot?.referenceFrameSha256 === composed.sha256, `VideoRenderPlan frame SHA mismatch ${shot.shotId}`);
  }

  for (const [cardType, card, file] of [
    ["title", target.titleCard, `storyboard-brand-title-${targetIndex + 1}.webp`],
    ["end", target.endCard, `storyboard-brand-end-${targetIndex + 1}.webp`],
  ]) {
    assert(card.cardType === cardType, `${cardType} card type mismatch ${target.variantId}`);
    assert(card.exactApprovedLogoOverlayApplied === true, `${cardType} card exact logo missing ${target.variantId}`);
    assert(card.approvedLogoSha256 === enhanced.approvedLogo.sha256, `${cardType} card logo SHA mismatch ${target.variantId}`);
    assert(card.textRenderedInImage === false, `${cardType} runtime card unexpectedly rendered text`);
    assert(typeof card.verifiedCopy?.headline === "string" && card.verifiedCopy.headline.length > 0, `${cardType} verified copy missing ${target.variantId}`);
    assertWebp(file, `${cardType} card ${target.variantId}`);
    assert(fileSha(file) === card.sha256, `${cardType} card SHA mismatch ${target.variantId}`);
    assert(card.humanReviewRequired === true && card.publicationAuthority === false && card.externalDistributionAuthority === false, `${cardType} card governance mismatch ${target.variantId}`);
  }
}
assert(productComposedCount === 4, `expected four exact product/feature compositions, got ${productComposedCount}`);

assert(renderPlan.provider.id === "pruna/p-video", "VideoRenderPlan provider mismatch");
assert(renderPlan.provider.mode === "paid_preview", "VideoRenderPlan provider mode mismatch");
assert(renderPlan.provider.activationState === "disabled_until_paid_acceptance", "paid renderer activation state weakened");
assert(renderPlan.governance.providerExecutionAuthorized === false, "VideoRenderPlan incorrectly authorizes provider execution");
assert(renderPlan.governance.humanReviewRequired === true && renderPlan.governance.publicationAuthority === false && renderPlan.governance.externalDistributionAuthority === false, "VideoRenderPlan governance mismatch");

assert(Array.isArray(motion.previews) && motion.previews.length === 3, "expected three target motion previews");
for (let index = 0; index < motion.previews.length; index += 1) {
  const preview = motion.previews[index];
  const target = manifest.targets[index];
  const file = `storyboard-brand-preview-${index + 1}.mp4`;
  const bytes = fs.readFileSync(file);
  assert(bytes.subarray(4, 8).toString("ascii") === "ftyp", `motion preview ${index + 1} missing MP4 signature`);
  assert(fileSha(file) === preview.sha256, `motion preview ${index + 1} SHA mismatch`);
  assert(preview.renderer === "deterministic_ffmpeg_ci" && preview.renderPhase === "multi_shot_review_mockup", `motion preview ${index + 1} renderer mismatch`);
  assert(preview.verifiedTitleCopyRendered === true && preview.verifiedEndCopyRendered === true, `motion preview ${index + 1} card copy evidence missing`);
  assert(JSON.stringify(preview.composedFrameSha256s) === JSON.stringify(target.shots.map((shot) => shot.composedFrame.sha256)), `motion preview ${index + 1} composed-frame lineage mismatch`);
  assert(preview.titleCardSha256 === target.titleCard.sha256 && preview.endCardSha256 === target.endCard.sha256, `motion preview ${index + 1} card lineage mismatch`);
  const probe = JSON.parse(run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height:format=duration",
    "-of", "json",
    file,
  ]));
  const stream = probe.streams?.[0];
  assert(stream?.codec_name === "h264", `motion preview ${index + 1} is not H.264`);
  assert(Number(stream.width) === preview.width && Number(stream.height) === preview.height, `motion preview ${index + 1} dimensions mismatch`);
  assert(Math.abs(Number(probe.format?.duration) - Number(target.targetProfile.durationSeconds)) <= 0.35, `motion preview ${index + 1} duration mismatch`);
  assert(preview.humanReviewRequired === true && preview.publicationAuthority === false && preview.externalDistributionAuthority === false, `motion preview ${index + 1} governance mismatch`);
}
assert(motion.publicationAuthority === false && motion.externalDistributionAuthority === false, "motion evidence gained distribution authority");

const evidence = {
  schemaVersion: "tmg.storyboard-brand-acceptance-evidence.v1.1",
  requestId: manifest.requestId,
  tenantId: manifest.tenantId,
  sourceImageManifestSha256: enhanced.sourceManifest.sha256,
  enhancedImageAssetManifestSchema: enhanced.schemaVersion,
  storyboardManifestSchema: manifest.schemaVersion,
  videoRenderPlanSchema: renderPlan.schemaVersion,
  targetCount: manifest.targets.length,
  shotCount: totalShots,
  exactProductCompositionCount: productComposedCount,
  generatedFrameSha256s: manifest.targets.flatMap((target) => target.shots.map((shot) => shot.generatedFrame.sha256)),
  composedFrameSha256s: manifest.targets.flatMap((target) => target.shots.map((shot) => shot.composedFrame.sha256)),
  titleCardSha256s: manifest.targets.map((target) => target.titleCard.sha256),
  endCardSha256s: manifest.targets.map((target) => target.endCard.sha256),
  motionPreviewSha256s: motion.previews.map((preview) => preview.sha256),
  pVideoExecutionAuthorized: false,
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
};
fs.writeFileSync("storyboard-brand-acceptance-evidence.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
