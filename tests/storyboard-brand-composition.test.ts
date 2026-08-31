import { describe, expect, it } from "vitest";
import type { ImageAssetManifest } from "../src/image-runtime";
import type { MarketingCreativeBrief, MarketingCreativeVariant, OutputTargetProfile } from "../src/marketing-creative";
import {
  compileStoryboardTargetPlans,
  compileVideoRenderPlan,
  enhanceImageAssetManifest,
  storyboardManifestObjectKey,
  type StoryboardManifestV1_1,
} from "../src/storyboard-brand-composition";

function derivative(
  presetId: ImageAssetManifest["derivatives"][number]["presetId"],
  platform: ImageAssetManifest["derivatives"][number]["platform"],
  width: number,
  height: number,
  aspectRatio: ImageAssetManifest["derivatives"][number]["aspectRatio"],
  index: number,
): ImageAssetManifest["derivatives"][number] {
  return {
    artifactId: `derivative-${index}`,
    presetId,
    platform,
    objectKey: `tenants/acme/image-runtime/request-1/derivatives/${presetId}.webp`,
    sha256: String(index + 2).repeat(64),
    bytes: 2000 + index,
    mimeType: "image/webp",
    width,
    height,
    aspectRatio,
    sourceSha256: "1".repeat(64),
    logoSha256: "2".repeat(64),
    exactApprovedLogoOverlayApplied: true,
    humanReviewRequired: true,
    publicationAuthority: false,
  };
}

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
  derivatives: [
    derivative("tiktok.cover.v1", "tiktok", 1080, 1920, "9:16", 1),
    derivative("youtube.thumbnail.v1", "youtube", 1280, 720, "16:9", 2),
    derivative("instagram.square.v1", "instagram", 1080, 1080, "1:1", 3),
    derivative("web.hero.v1", "website", 1600, 900, "16:9", 4),
  ],
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

function variant(input: {
  variantId: string;
  platform: MarketingCreativeVariant["target"]["platform"];
  surface: string;
  usage: MarketingCreativeVariant["target"]["usage"];
  profileId: string;
  aspectRatio: OutputTargetProfile["aspectRatio"];
  width: number;
  height: number;
  durationSeconds: number;
  conceptBias: OutputTargetProfile["conceptBias"];
}): MarketingCreativeVariant {
  return {
    variantId: input.variantId,
    target: { platform: input.platform, surface: input.surface, usage: input.usage },
    targetProfile: {
      profileId: input.profileId,
      platform: input.platform,
      surface: input.surface,
      aspectRatio: input.aspectRatio,
      width: input.width,
      height: input.height,
      durationSeconds: input.durationSeconds,
      safeAreaGuidance: "Keep critical content inside conservative safe areas.",
      conceptBias: input.conceptBias,
    },
    creativeAngle: input.conceptBias,
    hook: `Verified hook for ${input.profileId}`,
    valueProposition: `Verified value for ${input.profileId}`,
    callToAction: "Learn more",
    script: "Verified hook. Verified value. Learn more.",
    videoPrompt: "unused by storyboard planning",
    generation: {
      mode: "text_to_video",
      phase: "preview",
      resolution: "720p",
      durationSeconds: input.durationSeconds,
      aspectRatio: input.aspectRatio,
      draft: true,
      saveAudio: input.platform !== "website",
      seed: 42,
      safetyFilterEnabled: true,
    },
    visualBranding: {
      brandName: "Acme",
      colors: ["#111827", "#22d3ee"],
      exactAssetReuseAllowed: true,
    },
  };
}

const brief: MarketingCreativeBrief = {
  schemaVersion: "tmg.marketing-creative-brief.v1",
  requestId: "request-1",
  tenantId: "acme",
  title: "Acme launch",
  objective: "Show how approved product context becomes campaign-ready media",
  contextQuality: { score: 90, generationEligible: true, warnings: [] },
  variants: [
    variant({
      variantId: "01-tiktok.organic.v1",
      platform: "tiktok",
      surface: "organic",
      usage: "organic",
      profileId: "tiktok.organic.v1",
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      durationSeconds: 7,
      conceptBias: "hook_first",
    }),
    variant({
      variantId: "02-youtube.short.v1",
      platform: "youtube",
      surface: "shorts",
      usage: "organic",
      profileId: "youtube.short.v1",
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      durationSeconds: 8,
      conceptBias: "hook_first",
    }),
    variant({
      variantId: "03-web.hero.v1",
      platform: "website",
      surface: "hero",
      usage: "owned_media",
      profileId: "web.hero.v1",
      aspectRatio: "16:9",
      width: 1920,
      height: 1080,
      durationSeconds: 6,
      conceptBias: "product_value",
    }),
  ],
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
  compiledAt: "2026-08-24T20:00:00.000Z",
};

describe("TMG Storyboard & Brand Composition v1.1", () => {
  it("projects a verified ImageAssetManifest into a composition-ready contract", () => {
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

  it("creates multi-shot plans with post-FLUX exact brand composition", () => {
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
    expect(plans.flatMap((plan) => plan.shots).every((shot) => shot.durationSeconds > 0)).toBe(true);
  });

  it("creates a P-Video handoff with provider execution disabled", () => {
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
