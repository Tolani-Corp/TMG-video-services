import type { ImageAssetManifest, ImageDerivativeArtifact, ImagePresetId } from "./image-runtime";
import type { MarketingCreativeBrief, MarketingCreativeVariant, OutputTargetProfile } from "./marketing-creative";

export const STORYBOARD_BRAND_SCHEMA_VERSION = "tmg.storyboard-manifest.v1.1" as const;
export const VIDEO_RENDER_PLAN_SCHEMA_VERSION = "tmg.video-render-plan.v1" as const;

export type StoryboardShotIntent =
  | "hook"
  | "problem"
  | "feature_value"
  | "product_showcase"
  | "cta";

export interface ImageAssetManifestV1_1 extends Omit<ImageAssetManifest, "schemaVersion"> {
  schemaVersion: "tmg.image-asset-manifest.v1.1";
  sourceManifest: {
    objectKey: string;
    sha256: string;
    schemaVersion: "tmg.image-asset-manifest.v1";
  };
  composition: {
    exactApprovedLogoRequired: true;
    exactProductAssetUseRequiresAuthorizedDerivative: true;
    focalPoint: { x: number; y: number };
    logo: {
      anchor: "bottom_right";
      widthRatio: number;
      insetRatio: number;
    };
    assets: Array<{
      artifactId: string;
      role: "source_image" | "approved_logo" | "platform_derivative";
      objectKey: string;
      sha256: string;
      mimeType: string;
      authorityRef: string;
      exactBrandAsset: boolean;
      reuseAuthority: "authorized";
      presetId?: ImagePresetId;
    }>;
  };
}

export interface StoryboardCompositionPlan {
  schemaVersion: "tmg.storyboard-composition-plan.v1";
  targetProfileId: string;
  shotId: string;
  exactLogo: {
    objectKey: string;
    sha256: string;
    widthRatio: number;
    anchor: "bottom_right";
  };
  exactProductAsset?: {
    objectKey: string;
    sha256: string;
    presetId: ImagePresetId;
    widthRatio: number;
    anchor: "center";
  };
  safeAreaGuidance: string;
}

export interface StoryboardShotPlan {
  shotId: string;
  order: number;
  intent: StoryboardShotIntent;
  durationSeconds: number;
  verifiedCopy: {
    headline: string;
    supportingText?: string;
    callToAction?: string;
  };
  fluxPrompt: string;
  composition: StoryboardCompositionPlan;
}

export interface StoryboardTargetPlan {
  variantId: string;
  targetProfile: OutputTargetProfile;
  target: MarketingCreativeVariant["target"];
  creativeAngle: MarketingCreativeVariant["creativeAngle"];
  shots: StoryboardShotPlan[];
}

export interface StoryboardGeneratedFrameArtifact {
  schemaVersion: "tmg.storyboard-generated-frame.v1.1";
  artifactId: string;
  variantId: string;
  shotId: string;
  targetProfileId: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: "image/jpeg" | "image/png";
  promptSha256: string;
  provider: "cloudflare_workers_ai";
  model: "@cf/black-forest-labs/flux-1-schnell";
  diffusionSteps: 4;
  providerSeedApplied: false;
  humanReviewRequired: true;
  publicationAuthority: false;
  externalDistributionAuthority: false;
}

export interface StoryboardComposedFrameArtifact {
  schemaVersion: "tmg.storyboard-composed-frame.v1.1";
  artifactId: string;
  variantId: string;
  shotId: string;
  targetProfileId: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: "image/webp";
  width: number;
  height: number;
  generatedFrameSha256: string;
  approvedLogoSha256: string;
  approvedProductAssetSha256?: string;
  exactApprovedLogoOverlayApplied: true;
  exactApprovedProductAssetApplied: boolean;
  compositionPlan: StoryboardCompositionPlan;
  humanReviewRequired: true;
  publicationAuthority: false;
  externalDistributionAuthority: false;
}

export interface StoryboardBrandCardArtifact {
  schemaVersion: "tmg.storyboard-brand-card.v1.1";
  artifactId: string;
  cardType: "title" | "end";
  variantId: string;
  targetProfileId: string;
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: "image/webp";
  width: number;
  height: number;
  exactApprovedLogoOverlayApplied: true;
  sourceDerivativeSha256: string;
  approvedLogoSha256: string;
  verifiedCopy: {
    headline: string;
    supportingText?: string;
    callToAction?: string;
  };
  textRenderedInImage: false;
  humanReviewRequired: true;
  publicationAuthority: false;
  externalDistributionAuthority: false;
}

