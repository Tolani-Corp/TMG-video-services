import { describe, expect, it } from "vitest";
import type { ImageAssetManifest } from "../src/image-runtime";
import type { MarketingCreativeBrief } from "../src/marketing-creative";
import {
  compileStoryboardTargetPlans,
  compileVideoRenderPlan,
  enhanceImageAssetManifest,
  storyboardManifestObjectKey,
  type StoryboardManifestV1_1,
} from "../src/storyboard-brand-composition";

const derivatives: ImageAssetManifest["derivatives"] = [
  ["tiktok.cover.v1", "tiktok", 1080, 1920, "9:16"],
  ["youtube.thumbnail.v1", "youtube", 1280, 720, "16:9"],
  ["instagram.square.v1", "instagram", 1080, 1080, "1:1"],
  ["web.hero.v1", "website", 1600, 900, "16:9"],
].map(([presetId, platform, width, height, aspectRatio], index) => ({
  artifactId: `derivative-${index + 1}`,
  presetId: presetId as ImageAssetManifest["derivatives"][number]["presetId"],
  platform: platform as ImageAssetManifest["derivatives"][number]["platform"],
  objectKey: `tenants/acme/image-runtime/request-1/derivatives/${presetId}.webp`,
  sha256: String(index + 3).repeat(64),
  bytes: 2000 + index,
  mimeType: "image/webp" as const,
  width: width as number,
  height: height as number,
  aspectRatio: aspectRatio as ImageAssetManifest["derivatives"][number]["aspectRatio"],
  sourceSha256: "1".repeat(64),
  logoSha256: "2".repeat(64),
  exactApprovedLogoOverlayApplied: true as const,
  humanReviewRequired: true as const,
  publicationAuthority: false as const,
}));

const imageManifest: ImageAssetManifest = {
  schemaVersion: "tmg.image-asset-manifest.v1",
  requestId: "request-1",
  tenantId: "acme",
  source: {
    artifactId: "source-1",
    objectKey: "tenants/acme/image-runtime/request-1/inputs/source.png",
    sha256: "1".repeat(64),
    bytes: 4096,
    mimeType: "image/png",
    authorityRef: "rights://source",
    inspection: { format: "image/png", width: 1200, height: 800, fileSize: 4096 },
  },
  approvedLogo: {
    artifactId: "logo-1",
    objectKey: "tenants/acme/image-runtime/request-1/inputs/logo.png",
    sha256: "2".repeat(64),
    bytes: 1024,
    mimeType: "image/png",
    authorityRef: "rights://logo",
    inspection: { format: "image/png", width: 320, height: 96, fileSize: 1024 },
  },
  rights: {
    evidenceRef: "rights://campaign",
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
    processedAt: "2026-08-24T20:00:00.000Z",
  },
  governance: {
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  },
};

const brief: MarketingCreativeBrief = {
  schemaVersion: "tmg.marketing-creative-brief.v1",
  requestId: "request-1",
  tenantId: "acme",
  title: "Acme launch",
  objective: "Show how approved product context becomes campaign-ready media",
  contextQuality: { score: 90, generationEligible: true, warnings: [] },
  variants: [
    {
      variantId: "01-tiktok.organic.v1",
      target: { platform: "tiktok", surface: "organic", usage: "organic" },
      targetProfile: {
        profileId: "tiktok.organic.v1",
        platform: "tiktok",
        surface: "organic",
        aspectRatio: "9:16",
        width: 1080,
        height: 1920,
        durationSeconds: 7,
        safeAreaGuidance: "Keep primary subject centered.",
        conceptBias: "hook_first",
      },
      creativeAngle: "hook_first",
      hook: "Turn product context into campaign-ready media",
      valueProposition: "One governed brief, multiple campaign formats",
      callToAction: "Learn more",
      script: "Turn product context into campaign-ready media. One governed brief, multiple campaign formats. Learn more.",
      videoPrompt: "unused",
      generation: {
        mode: "text_to_video",
        phase: "preview",
        resolution: "720p",
        durationSeconds: 7,
        aspectRatio: "9:16",
        draft: true,
        saveAudio: true,
        seed: 42,
        safetyFilterEnabled: true,
      },
      visualBranding: { brandName: "Acme", colors: ["#111827", "#22d3ee"], exactAssetReuseAllowed: true },
    },
    {
      variantId: "02-youtube.short.v1",
      target: { platform: "youtube", surface: "shorts", usage: "organic" },
      targetProfile: {
        profileId: "youtube.short.v1",
        platform: "youtube",
        surface: "shorts",
        aspectRatio: "9:16",
        width: 1080,
        height: 1920,
        durationSeconds: 8,
        safeAreaGuidance: "Keep essential subjects centered.",
        conceptBias: "hook_first",
      },
      creativeAngle: "hook_first",
      hook: "Build campaign-ready media from verified context",
      valueProposition: "Governed assets stay traceable from source to review",
      callToAction: "See the workflow",
      script: "Build campaign-ready media from verified context. Governed assets stay traceable from source to review. See the workflow.",
      videoPrompt: "unused",
      generation: {
        mode: "text_to_video",
        phase: "preview",
        resolution: "720p",
        durationSeconds: 8,
        aspectRatio: "9:16",
        draft: true,
        saveAudio: true,
        seed: 43,
        safetyFilterEnabled: true,
      },
      visualBranding: { brandName: "Acme", colors: ["#111827"], exactAssetReuseAllowed: true },
    },
    {
      variantId: "03-web.hero.v1",
      target: { platform: "website", surface: "hero", usage: "owned" },
      targetProfile: {
        profileId: "web.hero.v1",
        platform: "website",
        surface: "hero",
        aspectRatio: "16:9",
        width: 1920,
        height: 1080,
        durationSeconds: 6,
        safeAreaGuidance: "Favor a clean wide composition.",
        conceptBias: "product_value",
      },
      creativeAngle: "product_value",
      hook: "A governed campaign preview plane",
      valueProposition: "Review exact brand assets before paid rendering",
      callToAction: "Explore",
      script: "A governed campaign preview plane. Review exact brand assets before paid rendering. Explore.",
      videoPrompt: "unused",
      generation: {
        mode: "text_to_video",
        phase: "preview",
        resolution: "720p",
        durationSeconds: 6,
        aspectRatio: "16:9",
        draft: true,
        saveAudio: false,
        seed: 44,
        safetyFilterEnabled: true,
      },
      visualBranding: { brandName: "Acme", colors: ["#111827", "#22d3ee"], exactAssetReuseAllowed: true },
    },
  ],
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
  compiledAt: "2026-08-24T20:00:00.000Z",
};

