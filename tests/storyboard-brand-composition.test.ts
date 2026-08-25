import { describe, expect, it } from "vitest";
import type { ImageAssetManifest } from "../src/image-runtime";
import type { MarketingCreativeBrief } from "../src/marketing-creative";
import {
  buildStoryboardCardSpecs,
  buildStoryboardShotPlans,
  buildVideoRenderPlan,
  storyboardComposedFrameKey,
  storyboardManifestV11Key,
  type StoryboardManifestV11,
} from "../src/storyboard-brand-composition";

const imageManifest: ImageAssetManifest = {
  schemaVersion: "tmg.image-asset-manifest.v1",
  requestId: "brand-assets-1",
  tenantId: "storyboard_acceptance",
  source: {
    artifactId: "source-1",
    objectKey: "tenants/storyboard_acceptance/image-runtime/brand-assets-1/inputs/source.png",
    sha256: "a".repeat(64),
    bytes: 100,
    mimeType: "image/png",
    authorityRef: "fixture://source",
    inspection: { format: "image/png", width: 64, height: 64, fileSize: 100 },
  },
  approvedLogo: {
    artifactId: "logo-1",
    objectKey: "tenants/storyboard_acceptance/image-runtime/brand-assets-1/inputs/logo.png",
    sha256: "b".repeat(64),
    bytes: 80,
    mimeType: "image/png",
    authorityRef: "fixture://logo",
    inspection: { format: "image/png", width: 32, height: 32, fileSize: 80 },
  },
  rights: {
    evidenceRef: "rights://storyboard/brand-assets-1",
    evidenceState: "verified",
    purpose: "marketing_creative",
    sourceReuseAuthorized: true,
    logoOverlayAuthorized: true,
  },
  derivatives: [{
    artifactId: "brand-assets-1-tiktok.cover.v1",
    presetId: "tiktok.cover.v1",
    platform: "tiktok",
    objectKey: "tenants/storyboard_acceptance/image-runtime/brand-assets-1/derivatives/tiktok.cover.v1.webp",
    sha256: "c".repeat(64),
    bytes: 120,
    mimeType: "image/webp",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    sourceSha256: "a".repeat(64),
    logoSha256: "b".repeat(64),
    exactApprovedLogoOverlayApplied: true,
    humanReviewRequired: true,
    publicationAuthority: false,
  }],
  provenance: {
    processor: "cloudflare_images_binding",
    sourceStorage: "cloudflare_r2",
    transformationVersion: "tmg.image-runtime.v1",
    processedAt: "2026-08-25T00:00:00.000Z",
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
  tenantId: "storyboard_acceptance",
  title: "TMG Launchpad",
  objective: "Show governed campaign production",
  contextQuality: { score: 90, generationEligible: true, warnings: [] },
  variants: [{
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
      safeAreaGuidance: "Keep primary subject centered inside safe margins.",
      conceptBias: "hook_first",
    },
    creativeAngle: "hook_first",
    hook: "Turn product context into campaign-ready media",
    valueProposition: "One governed brief, multiple campaign formats",
    callToAction: "Learn more",
    script: "Review-only synthetic script",
    videoPrompt: "Paid provider prompt remains gated",
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
    visualBranding: {
      brandName: "TMG Launchpad",
      colors: ["#111827", "#22d3ee"],
      exactAssetReuseAllowed: false,
    },
  }],
  humanReviewRequired: true,
  publicationAuthority: false,
  externalDistributionAuthority: false,
  compiledAt: "2026-08-25T00:00:00.000Z",
};

