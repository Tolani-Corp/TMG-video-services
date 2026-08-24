import { NonRetryableError } from "cloudflare:workers";
import type { MarketingCreativeBrief, MarketingCreativeVariant } from "./marketing-creative";

const MAX_GENERATED_VIDEO_BYTES = 250 * 1024 * 1024;
const ALLOWED_VIDEO_PROVIDER = "pruna/p-video";

export interface MarketingVideoArtifact {
  schemaVersion: "tmg.marketing-video-artifact.v1";
  artifactId: string;
  variantId: string;
  targetProfileId: string;
  target: MarketingCreativeVariant["target"];
  creativeAngle: MarketingCreativeVariant["creativeAngle"];
  objectKey: string;
  contentType: string;
  bytes: number;
  provider: "cloudflare_workers_ai";
  model: "pruna/p-video";
  generationMode: "brand_context_conditioned";
  renderPhase: "preview";
  seed: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireVideoRuntime(env: Env): NonNullable<Env["AI"]> {
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

function normalizeProviderError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/AiGatewayError:\s*2021:\s*Insufficient AI Gateway credits/i.test(message)) {
    return new NonRetryableError("marketing_video_provider_billing_hold:insufficient_ai_gateway_credits");
  }
  return error instanceof Error ? error : new Error(message);
}

export function marketingVideoObjectKey(
  tenantId: string,
  requestId: string,
  variantId: string,
): string {
  return `tenants/${tenantId}/production-requests/${requestId}/outputs/marketing/videos/${safeVariantId(variantId)}.mp4`;
}

export async function generateMarketingVideoVariant(
  env: Env,
  input: {
    requestId: string;
    tenantId: string;
    variant: MarketingCreativeVariant;
    createdAt?: string;
  },
): Promise<MarketingVideoArtifact> {
  const ai = requireVideoRuntime(env);
  const generation = input.variant.generation;
  if (generation.mode !== "text_to_video" || generation.phase !== "preview") {
    throw new Error("unsupported marketing generation plan");
  }
  if (!generation.safetyFilterEnabled) {
    throw new Error("marketing generation plan cannot disable the provider safety filter");
  }

  let response: unknown;
  try {
    response = await ai.run(ALLOWED_VIDEO_PROVIDER, {
      prompt: input.variant.videoPrompt,
      duration: generation.durationSeconds,
      resolution: generation.resolution,
      aspect_ratio: generation.aspectRatio,
      seed: generation.seed,
      draft: generation.draft,
      save_audio: generation.saveAudio,
      prompt_upsampling: true,
      disable_safety_filter: false,
    });
  } catch (error) {
    throw normalizeProviderError(error);
  }

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
  const declaredBytesHeader = videoResponse.headers.get("content-length");
  if (declaredBytesHeader) {
    const declaredBytes = Number(declaredBytesHeader);
    if (!Number.isFinite(declaredBytes) || declaredBytes <= 0) {
      throw new Error("generated video returned an invalid content length");
    }
    if (declaredBytes > MAX_GENERATED_VIDEO_BYTES) {
      throw new Error("generated video exceeds the v1 size limit");
    }
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
      creativeAngle: input.variant.creativeAngle,
      provider: ALLOWED_VIDEO_PROVIDER,
      renderPhase: generation.phase,
      seed: String(generation.seed),
      publicationAuthority: "false",
      humanReviewRequired: "true",
    },
  });

  const stored = await env.MEDIA_BUCKET.head(objectKey);
  if (!stored) throw new Error("generated video was not persisted to R2");
  if (stored.size <= 0 || stored.size > MAX_GENERATED_VIDEO_BYTES) {
    await env.MEDIA_BUCKET.delete(objectKey).catch(() => undefined);
    throw new Error("persisted generated video failed the v1 size boundary");
  }

  return {
    schemaVersion: "tmg.marketing-video-artifact.v1",
    artifactId: crypto.randomUUID(),
    variantId: input.variant.variantId,
    targetProfileId: input.variant.targetProfile.profileId,
    target: input.variant.target,
    creativeAngle: input.variant.creativeAngle,
    objectKey,
    contentType,
    bytes: stored.size,
    provider: "cloudflare_workers_ai",
    model: ALLOWED_VIDEO_PROVIDER,
    generationMode: "brand_context_conditioned",
    renderPhase: "preview",
    seed: generation.seed,
    humanReviewRequired: true,
    publicationAuthority: false,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export async function generateMarketingVideoSet(
  env: Env,
  brief: MarketingCreativeBrief,
): Promise<MarketingVideoArtifact[]> {
  if (!brief.contextQuality.generationEligible) {
    throw new Error(`campaign context quality is insufficient for video generation (${brief.contextQuality.score})`);
  }
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