export interface StoryboardManifestTarget {
  variantId: string;
  targetProfile: OutputTargetProfile;
  target: MarketingCreativeVariant["target"];
  creativeAngle: MarketingCreativeVariant["creativeAngle"];
  shots: Array<StoryboardShotPlan & {
    generatedFrame: StoryboardGeneratedFrameArtifact;
    composedFrame: StoryboardComposedFrameArtifact;
  }>;
  titleCard: StoryboardBrandCardArtifact;
  endCard: StoryboardBrandCardArtifact;
}

export interface StoryboardManifestV1_1 {
  schemaVersion: typeof STORYBOARD_BRAND_SCHEMA_VERSION;
  requestId: string;
  tenantId: string;
  creativeBriefKey: string;
  imageAssetManifestKey: string;
  enhancedImageAssetManifestKey: string;
  renderer: {
    conceptProvider: "cloudflare_workers_ai";
    conceptModel: "@cf/black-forest-labs/flux-1-schnell";
    compositionProvider: "cloudflare_images_binding";
    deterministicExactAssetComposition: true;
  };
  targets: StoryboardManifestTarget[];
  governance: {
    humanReviewRequired: true;
    publicationAuthority: false;
    externalDistributionAuthority: false;
  };
  createdAt: string;
}

export interface VideoRenderPlanV1 {
  schemaVersion: typeof VIDEO_RENDER_PLAN_SCHEMA_VERSION;
  renderPlanId: string;
  requestId: string;
  tenantId: string;
  storyboardManifestKey: string;
  provider: {
    id: "pruna/p-video";
    mode: "paid_preview";
    activationState: "disabled_until_paid_acceptance";
  };
  targets: Array<{
    variantId: string;
    targetProfile: OutputTargetProfile;
    shots: Array<{
      shotId: string;
      order: number;
      durationSeconds: number;
      prompt: string;
      referenceFrameObjectKey: string;
      referenceFrameSha256: string;
    }>;
    titleCard: Pick<StoryboardBrandCardArtifact, "objectKey" | "sha256" | "verifiedCopy">;
    endCard: Pick<StoryboardBrandCardArtifact, "objectKey" | "sha256" | "verifiedCopy">;
  }>;
  governance: {
    humanReviewRequired: true;
    publicationAuthority: false;
    externalDistributionAuthority: false;
    providerExecutionAuthorized: false;
  };
  createdAt: string;
}

export interface StoryboardBrandReviewPackageV1_1 {
  schemaVersion: "tmg.storyboard-brand-review-package.v1.1";
  requestId: string;
  tenantId: string;
  storyboardManifestKey: string;
  enhancedImageAssetManifestKey: string;
  videoRenderPlanKey: string;
  targetCount: number;
  shotCount: number;
  humanReviewRequired: true;
  publicationAuthority: false;
  externalDistributionAuthority: false;
  createdAt: string;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160);
}

export function storyboardBrandRoot(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/production-requests/${requestId}/outputs/marketing/storyboard-brand-v1-1`;
}

export function enhancedImageAssetManifestKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/image-runtime/${requestId}/control/image-asset-manifest-v1.1.json`;
}

export function storyboardManifestObjectKey(tenantId: string, requestId: string): string {
  return `${storyboardBrandRoot(tenantId, requestId)}/control/storyboard-manifest-v1.1.json`;
}

export function videoRenderPlanObjectKey(tenantId: string, requestId: string): string {
  return `${storyboardBrandRoot(tenantId, requestId)}/handoff/video-render-plan-v1.json`;
}

export function storyboardBrandReviewPackageObjectKey(tenantId: string, requestId: string): string {
  return `${storyboardBrandRoot(tenantId, requestId)}/review/storyboard-brand-review-package-v1.1.json`;
}

export function generatedShotFrameObjectKey(input: {
  tenantId: string;
  requestId: string;
  variantId: string;
  shotId: string;
  extension: "jpg" | "png";
}): string {
  return `${storyboardBrandRoot(input.tenantId, input.requestId)}/targets/${safeSegment(input.variantId)}/shots/${safeSegment(input.shotId)}/generated.${input.extension}`;
}

export function composedShotFrameObjectKey(input: {
  tenantId: string;
  requestId: string;
  variantId: string;
  shotId: string;
}): string {
  return `${storyboardBrandRoot(input.tenantId, input.requestId)}/targets/${safeSegment(input.variantId)}/shots/${safeSegment(input.shotId)}/composed.webp`;
}

export function brandCardObjectKey(input: {
  tenantId: string;
  requestId: string;
  variantId: string;
  cardType: "title" | "end";
}): string {
  return `${storyboardBrandRoot(input.tenantId, input.requestId)}/targets/${safeSegment(input.variantId)}/cards/${input.cardType}.webp`;
}

