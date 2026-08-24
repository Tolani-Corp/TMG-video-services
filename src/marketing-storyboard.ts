import type { MarketingCreativeBrief, MarketingCreativeVariant } from "./marketing-creative";

export const WORKERS_AI_STORYBOARD_MODEL = "@cf/black-forest-labs/flux-1-schnell" as const;
export const MAX_STORYBOARD_VARIANTS = 3;

export interface MarketingStoryboardFrameArtifact {
  schemaVersion: "tmg.marketing-storyboard-frame.v1";
  artifactId: string;
  variantId: string;
  targetProfileId: string;
  target: MarketingCreativeVariant["target"];
  creativeAngle: MarketingCreativeVariant["creativeAngle"];
  objectKey: string;
  contentType: "image/jpeg" | "image/png";
  bytes: number;
  sha256: string;
  provider: "cloudflare_workers_ai";
  model: typeof WORKERS_AI_STORYBOARD_MODEL;
  generationMode: "storyboard_keyframe";
  renderPhase: "preview";
  seed: number;
  humanReviewRequired: true;
  publicationAuthority: false;
  externalDistributionAuthority: false;
  createdAt: string;
}

export interface MarketingStoryboardReviewPackage {
  schemaVersion: "tmg.marketing-storyboard-review-package.v1";
  requestId: string;
  tenantId: string;
  creativeBriefKey: string;
  frames: MarketingStoryboardFrameArtifact[];
  renderer: {
    provider: "cloudflare_workers_ai";
    model: typeof WORKERS_AI_STORYBOARD_MODEL;
    generationMode: "storyboard_keyframe";
    freeNeuronPreview: true;
  };
  humanReviewRequired: true;
  publicationAuthority: false;
  externalDistributionAuthority: false;
  createdAt: string;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160);
}

export function marketingStoryboardFrameObjectKey(input: {
  tenantId: string;
  requestId: string;
  variantId: string;
  extension: "jpg" | "png";
}): string {
  return `tenants/${input.tenantId}/production-requests/${input.requestId}/outputs/marketing/storyboards/${safeSegment(input.variantId)}.${input.extension}`;
}

export function marketingStoryboardReviewPackageObjectKey(
  tenantId: string,
  requestId: string,
): string {
  return `tenants/${tenantId}/production-requests/${requestId}/outputs/marketing/storyboard-review-package-v1.json`;
}

export function expectedMarketingCreativeBriefObjectKey(
  tenantId: string,
  requestId: string,
): string {
  return `tenants/${tenantId}/production-requests/${requestId}/marketing/creative-brief-v1.json`;
}

export function assertStoryboardBriefEligible(brief: MarketingCreativeBrief): void {
  if (!brief.contextQuality.generationEligible) {
    throw new Error(`campaign context quality is insufficient for storyboard generation (${brief.contextQuality.score})`);
  }
  if (brief.variants.length < 1 || brief.variants.length > MAX_STORYBOARD_VARIANTS) {
    throw new Error(`storyboard preview requires 1-${MAX_STORYBOARD_VARIANTS} target variants`);
  }
  if (brief.publicationAuthority !== false || brief.externalDistributionAuthority !== false) {
    throw new Error("storyboard preview cannot receive publication or external-distribution authority");
  }
  if (brief.humanReviewRequired !== true) {
    throw new Error("storyboard preview requires human review");
  }
}

export function buildMarketingStoryboardPrompt(variant: MarketingCreativeVariant): string {
  const colors = variant.visualBranding.colors.slice(0, 5);
  return [
    `Create one polished cinematic storyboard keyframe for a ${variant.targetProfile.aspectRatio} ${variant.target.platform} ${variant.target.surface} marketing preview.`,
    `Creative angle: ${variant.creativeAngle.replace(/_/g, " ")}.`,
    `Hook intent: ${variant.hook}`,
    `Core message intent: ${variant.valueProposition}`,
    variant.visualBranding.brandName ? `Brand identity context: ${variant.visualBranding.brandName}.` : "",
    colors.length > 0 ? `Use this palette as visual guidance: ${colors.join(", ")}.` : "",
    variant.visualBranding.colorScheme ? `Visual theme: ${variant.visualBranding.colorScheme}.` : "",
    variant.targetProfile.safeAreaGuidance,
    "Single frame only. No typography, captions, watermarks, UI chrome, exact logos, third-party marks, or exact discovered assets.",
    "Do not invent awards, customer counts, guarantees, prices, testimonials, endorsements, or performance claims.",
    "Use a professional commercial composition with strong subject separation, realistic lighting, and enough negative space for later governed title treatment.",
  ].filter(Boolean).join(" ");
}