describe("TMG Storyboard & Brand Composition v1.1", () => {
  it("plans three governed shots whose durations exactly match the target", () => {
    const plans = buildStoryboardShotPlans(brief, imageManifest).get("tiktok.organic.v1");
    expect(plans).toHaveLength(3);
    expect(plans?.map((shot) => shot.intent)).toEqual(["hook", "product_value", "cta"]);
    expect(plans?.reduce((sum, shot) => sum + shot.durationSeconds, 0)).toBe(7);
    expect(plans?.every((shot) => shot.approvedAssets.some((asset) => asset.usage === "exact_logo_overlay"))).toBe(true);
    expect(plans?.[0]?.prompt).toContain("do not recreate or imitate it");
    expect(plans?.[0]?.prompt).toContain("Do not invent awards");
  });

  it("creates deterministic title/end-card specs from composed frames", () => {
    const variant = brief.variants[0]!;
    const cards = buildStoryboardCardSpecs({
      variant,
      firstComposedFrameKey: "first.webp",
      lastComposedFrameKey: "last.webp",
      imageManifest,
    });
    expect(cards.titleCard.kind).toBe("title");
    expect(cards.endCard.kind).toBe("end");
    expect(cards.titleCard.approvedLogo.sha256).toBe("b".repeat(64));
    expect(cards.endCard.callToAction).toBe("Learn more");
    expect(cards.endCard.publicationAuthority).toBe(false);
  });

  it("hands an immutable storyboard to P-Video without authorizing paid execution", () => {
    const variant = brief.variants[0]!;
    const plan = buildStoryboardShotPlans(brief, imageManifest).get("tiktok.organic.v1")![0]!;
    const composedKey = storyboardComposedFrameKey({
      tenantId: brief.tenantId,
      requestId: brief.requestId,
      targetProfileId: variant.targetProfile.profileId,
      shotId: plan.shotId,
    });
    const cards = buildStoryboardCardSpecs({
      variant,
      firstComposedFrameKey: composedKey,
      lastComposedFrameKey: composedKey,
      imageManifest,
    });
    const manifest: StoryboardManifestV11 = {
      schemaVersion: "tmg.storyboard-manifest.v1.1",
      requestId: brief.requestId,
      tenantId: brief.tenantId,
      creativeBriefKey: `tenants/${brief.tenantId}/production-requests/${brief.requestId}/marketing/creative-brief-v1.json`,
      imageAssetManifestKey: `tenants/${brief.tenantId}/image-runtime/brand-assets-1/control/image-asset-manifest-v1.json`,
      targets: [{
        targetProfileId: variant.targetProfile.profileId,
        target: variant.target,
        durationSeconds: variant.targetProfile.durationSeconds,
        aspectRatio: variant.targetProfile.aspectRatio,
        shots: [{
          ...plan,
          evidence: {
            shotId: plan.shotId,
            rawFrame: {
              objectKey: "raw.jpg",
              sha256: "d".repeat(64),
              bytes: 100,
              mimeType: "image/jpeg",
              provider: "cloudflare_workers_ai",
              model: "@cf/black-forest-labs/flux-1-schnell",
            },
            composedFrame: {
              objectKey: composedKey,
              sha256: "e".repeat(64),
              bytes: 100,
              mimeType: "image/webp",
              exactApprovedLogoOverlayApplied: true,
              approvedLogoSha256: "b".repeat(64),
            },
          },
        }],
        ...cards,
      }],
      rights: {
        evidenceRef: imageManifest.rights.evidenceRef,
        imageReuseAuthorized: true,
        exactLogoOverlayAuthorized: true,
      },
      provenance: {
        planner: "tmg.storyboard-brand-composition.v1.1",
        generatedImageProvider: "cloudflare_workers_ai",
        generatedImageModel: "@cf/black-forest-labs/flux-1-schnell",
        exactCompositionProvider: "cloudflare_images_binding",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
      governance: {
        humanReviewRequired: true,
        publicationAuthority: false,
        externalDistributionAuthority: false,
      },
    };
    const renderPlan = buildVideoRenderPlan({
      requestId: brief.requestId,
      tenantId: brief.tenantId,
      storyboardManifestKey: storyboardManifestV11Key(brief.tenantId, brief.requestId),
      manifest,
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    expect(renderPlan.renderer.preferredProvider).toBe("pruna/p-video");
    expect(renderPlan.renderer.executionState).toBe("disabled_pending_provider_capacity");
    expect(renderPlan.governance.paidProviderExecutionAuthorized).toBe(false);
    expect(renderPlan.targets[0]?.shots[0]?.referenceFrameSha256).toBe("e".repeat(64));
  });
});
