import type { CampaignContextManifest } from "./campaign-context";
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
}

export interface MarketingCreativeVariant {
  variantId: string;
  target: DistributionTarget;
  targetProfile: OutputTargetProfile;
  hook: string;
  valueProposition: string;
  callToAction: string;
  script: string;
  videoPrompt: string;
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
      safeAreaGuidance: "Keep essential text and subjects centered with space for Shorts UI controls.",
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
      durationSeconds: 8,
      safeAreaGuidance: "Keep primary subject and brand cues away from the right and bottom UI regions.",
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
      durationSeconds: 8,
      safeAreaGuidance: "Use vertical composition with critical brand elements centered inside UI-safe margins.",
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
      durationSeconds: 8,
      safeAreaGuidance: "Favor a clean wide composition suitable for responsive hero cropping.",
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
      durationSeconds: 8,
      safeAreaGuidance: "Favor a centered vertical composition suitable for mobile feed placement.",
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
  };
}

function variantId(index: number, profile: OutputTargetProfile): string {
  return `${String(index + 1).padStart(2, "0")}-${profile.profileId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

export function compileMarketingCreativeBrief(input: {
  plan: ProductionPlan;
  context: CampaignContextManifest;
  compiledAt?: string;
}): MarketingCreativeBrief {
  const productName = clean(input.context.product.name, input.context.brand.name ?? input.plan.title);
  const description = clean(input.context.product.description, projectBrief(input.plan));
  const hook = clean(input.context.messaging.headlines[0], productName);
  const value = clean(input.context.messaging.valuePropositions[0], description);
  const cta = clean(input.context.messaging.callsToAction[0], "Learn more");
  const colors = input.context.brand.colors.slice(0, 5);
  const exactAssetReuseAllowed = input.context.candidateAssets.some(
    (asset) => asset.requesterReuseAuthorized,
  );

  const variants = input.plan.distributionTargets.map((target, index) => {
    const targetProfile = profileFor(target);
    const platformContext = `${target.platform} ${target.surface}`.replace(/_/g, " ");
    const script = `${hook}. ${value}. ${cta}.`;
    const visualBrand = [
      input.context.brand.name ? `Brand: ${input.context.brand.name}.` : "",
      colors.length > 0 ? `Use this brand palette as visual guidance: ${colors.join(", ")}.` : "",
      input.context.brand.colorScheme ? `Visual theme: ${input.context.brand.colorScheme}.` : "",
    ].filter(Boolean).join(" ");
    const videoPrompt = [
      `Create a polished ${targetProfile.durationSeconds}-second branded product marketing video for ${platformContext}.`,
      `Product: ${productName}.`,
      `Ground the creative only in this verified site context: ${description}`,
      `Core message: ${value}`,
      `Call to action: ${cta}.`,
      visualBrand,
      `Composition: ${targetProfile.aspectRatio}; ${targetProfile.safeAreaGuidance}`,
      "No invented awards, customer counts, guarantees, prices, testimonials, endorsements, or performance claims.",
      "Do not render third-party logos or exact discovered assets unless separately supplied as an authorized generation input.",
      "Use cinematic product-focused motion, clean typography-free visuals, and a professional commercial tone.",
    ].filter(Boolean).join(" ");

    return {
      variantId: variantId(index, targetProfile),
      target,
      targetProfile,
      hook,
      valueProposition: value,
      callToAction: cta,
      script,
      videoPrompt,
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
