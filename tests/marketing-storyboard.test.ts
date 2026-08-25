import { describe, expect, it } from "vitest";
import type { MarketingCreativeVariant } from "../src/marketing-creative";
import {
  WORKERS_AI_STORYBOARD_MODEL,
  buildMarketingStoryboardPrompt,
  marketingStoryboardFrameObjectKey,
  marketingStoryboardReviewPackageObjectKey,
} from "../src/marketing-storyboard";

const variant: MarketingCreativeVariant = {
  variantId: "01-tiktok.organic.v1",
  target: {
    platform: "tiktok",
    surface: "organic",
    usage: "organic",
  },
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
  valueProposition: "One brief, multiple governed campaign formats",
  callToAction: "Learn more",
  script: "Turn product context into campaign-ready media. One brief, multiple governed campaign formats. Learn more.",
  videoPrompt: "Synthetic marketing video prompt",
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
    colorScheme: "dark",
    colors: ["#111827", "#22d3ee"],
    exactAssetReuseAllowed: false,
  },
};

describe("Workers AI storyboard preview", () => {
  it("uses the Cloudflare-hosted FLUX storyboard model rather than the neuron billing meter", () => {
    expect(WORKERS_AI_STORYBOARD_MODEL).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect(WORKERS_AI_STORYBOARD_MODEL).not.toBe("workers-ai/neurons");
  });

  it("builds a claim-safe typography-free single-frame prompt", () => {
    const prompt = buildMarketingStoryboardPrompt(variant);
    expect(prompt).toContain("Single frame only");
    expect(prompt).toContain("No typography");
    expect(prompt).toContain("No invented awards");
    expect(prompt).toContain("TMG Launchpad");
    expect(prompt).toContain("#111827");
    expect(prompt).not.toContain("Synthetic marketing video prompt");
  });

  it("keeps storyboard artifacts inside the canonical request scope", () => {
    expect(marketingStoryboardFrameObjectKey({
      tenantId: "storyboard_acceptance",
      requestId: "request-1",
      variantId: "01-tiktok.organic.v1",
      extension: "jpg",
    })).toBe(
      "tenants/storyboard_acceptance/production-requests/request-1/outputs/marketing/storyboards/01-tiktok.organic.v1.jpg",
    );
    expect(marketingStoryboardReviewPackageObjectKey("storyboard_acceptance", "request-1")).toBe(
      "tenants/storyboard_acceptance/production-requests/request-1/outputs/marketing/storyboard-review-package-v1.json",
    );
  });
});