function derivativeForVariant(
  manifest: Pick<ImageAssetManifest, "derivatives">,
  variant: MarketingCreativeVariant,
): ImageDerivativeArtifact {
  const preferred: ImagePresetId = variant.target.platform === "tiktok"
    ? "tiktok.cover.v1"
    : variant.target.platform === "youtube"
      ? "youtube.thumbnail.v1"
      : variant.target.platform === "instagram"
        ? "instagram.square.v1"
        : "web.hero.v1";
  const derivative = manifest.derivatives.find((candidate) => candidate.presetId === preferred);
  if (!derivative) throw new Error(`approved image derivative ${preferred} is required for storyboard composition`);
  return derivative;
}

export function enhanceImageAssetManifest(input: {
  manifest: ImageAssetManifest;
  sourceManifestKey: string;
  sourceManifestSha256: string;
}): ImageAssetManifestV1_1 {
  if (input.manifest.schemaVersion !== "tmg.image-asset-manifest.v1") {
    throw new Error("unsupported source ImageAssetManifest version");
  }
  if (
    input.manifest.rights.sourceReuseAuthorized !== true ||
    input.manifest.rights.logoOverlayAuthorized !== true ||
    input.manifest.rights.evidenceState !== "verified"
  ) {
    throw new Error("ImageAssetManifest is not composition-authorized");
  }
  return {
    ...input.manifest,
    schemaVersion: "tmg.image-asset-manifest.v1.1",
    sourceManifest: {
      objectKey: input.sourceManifestKey,
      sha256: input.sourceManifestSha256,
      schemaVersion: "tmg.image-asset-manifest.v1",
    },
    composition: {
      exactApprovedLogoRequired: true,
      exactProductAssetUseRequiresAuthorizedDerivative: true,
      focalPoint: { x: 0.5, y: 0.5 },
      logo: {
        anchor: "bottom_right",
        widthRatio: 0.18,
        insetRatio: 0.04,
      },
      assets: [
        {
          artifactId: input.manifest.source.artifactId,
          role: "source_image",
          objectKey: input.manifest.source.objectKey,
          sha256: input.manifest.source.sha256,
          mimeType: input.manifest.source.mimeType,
          authorityRef: input.manifest.source.authorityRef,
          exactBrandAsset: false,
          reuseAuthority: "authorized",
        },
        {
          artifactId: input.manifest.approvedLogo.artifactId,
          role: "approved_logo",
          objectKey: input.manifest.approvedLogo.objectKey,
          sha256: input.manifest.approvedLogo.sha256,
          mimeType: input.manifest.approvedLogo.mimeType,
          authorityRef: input.manifest.approvedLogo.authorityRef,
          exactBrandAsset: true,
          reuseAuthority: "authorized",
        },
        ...input.manifest.derivatives.map((derivative) => ({
          artifactId: derivative.artifactId,
          role: "platform_derivative" as const,
          objectKey: derivative.objectKey,
          sha256: derivative.sha256,
          mimeType: derivative.mimeType,
          authorityRef: input.manifest.rights.evidenceRef,
          exactBrandAsset: true,
          reuseAuthority: "authorized" as const,
          presetId: derivative.presetId,
        })),
      ],
    },
  };
}

function shotIntents(variant: MarketingCreativeVariant): StoryboardShotIntent[] {
  if (variant.target.platform === "youtube" && /short/i.test(variant.target.surface)) {
    return ["hook", "problem", "product_showcase", "cta"];
  }
  if (variant.target.platform === "website" || variant.target.platform === "web_app") {
    return ["product_showcase", "feature_value", "cta"];
  }
  return ["hook", "product_showcase", "cta"];
}

function durations(totalSeconds: number, intents: StoryboardShotIntent[]): number[] {
  if (intents.length === 4) {
    const each = Math.floor((totalSeconds / 4) * 10) / 10;
    return [each, each, each, Math.round((totalSeconds - each * 3) * 10) / 10];
  }
  const first = Math.round(totalSeconds * 0.28 * 10) / 10;
  const middle = Math.round(totalSeconds * 0.44 * 10) / 10;
  return [first, middle, Math.round((totalSeconds - first - middle) * 10) / 10];
}

function verifiedCopy(
  brief: MarketingCreativeBrief,
  variant: MarketingCreativeVariant,
  intent: StoryboardShotIntent,
): StoryboardShotPlan["verifiedCopy"] {
  if (intent === "hook") return { headline: variant.hook };
  if (intent === "problem") return { headline: brief.objective, supportingText: variant.hook };
  if (intent === "feature_value" || intent === "product_showcase") {
    return { headline: variant.valueProposition, supportingText: variant.hook };
  }
  return { headline: variant.callToAction, callToAction: variant.callToAction };
}

