import type { CampaignContextManifest } from "./campaign-context";
import { deterministicMarketingSeed } from "./marketing-execution-planner";
import type { DistributionTarget, ProductionPlan } from "./production-request";

export interface OutputTargetProfile {
  profileId: string;
  platform: DistributionTarget["platform"];
  surface: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  width: number;
  height: number;
  durationSeconds: number;
  safeAreaGuidance: string;
  conceptBias: "hook_first" | "conversion" | "product_value" | "feature_showcase" | "brand_story";
}

export interface MarketingGenerationSettings {
  mode: "text_to_video";
  phase: "preview";
  resolution: "720p";
  durationSeconds: number;
  aspectRatio: OutputTargetProfile["aspectRatio"];
  draft: true;
  saveAudio: boolean;
  seed: number;
  safetyFilterEnabled: true;
}

export interface MarketingCreativeVariant {
  variantId: string;
  target: DistributionTarget;
  targetProfile: OutputTargetProfile;
  creativeAngle: OutputTargetProfile["conceptBias"];
  hook: string;
  valueProposition: string;
  callToAction: string;
  script: string;
  videoPrompt: string;
  generation: MarketingGenerationSettings;
  visualBranding: {
    brandName?: string;
    colorScheme?: string;
    colors: string[];
    exactAssetReuseAllowed: boolean;
  };
}

export interface MarketingCreativeBrief {
  schemaVersion: "tmg.marketing-creative-brief.v1";
  requestId: string;
  tenantId: string;
  title: string;
  objective: string;
  contextQuality: {
    score: number;
    generationEligible: boolean;
    warnings: string[];
  };
  variants: MarketingCreativeVariant[];
  humanReviewRequired: true;
  publicationAuthority: false;
  externalDistributionAuthority: false;
  compiledAt: string;
}

export interface MarketingSocialCopyPackage {
  schemaVersion: "tmg.marketing-social-copy.v1";
  requestId: string;
  tenantId: string;
  posts: Array<{
    target: DistributionTarget;
    hook: string;
    body: string;
    callToAction: string;
    reviewRequired: true;
  }>;
  publicationAuthority: false;
  compiledAt: string;
}

function clean(value: string | undefined, fallback: string): string {
  const result = value?.trim().replace(/\s+/g, " ");
  return result || fallback;
}

function projectBrief(plan: ProductionPlan): string {
  const brief = plan.sourceInputs.find((input) => input.kind === "project_brief")?.referenceValue;
  return clean(brief, plan.title);
}

function profileFor(target: DistributionTarget): OutputTargetProfile {
  if (target.profileId) {
    const inferred = inferProfile(target);
    return { ...inferred, profileId: target.profileId };
  }
  return inferProfile(target);
}

function inferProfile(target: DistributionTarget): OutputTargetProfile {
  const surface = target.surface.toLowerCase();
  if (target.platform === "youtube" && /short/.test(surface)) {
    return {
      profileId: "youtube.short.v1",
      platform: target.platform,
      surface: target.surface,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      durationSeconds: 8,
      safeAreaGuidance: "Keep essential subjects centered with space for Shorts UI controls.",
      conceptBias: "hook_first",
    };
  }
  if (target.platform === "tiktok") {
    return {
      profileId: target.usage === "paid_ad" ? "tiktok.ad.v1" : "tiktok.organic.v1",
      platform: target.platform,
      surface: target.surface,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      durationSeconds: target.usage === "paid_ad" ? 6 : 7,
      safeAreaGuidance: "Keep primary subject and brand cues away from the right and bottom UI regions.",
      conceptBias: target.usage === "paid_ad" ? "conversion" : "hook_first",
    };
  }
  if (target.platform === "instagram" && /(reel|story)/.test(surface)) {
    return {
      profileId: /story/.test(surface) ? "instagram.story.v1" : "instagram.reel.v1",
      platform: target.platform,
      surface: target.surface,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      durationSeconds: 7,
      safeAreaGuidance: "Use vertical composition with critical brand elements centered inside UI-safe margins.",
      conceptBias: "feature_showcase",
    };
  }
  if (target.platform === "website" || target.platform === "web_app") {
    return {
      profileId: "web.hero.v1",
      platform: target.platform,
      surface: target.surface,
      aspectRatio: "16:9",
      width: 1920,
      height: 1080,
      durationSeconds: 6,
      safeAreaGuidance: "Favor a clean wide composition suitable for responsive hero cropping.",
      conceptBias: "product_value",
    };
  }
  if (target.platform === "mobile_app") {
    return {
      profileId: "app.promo.v1",
      platform: target.platform,
      surface: target.surface,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      durationSeconds: 6,
      safeAreaGuidance: "Favor a centered vertical composition suitable for mobile feed placement.",
      conceptBias: "feature_showcase",
    };
  }
  return {
    profileId: "general.master.v1",
    platform: target.platform,
    surface: target.surface,
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    durationSeconds: 8,
    safeAreaGuidance: "Keep important content inside a conservative center-safe region.",
    conceptBias: "brand_story",
  };
}

