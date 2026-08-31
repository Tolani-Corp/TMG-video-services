import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const requestId = process.env.TMG_STORYBOARD_BRAND_ACCEPT_REQUEST_ID;
if (!requestId) throw new Error("missing TMG_STORYBOARD_BRAND_ACCEPT_REQUEST_ID");

const tenantId = "storyboard_brand_acceptance";
const createdAt = new Date().toISOString();

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").slice(0, 4000)}`);
  }
}

function createWebp(fileName, width, height, color) {
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi",
    "-i", `color=c=${color}:s=${width}x${height}:d=0.05`,
    "-frames:v", "1",
    "-c:v", "libwebp",
    "-lossless", "1",
    "-compression_level", "6",
    fileName,
  ]);
}

function sha256File(fileName) {
  return crypto.createHash("sha256").update(fs.readFileSync(fileName)).digest("hex");
}

function size(fileName) {
  return fs.statSync(fileName).size;
}

createWebp("storyboard-brand-source.webp", 800, 600, "0x111827");
createWebp("storyboard-brand-logo.webp", 320, 96, "0x22d3ee");
createWebp("storyboard-brand-tiktok.webp", 1080, 1920, "0x172033");
createWebp("storyboard-brand-youtube.webp", 1280, 720, "0x18253a");
createWebp("storyboard-brand-instagram.webp", 1080, 1080, "0x1b2a41");
createWebp("storyboard-brand-web.webp", 1600, 900, "0x1d2d44");

const sourceSha = sha256File("storyboard-brand-source.webp");
const logoSha = sha256File("storyboard-brand-logo.webp");
const inputRoot = `tenants/${tenantId}/image-runtime/${requestId}/inputs`;
const derivativeRoot = `tenants/${tenantId}/image-runtime/${requestId}/derivatives`;
const sourceManifestKey = `tenants/${tenantId}/image-runtime/${requestId}/control/image-asset-manifest-v1.json`;
const creativeBriefKey = `tenants/${tenantId}/production-requests/${requestId}/marketing/creative-brief-v1.json`;

const derivativeSpecs = [
  { presetId: "tiktok.cover.v1", platform: "tiktok", width: 1080, height: 1920, aspectRatio: "9:16", fileName: "storyboard-brand-tiktok.webp" },
  { presetId: "youtube.thumbnail.v1", platform: "youtube", width: 1280, height: 720, aspectRatio: "16:9", fileName: "storyboard-brand-youtube.webp" },
  { presetId: "instagram.square.v1", platform: "instagram", width: 1080, height: 1080, aspectRatio: "1:1", fileName: "storyboard-brand-instagram.webp" },
  { presetId: "web.hero.v1", platform: "website", width: 1600, height: 900, aspectRatio: "16:9", fileName: "storyboard-brand-web.webp" },
];

const derivatives = derivativeSpecs.map((spec, index) => ({
  artifactId: `storyboard-brand-accept-${index + 1}-${spec.presetId}`,
  presetId: spec.presetId,
  platform: spec.platform,
  objectKey: `${derivativeRoot}/${spec.presetId}.webp`,
  sha256: sha256File(spec.fileName),
  bytes: size(spec.fileName),
  mimeType: "image/webp",
  width: spec.width,
  height: spec.height,
  aspectRatio: spec.aspectRatio,
  sourceSha256: sourceSha,
  logoSha256: logoSha,
  exactApprovedLogoOverlayApplied: true,
  humanReviewRequired: true,
  publicationAuthority: false,
}));

const imageManifest = {
  schemaVersion: "tmg.image-asset-manifest.v1",
  requestId,
  tenantId,
  source: {
    artifactId: "storyboard-brand-accept-source",
    objectKey: `${inputRoot}/source.webp`,
    sha256: sourceSha,
    bytes: size("storyboard-brand-source.webp"),
    mimeType: "image/webp",
    authorityRef: "fixture://tmg/storyboard-brand/source-v1",
    inspection: { format: "image/webp", width: 800, height: 600, fileSize: size("storyboard-brand-source.webp") },
  },
  approvedLogo: {
    artifactId: "storyboard-brand-accept-logo",
    objectKey: `${inputRoot}/logo.webp`,
    sha256: logoSha,
    bytes: size("storyboard-brand-logo.webp"),
    mimeType: "image/webp",
    authorityRef: "fixture://tmg/storyboard-brand/logo-v1",
    inspection: { format: "image/webp", width: 320, height: 96, fileSize: size("storyboard-brand-logo.webp") },
  },
  rights: {
    evidenceRef: "rights://tmg/storyboard-brand-acceptance/synthetic-v1",
    evidenceState: "verified",
    purpose: "marketing_creative",
    sourceReuseAuthorized: true,
    logoOverlayAuthorized: true,
  },
  derivatives,
  provenance: {
    processor: "cloudflare_images_binding",
    sourceStorage: "cloudflare_r2",
    transformationVersion: "tmg.image-runtime.v1",
    processedAt: createdAt,
  },
  governance: {
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  },
};

