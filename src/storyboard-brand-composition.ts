import type { ImageAssetManifest, ImageDerivativeArtifact } from "./image-runtime";
import type { MarketingCreativeBrief, MarketingCreativeVariant } from "./marketing-creative";

export const STORYBOARD_BRAND_COMPOSITION_VERSION = "tmg.storyboard-brand-composition.v1.1" as const;
export const STORYBOARD_MANIFEST_VERSION = "tmg.storyboard-manifest.v1.1" as const;
export const VIDEO_RENDER_PLAN_VERSION = "tmg.video-render-plan.v1" as const;
export const STORYBOARD_SHOTS_PER_TARGET = 3 as const;

export type StoryboardShotIntent = "hook" | "product_value" | "cta";

export interface StoryboardApprovedAssetRef {
  artifactId: string;
  objectKey: string;
  sha256: string;
  authorityRef: string;
  usage: "exact_logo_overlay" | "supporting_visual_reference";
}

export interface StoryboardShotPlan {
  shotId: string;
  order: number;
  intent: StoryboardShotIntent;
  durationSeconds: number;
  prompt: string;
  targetProfileId: string;
  target: MarketingCreativeVariant["target"];
  aspectRatio: MarketingCreativeVariant["targetProfile"]["aspectRatio"];
  width: number;
  height: number;
  approvedAssets: StoryboardApprovedAssetRef[];
  safeAreaGuidance: string;
}

export interface StoryboardFrameEvidence {
  shotId: string;
  rawFrame: {
    objectKey: string;
    sha256: string;
    bytes: number;
    mimeType: "image/jpeg" | "image/png";
    provider: "cloudflare_workers_ai";
    model: "@cf/black-forest-labs/flux-1-schnell";
  };
  composedFrame: {
    objectKey: string;
    sha256: string;
    bytes: number;
    mimeType: "image/webp";
    exactApprovedLogoOverlayApplied: true;
    approvedLogoSha256: string;
  };
}

export interface StoryboardTargetManifest {
  targetProfileId: string;
  target: MarketingCreativeVariant["target"];
  durationSeconds: number;
  aspectRatio: MarketingCreativeVariant["targetProfile"]["aspectRatio"];
  shots: Array<StoryboardShotPlan & { evidence: StoryboardFrameEvidence }>;
  titleCard: StoryboardCardSpec;
  endCard: StoryboardCardSpec;
}

export interface StoryboardCardSpec {
  cardId: string;
  kind: "title" | "end";
  targetProfileId: string;
  durationSeconds: number;
  headline: string;
  supportingText?: string;
  callToAction?: string;
  approvedLogo: StoryboardApprovedAssetRef;
  backgroundFrameObjectKey: string;
  compositionMode: "deterministic_review_card";
  humanReviewRequired: true;
  publicationAuthority: false;
}

export interface StoryboardManifestV11 {
  schemaVersion: typeof STORYBOARD_MANIFEST_VERSION;
  requestId: string;
  tenantId: string;
  creativeBriefKey: string;
  imageAssetManifestKey: string;
  targets: StoryboardTargetManifest[];
  rights: {
    evidenceRef: string;
    imageReuseAuthorized: true;
    exactLogoOverlayAuthorized: true;
  };
  provenance: {
    planner: typeof STORYBOARD_BRAND_COMPOSITION_VERSION;
    generatedImageProvider: "cloudflare_workers_ai";
    generatedImageModel: "@cf/black-forest-labs/flux-1-schnell";
    exactCompositionProvider: "cloudflare_images_binding";
    createdAt: string;
  };
  governance: {
    humanReviewRequired: true;
    publicationAuthority: false;
    externalDistributionAuthority: false;
  };
}

export interface VideoRenderPlanShot {
  shotId: string;
  order: number;
  intent: StoryboardShotIntent;
  durationSeconds: number;
  prompt: string;
  referenceFrameObjectKey: string;
  referenceFrameSha256: string;
}

export interface VideoRenderPlanTarget {
  targetProfileId: string;
  target: MarketingCreativeVariant["target"];
  aspectRatio: MarketingCreativeVariant["targetProfile"]["aspectRatio"];
  durationSeconds: number;
  shots: VideoRenderPlanShot[];
  titleCardId: string;
  endCardId: string;
}

export interface VideoRenderPlanV1 {
  schemaVersion: typeof VIDEO_RENDER_PLAN_VERSION;
  requestId: string;
  tenantId: string;
  storyboardManifestKey: string;
  renderer: {
    preferredProvider: "pruna/p-video";
    executionState: "disabled_pending_provider_capacity";
    storyboardGroundingRequired: true;
  };
  targets: VideoRenderPlanTarget[];
  governance: {
    humanReviewRequired: true;
    publicationAuthority: false;
    externalDistributionAuthority: false;
    paidProviderExecutionAuthorized: false;
  };
  createdAt: string;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160);
}