function variantId(index: number, profile: OutputTargetProfile): string {
  return `${String(index + 1).padStart(2, "0")}-${profile.profileId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

function pick(values: string[], index: number, fallback: string): string {
  if (values.length === 0) return fallback;
  return clean(values[index % values.length], fallback);
}

function qualityFor(context: CampaignContextManifest): MarketingCreativeBrief["contextQuality"] {
  let score = 0;
  const warnings: string[] = [];
  if (context.product.description) score += 20;
  else warnings.push("product_description_missing");
  if (context.messaging.headlines.length > 0) score += 15;
  else warnings.push("headline_signal_missing");
  if (context.product.features.length > 0) score += 15;
  else warnings.push("feature_signal_missing");
  if (context.messaging.callsToAction.length > 0) score += 10;
  else warnings.push("cta_signal_missing");
  if (context.brand.name) score += 10;
  else warnings.push("brand_name_missing");
  if (context.brand.colors.length > 0 || context.brand.colorScheme) score += 10;
  else warnings.push("brand_visual_signal_missing");
  if (context.messaging.valuePropositions.length > 0) score += 10;
  if (context.provenance.pageCount >= 2) score += 10;
  return {
    score: Math.min(100, score),
    generationEligible: score >= 45,
    warnings,
  };
}

function saveAudioFor(target: DistributionTarget): boolean {
  return ![
    "website",
    "web_app",
    "email_landing_page",
    "digital_signage",
  ].includes(target.platform);
}

export function compileMarketingCreativeBrief(input: {
  plan: ProductionPlan;
  context: CampaignContextManifest;
  compiledAt?: string;
}): MarketingCreativeBrief {
  const productName = clean(input.context.product.name, input.context.brand.name ?? input.plan.title);
  const description = clean(input.context.product.description, projectBrief(input.plan));
  const colors = input.context.brand.colors.slice(0, 5);
  const exactAssetReuseAllowed = input.context.candidateAssets.some(
    (asset) => asset.requesterReuseAuthorized,
  );
  const contextQuality = qualityFor(input.context);

  const variants = input.plan.distributionTargets.map((target, index) => {
    const targetProfile = profileFor(target);
    const hook = pick(input.context.messaging.headlines, index, productName);
    const featureFallback = pick(input.context.product.features, index, description);
    const value = pick(input.context.messaging.valuePropositions, index, featureFallback);
    const cta = pick(input.context.messaging.callsToAction, index, "Learn more");
    const platformContext = `${target.platform} ${target.surface}`.replace(/_/g, " ");
    const script = `${hook}. ${value}. ${cta}.`;
    const visualBrand = [
      input.context.brand.name ? `Brand identity: ${input.context.brand.name}.` : "",
      colors.length > 0 ? `Use this brand palette as visual guidance: ${colors.join(", ")}.` : "",
      input.context.brand.colorScheme ? `Visual theme: ${input.context.brand.colorScheme}.` : "",
    ].filter(Boolean).join(" ");
    const videoPrompt = [
      `Create a polished ${targetProfile.durationSeconds}-second preview marketing video for ${platformContext}.`,
      `Creative angle: ${targetProfile.conceptBias.replace(/_/g, " ")}.`,
      `Product: ${productName}.`,
      `Ground the creative only in this captured product context: ${description}`,
      `Hook: ${hook}`,
      `Core message: ${value}`,
      `Call to action intent: ${cta}.`,
      visualBrand,
      `Composition: ${targetProfile.aspectRatio}; ${targetProfile.safeAreaGuidance}`,
      "No invented awards, customer counts, guarantees, prices, testimonials, endorsements, or performance claims.",
      "Do not render third-party logos or exact discovered assets; discovered assets remain rights-gated candidate context.",
      "Use cinematic product-focused motion, clean typography-free visuals, and a professional commercial tone.",
    ].filter(Boolean).join(" ");

    return {
      variantId: variantId(index, targetProfile),
      target,
      targetProfile,
      creativeAngle: targetProfile.conceptBias,
      hook,
      valueProposition: value,
      callToAction: cta,
      script,
      videoPrompt,
      generation: {
        mode: "text_to_video" as const,
        phase: "preview" as const,
        resolution: "720p" as const,
        durationSeconds: targetProfile.durationSeconds,
        aspectRatio: targetProfile.aspectRatio,
        draft: true as const,
        saveAudio: saveAudioFor(target),
        seed: deterministicMarketingSeed(`${input.plan.requestId}:${targetProfile.profileId}:${targetProfile.conceptBias}`),
        safetyFilterEnabled: true as const,
      },
      visualBranding: {
        ...(input.context.brand.name ? { brandName: input.context.brand.name } : {}),
        ...(input.context.brand.colorScheme
          ? { colorScheme: input.context.brand.colorScheme }
          : {}),
        colors,
        exactAssetReuseAllowed,
      },
    };
  });

  return {
    schemaVersion: "tmg.marketing-creative-brief.v1",
    requestId: input.plan.requestId,
    tenantId: input.plan.tenantId,
    title: input.plan.title,
    objective: projectBrief(input.plan),
    contextQuality,
    variants,
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
    compiledAt: input.compiledAt ?? new Date().toISOString(),
  };
}

export function compileMarketingSocialCopy(
  brief: MarketingCreativeBrief,
): MarketingSocialCopyPackage {
  return {
    schemaVersion: "tmg.marketing-social-copy.v1",
    requestId: brief.requestId,
    tenantId: brief.tenantId,
    posts: brief.variants.map((variant) => ({
      target: variant.target,
      hook: variant.hook,
      body: `${variant.hook}\n\n${variant.valueProposition}`,
      callToAction: variant.callToAction,
      reviewRequired: true as const,
    })),
    publicationAuthority: false,
    compiledAt: brief.compiledAt,
  };
}
