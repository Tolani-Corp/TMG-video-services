import type { MarketingCreativeBrief, MarketingCreativeVariant } from "./marketing-creative";

const MAX_GENERATED_VIDEO_BYTES = 250 * 1024 * 1024;
const ALLOWED_VIDEO_PROVIDER = "pruna/p-video";

export interface MarketingVideoArtifact {
  schemaVersion: "tmg.marketing-video-artifact.v1";
  artifactId: string;
  variantId: string;
  targetProfileId: string;
  target: MarketingCreativeVariant["target"];
  objectKey: string;
  contentType: string;
  bytes: number;
  provider: "cloudflare_workers_ai";
  model: "pruna/p-video";
  generationMode: "brand_context_conditioned";
  humanReviewRequired: true;
  publicationAuthority: false;
  createdAt: string;
}

export interface MarketingReviewPackage {
  schemaVersion: "tmg.marketing-review-package.v1";
  requestId: string;
  tenantId: string;
  campaignContextKey: string;
  creativeBriefKey: string;
  socialCopyKey?: string;
  videos: MarketingVideoArtifact[];
  humanReviewRequired: true;
  publicationAuthority: false;
  externalDistributionAuthority: false;
  createdAt: string;
}

interface MarketingVideoRuntimeEnv extends Env {
  TMG_MARKETING_VIDEO_GENERATION_ENABLED?: string;
  TMG_MARKETING_VIDEO_PROVIDER_ID?: string;
  TMG_MARKETING_VIDEO_PROVIDER_ACCEPTANCE_STATE?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireVideoRuntime(env: MarketingVideoRuntimeEnv): NonNullable<Env["AI"]> {
  if (String(env.TMG_MARKETING_VIDEO_GENERATION_ENABLED) !== "true") {
    throw new Error("marketing video generation runtime is disabled");
  }
  if (String(env.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED) !== "true") {
    throw new Error("marketing video generation requires explicit external provider egress authority");
  }
  const acceptance = String(env.TMG_MARKETING_VIDEO_PROVIDER_ACCEPTANCE_STATE ?? "unverified");
  if (acceptance !== "development_canary" && acceptance !== "verified") {
    throw new Error("marketing video provider has not passed acceptance");
  }
  if (env.TMG_MARKETING_VIDEO_PROVIDER_ID !== ALLOWED_VIDEO_PROVIDER) {
    throw new Error("marketing video provider is not in the v1 allowlist");
  }
  if (!env.AI) throw new Error("Workers AI binding is not configured");
  return env.AI;
}

function generatedVideoUrl(value: unknown): string {
  if (!isRecord(value) || value.state !== "Completed" || !isRecord(value.result)) {
    throw new Error("marketing video provider did not return a completed generation");
  }
  const video = value.result.video;
  if (typeof video !== "string" || !video.trim()) {
    throw new Error("marketing video provider response is missing a video URL");
  }
  const parsed = new URL(video);
  if (parsed.protocol !== "https:") throw new Error("generated video URL must use HTTPS");
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    throw new Error("generated video URL failed network destination validation");
  }
  return parsed.toString();
}

function safeVariantId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160);
}

export function marketingVideoObjectKey(
  tenantId: string,
  requestId: string,
  variantId: string,
): string {
  return `tenants/${tenantId}/production-requests/${requestId}/outputs/marketing/videos/${safeVariantId(variantId)}.mp4`;
}

export async function generateMarketingVideoVariant(
  env: MarketingVideoRuntimeEnv,
  input: {
    requestId: string;
    tenantId: string;
    variant: MarketingCreativeVariant;
    createdAt?: string;
  },
): Promise<MarketingVideoArtifact> {
  const ai = requireVideoRuntime(env);
  const response: unknown = await ai.run(ALLOWED_VIDEO_PROVIDER, {
    prompt: input.variant.videoPrompt,
    duration: input.variant.targetProfile.durationSeconds,
    resolution: "720p",
    aspect_ratio: input.variant.targetProfile.aspectRatio,
    draft: true,
    save_audio: true,
    prompt_upsampling: true,
    disable_safety_filter: false,
  });
  const videoUrl = generatedVideoUrl(response);
  const videoResponse = await fetch(videoUrl, {
    redirect: "error",
    headers: { accept: "video/mp4,video/*;q=0.9" },
  });
  if (!videoResponse.ok || !videoResponse.body) {
    throw new Error(`generated video download failed (${videoResponse.status})`);
  }
  const contentType = videoResponse.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!contentType.startsWith("video/")) {
    throw new Error(`generated video returned unsupported content type: ${contentType || "missing"}`);
  }
  const declaredBytes = Number(videoResponse.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declaredBytes) || declaredBytes <= 0) {
    throw new Error("generated video response must declare a bounded content length");
  }
  if (declaredBytes > MAX_GENERATED_VIDEO_BYTES) {
    throw new Error("generated video exceeds the v1 size limit");
  }

  const objectKey = marketingVideoObjectKey(
    input.tenantId,
    input.requestId,
    input.variant.variantId,
  );
  await env.MEDIA_BUCKET.put(objectKey, videoResponse.body, {
    httpMetadata: { contentType },
    customMetadata: {
      requestId: input.requestId,
      tenantId: input.tenantId,
      variantId: input.variant.variantId,
      targetProfileId: input.variant.targetProfile.profileId,
      provider: ALLOWED_VIDEO_PROVIDER,
      publicationAuthority: "false",
      humanReviewRequired: "true",
    },
  });

  return {
    schemaVersion: "tmg.marketing-video-artifact.v1",
    artifactId: crypto.randomUUID(),
    variantId: input.variant.variantId,
    targetProfileId: input.variant.targetProfile.profileId,
    target: input.variant.target,
    objectKey,
    contentType,
    bytes: declaredBytes,
    provider: "cloudflare_workers_ai",
    model: ALLOWED_VIDEO_PROVIDER,
    generationMode: "brand_context_conditioned",
    humanReviewRequired: true,
    publicationAuthority: false,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export async function generateMarketingVideoSet(
  env: MarketingVideoRuntimeEnv,
  brief: MarketingCreativeBrief,
): Promise<MarketingVideoArtifact[]> {
  const artifacts: MarketingVideoArtifact[] = [];
  for (const variant of brief.variants) {
    artifacts.push(await generateMarketingVideoVariant(env, {
      requestId: brief.requestId,
      tenantId: brief.tenantId,
      variant,
      createdAt: brief.compiledAt,
    }));
  }
  return artifacts;
}