function variant({ variantId, platform, surface, usage, profileId, aspectRatio, width, height, durationSeconds, conceptBias, hook, valueProposition, callToAction }) {
  return {
    variantId,
    target: { platform, surface, usage },
    targetProfile: {
      profileId,
      platform,
      surface,
      aspectRatio,
      width,
      height,
      durationSeconds,
      safeAreaGuidance: aspectRatio === "9:16"
        ? "Keep critical subjects centered and away from right/bottom platform controls."
        : "Keep critical content within a conservative center-safe wide region.",
      conceptBias,
    },
    creativeAngle: conceptBias,
    hook,
    valueProposition,
    callToAction,
    script: `${hook}. ${valueProposition}. ${callToAction}.`,
    videoPrompt: "Acceptance-only paid video prompt; provider execution remains disabled.",
    generation: {
      mode: "text_to_video",
      phase: "preview",
      resolution: "720p",
      durationSeconds,
      aspectRatio,
      draft: true,
      saveAudio: platform !== "website",
      seed: Number.parseInt(crypto.createHash("sha256").update(`${requestId}:${profileId}`).digest("hex").slice(0, 8), 16),
      safetyFilterEnabled: true,
    },
    visualBranding: {
      brandName: "TMG Launchpad",
      colorScheme: "dark",
      colors: ["#111827", "#22d3ee", "#f8fafc"],
      exactAssetReuseAllowed: true,
    },
  };
}

const creativeBrief = {
  schemaVersion: "tmg.marketing-creative-brief.v1",
  requestId,
  tenantId,
  title: "TMG Storyboard Brand Acceptance",
  objective: "Turn verified campaign context plus approved visual assets into reviewed multi-shot brand-composed storyboards.",
  contextQuality: { score: 90, generationEligible: true, warnings: [] },
  variants: [
    variant({
      variantId: "01-tiktok.organic.v1",
      platform: "tiktok", surface: "organic", usage: "organic", profileId: "tiktok.organic.v1",
      aspectRatio: "9:16", width: 1080, height: 1920, durationSeconds: 7, conceptBias: "hook_first",
      hook: "Turn verified product context into campaign-ready media",
      valueProposition: "Use governed assets from source evidence through creative review",
      callToAction: "Review the campaign",
    }),
    variant({
      variantId: "02-youtube.short.v1",
      platform: "youtube", surface: "shorts", usage: "organic", profileId: "youtube.short.v1",
      aspectRatio: "9:16", width: 1080, height: 1920, durationSeconds: 8, conceptBias: "hook_first",
      hook: "Build a traceable campaign preview before paid rendering",
      valueProposition: "Ground each shot in verified claims and exact approved brand assets",
      callToAction: "See the governed workflow",
    }),
    variant({
      variantId: "03-web.hero.v1",
      platform: "website", surface: "hero", usage: "owned_media", profileId: "web.hero.v1",
      aspectRatio: "16:9", width: 1920, height: 1080, durationSeconds: 6, conceptBias: "product_value",
      hook: "A governed pre-production plane for campaign media",
      valueProposition: "Review multi-shot brand composition before activating paid video inference",
      callToAction: "Explore the preview",
    }),
  ],
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
  compiledAt: createdAt,
};

const request = {
  schemaVersion: "tmg.storyboard-brand-composition-request.v1.1",
  requestId,
  tenantId,
  creativeBriefKey,
  imageAssetManifestKey: sourceManifestKey,
  requestedAt: createdAt,
};

fs.writeFileSync("storyboard-brand-image-manifest.json", JSON.stringify(imageManifest, null, 2) + "\n");
fs.writeFileSync("storyboard-brand-creative-brief.json", JSON.stringify(creativeBrief, null, 2) + "\n");
fs.writeFileSync("storyboard-brand-request.json", JSON.stringify(request, null, 2) + "\n");
fs.writeFileSync("storyboard-brand-fixture-index.json", JSON.stringify({
  tenantId,
  requestId,
  sourceManifestKey,
  creativeBriefKey,
  files: {
    source: { fileName: "storyboard-brand-source.webp", objectKey: imageManifest.source.objectKey },
    logo: { fileName: "storyboard-brand-logo.webp", objectKey: imageManifest.approvedLogo.objectKey },
    derivatives: derivativeSpecs.map((spec, index) => ({
      fileName: spec.fileName,
      objectKey: derivatives[index].objectKey,
    })),
  },
}, null, 2) + "\n");

console.log(JSON.stringify({ requestId, tenantId, derivativeCount: derivatives.length, sourceManifestKey, creativeBriefKey }));