describe("TMG Storyboard & Brand Composition v1.1", () => {
  it("projects an authorized ImageAssetManifest into a composition-ready immutable contract", () => {
    const enhanced = enhanceImageAssetManifest({
      manifest: imageManifest,
      sourceManifestKey: "tenants/acme/image-runtime/request-1/control/image-asset-manifest-v1.json",
      sourceManifestSha256: "a".repeat(64),
    });
    expect(enhanced.schemaVersion).toBe("tmg.image-asset-manifest.v1.1");
    expect(enhanced.composition.exactApprovedLogoRequired).toBe(true);
    expect(enhanced.composition.assets.filter((asset) => asset.role === "platform_derivative")).toHaveLength(4);
    expect(enhanced.governance.publicationAuthority).toBe(false);
  });

  it("creates multi-shot target plans and only exact-composes authorized product derivatives after FLUX", () => {
    const enhanced = enhanceImageAssetManifest({
      manifest: imageManifest,
      sourceManifestKey: "tenants/acme/image-runtime/request-1/control/image-asset-manifest-v1.json",
      sourceManifestSha256: "a".repeat(64),
    });
    const plans = compileStoryboardTargetPlans({ brief, imageManifest: enhanced });
    expect(plans.map((plan) => plan.shots.length)).toEqual([3, 4, 3]);
    expect(plans[0]?.shots.map((shot) => shot.intent)).toEqual(["hook", "product_showcase", "cta"]);
    expect(plans[1]?.shots.map((shot) => shot.intent)).toEqual(["hook", "problem", "product_showcase", "cta"]);
    expect(plans[0]?.shots[0]?.composition.exactProductAsset).toBeUndefined();
    expect(plans[0]?.shots[1]?.composition.exactProductAsset?.presetId).toBe("tiktok.cover.v1");
    expect(plans[0]?.shots.every((shot) => shot.composition.exactLogo.sha256 === "2".repeat(64))).toBe(true);
    expect(plans[0]?.shots[0]?.fluxPrompt).toContain("Do not render typography, exact logos, exact product screenshots");
  });

  it("hands off reviewed composed frames to P-Video without granting execution authority", () => {
    const manifest: StoryboardManifestV1_1 = {
      schemaVersion: "tmg.storyboard-manifest.v1.1",
      requestId: "request-1",
      tenantId: "acme",
      creativeBriefKey: "tenants/acme/production-requests/request-1/marketing/creative-brief-v1.json",
      imageAssetManifestKey: "tenants/acme/image-runtime/request-1/control/image-asset-manifest-v1.json",
      enhancedImageAssetManifestKey: "tenants/acme/image-runtime/request-1/control/image-asset-manifest-v1.1.json",
      renderer: {
        conceptProvider: "cloudflare_workers_ai",
        conceptModel: "@cf/black-forest-labs/flux-1-schnell",
        compositionProvider: "cloudflare_images_binding",
        deterministicExactAssetComposition: true,
      },
      targets: [],
      governance: { humanReviewRequired: true, publicationAuthority: false, externalDistributionAuthority: false },
      createdAt: "2026-08-24T20:00:00.000Z",
    };
    const plan = compileVideoRenderPlan({
      manifest,
      storyboardManifestKey: storyboardManifestObjectKey("acme", "request-1"),
    });
    expect(plan.provider.id).toBe("pruna/p-video");
    expect(plan.provider.activationState).toBe("disabled_until_paid_acceptance");
    expect(plan.governance.providerExecutionAuthorized).toBe(false);
    expect(plan.governance.publicationAuthority).toBe(false);
  });
});