function fluxPrompt(input: {
  variant: MarketingCreativeVariant;
  intent: StoryboardShotIntent;
  copy: StoryboardShotPlan["verifiedCopy"];
}): string {
  const colors = input.variant.visualBranding.colors.slice(0, 5);
  return [
    `Create one polished cinematic storyboard concept frame for the ${input.intent.replace(/_/g, " ")} shot of a ${input.variant.targetProfile.aspectRatio} ${input.variant.target.platform} ${input.variant.target.surface} campaign.`,
    `Verified message intent: ${input.copy.headline}.`,
    input.copy.supportingText ? `Supporting verified message: ${input.copy.supportingText}.` : "",
    input.variant.visualBranding.brandName ? `Brand context: ${input.variant.visualBranding.brandName}.` : "",
    colors.length > 0 ? `Use this palette only as visual guidance: ${colors.join(", ")}.` : "",
    input.variant.targetProfile.safeAreaGuidance,
    "Concept scene only. Do not render typography, exact logos, exact product screenshots, third-party marks, watermarks, or discovered assets.",
    "Do not invent awards, customer counts, guarantees, prices, testimonials, endorsements, or performance claims.",
    "Leave clean negative space for later deterministic rights-cleared brand composition.",
  ].filter(Boolean).join(" ");
}

export function compileStoryboardTargetPlans(input: {
  brief: MarketingCreativeBrief;
  imageManifest: ImageAssetManifestV1_1;
}): StoryboardTargetPlan[] {
  if (!input.brief.contextQuality.generationEligible) {
    throw new Error("creative brief is not eligible for storyboard generation");
  }
  if (
    input.brief.humanReviewRequired !== true ||
    input.brief.publicationAuthority !== false ||
    input.brief.externalDistributionAuthority !== false
  ) {
    throw new Error("creative brief governance is incompatible with storyboard composition");
  }
  return input.brief.variants.map((variant) => {
    const derivative = derivativeForVariant(input.imageManifest, variant);
    const intents = shotIntents(variant);
    const shotDurations = durations(variant.targetProfile.durationSeconds, intents);
    return {
      variantId: variant.variantId,
      targetProfile: variant.targetProfile,
      target: variant.target,
      creativeAngle: variant.creativeAngle,
      shots: intents.map((intent, index) => {
        const copy = verifiedCopy(input.brief, variant, intent);
        const useExactProductAsset = intent === "product_showcase" || intent === "feature_value";
        const shotId = `${String(index + 1).padStart(2, "0")}-${intent}`;
        return {
          shotId,
          order: index + 1,
          intent,
          durationSeconds: shotDurations[index] ?? 1,
          verifiedCopy: copy,
          fluxPrompt: fluxPrompt({ variant, intent, copy }),
          composition: {
            schemaVersion: "tmg.storyboard-composition-plan.v1",
            targetProfileId: variant.targetProfile.profileId,
            shotId,
            exactLogo: {
              objectKey: input.imageManifest.approvedLogo.objectKey,
              sha256: input.imageManifest.approvedLogo.sha256,
              widthRatio: intent === "cta" ? 0.28 : input.imageManifest.composition.logo.widthRatio,
              anchor: "bottom_right",
            },
            ...(useExactProductAsset ? {
              exactProductAsset: {
                objectKey: derivative.objectKey,
                sha256: derivative.sha256,
                presetId: derivative.presetId,
                widthRatio: 0.46,
                anchor: "center" as const,
              },
            } : {}),
            safeAreaGuidance: variant.targetProfile.safeAreaGuidance,
          },
        };
      }),
    };
  });
}

export function compileVideoRenderPlan(input: {
  manifest: StoryboardManifestV1_1;
  storyboardManifestKey: string;
}): VideoRenderPlanV1 {
  return {
    schemaVersion: VIDEO_RENDER_PLAN_SCHEMA_VERSION,
    renderPlanId: `video-plan-${input.manifest.requestId}`,
    requestId: input.manifest.requestId,
    tenantId: input.manifest.tenantId,
    storyboardManifestKey: input.storyboardManifestKey,
    provider: {
      id: "pruna/p-video",
      mode: "paid_preview",
      activationState: "disabled_until_paid_acceptance",
    },
    targets: input.manifest.targets.map((target) => ({
      variantId: target.variantId,
      targetProfile: target.targetProfile,
      shots: target.shots.map((shot) => ({
        shotId: shot.shotId,
        order: shot.order,
        durationSeconds: shot.durationSeconds,
        prompt: shot.fluxPrompt,
        referenceFrameObjectKey: shot.composedFrame.objectKey,
        referenceFrameSha256: shot.composedFrame.sha256,
      })),
      titleCard: {
        objectKey: target.titleCard.objectKey,
        sha256: target.titleCard.sha256,
        verifiedCopy: target.titleCard.verifiedCopy,
      },
      endCard: {
        objectKey: target.endCard.objectKey,
        sha256: target.endCard.sha256,
        verifiedCopy: target.endCard.verifiedCopy,
      },
    })),
    governance: {
      humanReviewRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
      providerExecutionAuthorized: false,
    },
    createdAt: input.manifest.createdAt,
  };
}