export function storyboardV11Root(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/production-requests/${requestId}/storyboard-v1-1`;
}

export function storyboardManifestV11Key(tenantId: string, requestId: string): string {
  return `${storyboardV11Root(tenantId, requestId)}/control/storyboard-manifest-v1.1.json`;
}

export function videoRenderPlanV1Key(tenantId: string, requestId: string): string {
  return `${storyboardV11Root(tenantId, requestId)}/control/video-render-plan-v1.json`;
}

export function storyboardRawFrameKey(input: {
  tenantId: string;
  requestId: string;
  targetProfileId: string;
  shotId: string;
  extension: "jpg" | "png";
}): string {
  return `${storyboardV11Root(input.tenantId, input.requestId)}/${safeSegment(input.targetProfileId)}/shots/${safeSegment(input.shotId)}/raw.${input.extension}`;
}

export function storyboardComposedFrameKey(input: {
  tenantId: string;
  requestId: string;
  targetProfileId: string;
  shotId: string;
}): string {
  return `${storyboardV11Root(input.tenantId, input.requestId)}/${safeSegment(input.targetProfileId)}/shots/${safeSegment(input.shotId)}/composed.webp`;
}

function allocateShotDurations(totalSeconds: number): [number, number, number] {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 3) {
    throw new Error("storyboard target duration must be at least three seconds");
  }
  const hook = Math.max(1, Math.round(totalSeconds * 0.28));
  const cta = Math.max(1, Math.round(totalSeconds * 0.24));
  const value = Math.max(1, totalSeconds - hook - cta);
  const normalizedTotal = hook + value + cta;
  if (normalizedTotal !== totalSeconds) {
    return [hook, Math.max(1, value + (totalSeconds - normalizedTotal)), cta];
  }
  return [hook, value, cta];
}

function approvedLogoRef(manifest: ImageAssetManifest): StoryboardApprovedAssetRef {
  return {
    artifactId: manifest.approvedLogo.artifactId,
    objectKey: manifest.approvedLogo.objectKey,
    sha256: manifest.approvedLogo.sha256,
    authorityRef: manifest.approvedLogo.authorityRef,
    usage: "exact_logo_overlay",
  };
}

function supportingDerivativeForVariant(
  manifest: ImageAssetManifest,
  variant: MarketingCreativeVariant,
): ImageDerivativeArtifact | undefined {
  const platform = variant.target.platform === "web" || variant.target.platform === "website"
    ? "website"
    : variant.target.platform;
  return manifest.derivatives.find((derivative) => derivative.platform === platform);
}

function buildShotPrompt(
  variant: MarketingCreativeVariant,
  intent: StoryboardShotIntent,
  supportingDerivative?: ImageDerivativeArtifact,
): string {
  const intentInstruction: Record<StoryboardShotIntent, string> = {
    hook: `Create an immediate visual hook that supports this verified message: ${variant.hook}`,
    product_value: `Create a product-value scene supporting this verified proposition: ${variant.valueProposition}`,
    cta: `Create a restrained closing scene that leaves clean negative space for the governed CTA: ${variant.callToAction}`,
  };
  return [
    `Create one cinematic storyboard shot for ${variant.target.platform} ${variant.target.surface}, ${variant.targetProfile.aspectRatio}.`,
    intentInstruction[intent],
    variant.visualBranding.brandName ? `Brand context: ${variant.visualBranding.brandName}.` : "",
    variant.visualBranding.colors.length ? `Palette guidance: ${variant.visualBranding.colors.slice(0, 5).join(", ")}.` : "",
    variant.targetProfile.safeAreaGuidance,
    supportingDerivative ? "A separately rights-cleared product visual exists and will be composited deterministically after generation; do not recreate or imitate it." : "",
    "Do not render typography, captions, watermarks, logos, third-party marks, UI chrome, screenshots, or exact discovered assets.",
    "Do not invent awards, customer counts, guarantees, prices, testimonials, endorsements, performance claims, or product capabilities.",
    "Use a polished commercial composition, realistic lighting, clear subject separation, and adequate negative space for later deterministic brand composition.",
  ].filter(Boolean).join(" ");
}

export function assertAcceptedImageAssetManifest(
  manifest: ImageAssetManifest,
  tenantId: string,
): void {
  if (manifest.schemaVersion !== "tmg.image-asset-manifest.v1") {
    throw new Error("unsupported ImageAssetManifest version for storyboard composition");
  }
  if (manifest.tenantId !== tenantId) {
    throw new Error("ImageAssetManifest tenant does not match storyboard tenant");
  }
  if (
    manifest.rights.evidenceState !== "verified" ||
    manifest.rights.purpose !== "marketing_creative" ||
    manifest.rights.sourceReuseAuthorized !== true ||
    manifest.rights.logoOverlayAuthorized !== true
  ) {
    throw new Error("ImageAssetManifest does not grant required marketing reuse and exact-logo authority");
  }
  if (
    manifest.governance.humanReviewRequired !== true ||
    manifest.governance.publicationAuthority !== false ||
    manifest.governance.externalDistributionAuthority !== false
  ) {
    throw new Error("ImageAssetManifest governance is incompatible with storyboard review-only processing");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.approvedLogo.sha256)) {
    throw new Error("approved logo evidence is missing a valid SHA-256");
  }
}

export function buildStoryboardShotPlans(
  brief: MarketingCreativeBrief,
  imageManifest: ImageAssetManifest,
): Map<string, StoryboardShotPlan[]> {
  assertAcceptedImageAssetManifest(imageManifest, brief.tenantId);
  const result = new Map<string, StoryboardShotPlan[]>();
  for (const variant of brief.variants) {
    const [hookSeconds, valueSeconds, ctaSeconds] = allocateShotDurations(variant.targetProfile.durationSeconds);
    const supportingDerivative = supportingDerivativeForVariant(imageManifest, variant);
    const supportingAsset = supportingDerivative ? {
      artifactId: supportingDerivative.artifactId,
      objectKey: supportingDerivative.objectKey,
      sha256: supportingDerivative.sha256,
      authorityRef: imageManifest.rights.evidenceRef,
      usage: "supporting_visual_reference" as const,
    } : undefined;
    const logo = approvedLogoRef(imageManifest);
    const entries: Array<[StoryboardShotIntent, number]> = [
      ["hook", hookSeconds],
      ["product_value", valueSeconds],
      ["cta", ctaSeconds],
    ];
    const plans = entries.map(([intent, durationSeconds], index) => ({
      shotId: `${safeSegment(variant.variantId)}-shot-${index + 1}-${intent}`,
      order: index + 1,
      intent,
      durationSeconds,
      prompt: buildShotPrompt(variant, intent, supportingDerivative),
      targetProfileId: variant.targetProfile.profileId,
      target: variant.target,
      aspectRatio: variant.targetProfile.aspectRatio,
      width: variant.targetProfile.width,
      height: variant.targetProfile.height,
      approvedAssets: [logo, ...(supportingAsset ? [supportingAsset] : [])],
      safeAreaGuidance: variant.targetProfile.safeAreaGuidance,
    }));
    result.set(variant.targetProfile.profileId, plans);
  }
  return result;
}

export function buildStoryboardCardSpecs(input: {
  variant: MarketingCreativeVariant;
  firstComposedFrameKey: string;
  lastComposedFrameKey: string;
  imageManifest: ImageAssetManifest;
}): { titleCard: StoryboardCardSpec; endCard: StoryboardCardSpec } {
  const logo = approvedLogoRef(input.imageManifest);
  return {
    titleCard: {
      cardId: `${safeSegment(input.variant.variantId)}-title-card`,
      kind: "title",
      targetProfileId: input.variant.targetProfile.profileId,
      durationSeconds: 1,
      headline: input.variant.hook,
      supportingText: input.variant.valueProposition,
      approvedLogo: logo,
      backgroundFrameObjectKey: input.firstComposedFrameKey,
      compositionMode: "deterministic_review_card",
      humanReviewRequired: true,
      publicationAuthority: false,
    },
    endCard: {
      cardId: `${safeSegment(input.variant.variantId)}-end-card`,
      kind: "end",
      targetProfileId: input.variant.targetProfile.profileId,
      durationSeconds: 1,
      headline: input.variant.valueProposition,
      callToAction: input.variant.callToAction,
      approvedLogo: logo,
      backgroundFrameObjectKey: input.lastComposedFrameKey,
      compositionMode: "deterministic_review_card",
      humanReviewRequired: true,
      publicationAuthority: false,
    },
  };
}

export function buildVideoRenderPlan(input: {
  requestId: string;
  tenantId: string;
  storyboardManifestKey: string;
  manifest: StoryboardManifestV11;
  createdAt: string;
}): VideoRenderPlanV1 {
  return {
    schemaVersion: VIDEO_RENDER_PLAN_VERSION,
    requestId: input.requestId,
    tenantId: input.tenantId,
    storyboardManifestKey: input.storyboardManifestKey,
    renderer: {
      preferredProvider: "pruna/p-video",
      executionState: "disabled_pending_provider_capacity",
      storyboardGroundingRequired: true,
    },
    targets: input.manifest.targets.map((target) => ({
      targetProfileId: target.targetProfileId,
      target: target.target,
      aspectRatio: target.aspectRatio,
      durationSeconds: target.durationSeconds,
      shots: target.shots.map((shot) => ({
        shotId: shot.shotId,
        order: shot.order,
        intent: shot.intent,
        durationSeconds: shot.durationSeconds,
        prompt: shot.prompt,
        referenceFrameObjectKey: shot.evidence.composedFrame.objectKey,
        referenceFrameSha256: shot.evidence.composedFrame.sha256,
      })),
      titleCardId: target.titleCard.cardId,
      endCardId: target.endCard.cardId,
    })),
    governance: {
      humanReviewRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
      paidProviderExecutionAuthorized: false,
    },
    createdAt: input.createdAt,
  };
}
