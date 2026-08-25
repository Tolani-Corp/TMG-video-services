import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { MarketingCreativeBrief, MarketingCreativeVariant } from "./marketing-creative";
import {
  WORKERS_AI_STORYBOARD_MODEL,
  assertStoryboardBriefEligible,
  buildMarketingStoryboardPrompt,
  expectedMarketingCreativeBriefObjectKey,
  marketingStoryboardFrameObjectKey,
  marketingStoryboardReviewPackageObjectKey,
  type MarketingStoryboardFrameArtifact,
  type MarketingStoryboardReviewPackage,
} from "./marketing-storyboard";

const MAX_STORYBOARD_IMAGE_BYTES = 12 * 1024 * 1024;
const STORYBOARD_DIFFUSION_STEPS = 4 as const;

export interface MarketingStoryboardWorkflowParams {
  schemaVersion: "tmg.marketing-storyboard-request.v1";
  requestId: string;
  tenantId: string;
  creativeBriefKey: string;
  requestedAt: string;
}

export interface MarketingStoryboardWorkflowResult {
  status: "ready_for_review";
  requestId: string;
  tenantId: string;
  creativeBriefKey: string;
  reviewPackageKey: string;
  frameCount: number;
  model: typeof WORKERS_AI_STORYBOARD_MODEL;
  publicationAuthority: false;
  externalDistributionAuthority: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertParams(value: unknown): asserts value is MarketingStoryboardWorkflowParams {
  if (!isRecord(value)) throw new Error("storyboard workflow parameters are required");
  if (value.schemaVersion !== "tmg.marketing-storyboard-request.v1") {
    throw new Error("unsupported storyboard workflow request version");
  }
  const requestId = value.requestId;
  const tenantId = value.tenantId;
  const creativeBriefKey = value.creativeBriefKey;
  const requestedAt = value.requestedAt;
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new Error("storyboard workflow parameter requestId is required");
  }
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    throw new Error("storyboard workflow parameter tenantId is required");
  }
  if (typeof creativeBriefKey !== "string" || !creativeBriefKey.trim()) {
    throw new Error("storyboard workflow parameter creativeBriefKey is required");
  }
  if (typeof requestedAt !== "string" || !requestedAt.trim()) {
    throw new Error("storyboard workflow parameter requestedAt is required");
  }
  const expectedKey = expectedMarketingCreativeBriefObjectKey(tenantId, requestId);
  if (creativeBriefKey !== expectedKey) {
    throw new Error("storyboard creative brief key is outside the canonical request scope");
  }
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`required storyboard artifact is missing: ${key}`);
  return object.json<T>();
}

async function putImmutableJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  const existing = await bucket.get(key);
  if (existing) {
    const current = await existing.text();
    if (current !== serialized) throw new Error(`immutable storyboard artifact conflict: ${key}`);
    return;
  }
  await bucket.put(key, serialized, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      immutable: "true",
      schema: "tmg.marketing-storyboard-review-package.v1",
      publicationAuthority: "false",
      humanReviewRequired: "true",
    },
  });
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.trim().replace(/\s+/g, "");
  if (!compact || compact.length > MAX_STORYBOARD_IMAGE_BYTES * 2) {
    throw new Error("Workers AI storyboard image payload is missing or exceeds the encoded size boundary");
  }
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new Error("Workers AI storyboard image payload is not valid base64");
  }
  if (binary.length <= 0 || binary.length > MAX_STORYBOARD_IMAGE_BYTES) {
    throw new Error("Workers AI storyboard image exceeds the decoded size boundary");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function detectImageType(bytes: Uint8Array): {
  contentType: "image/jpeg" | "image/png";
  extension: "jpg" | "png";
} {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { contentType: "image/png", extension: "png" };
  }
  throw new Error("Workers AI storyboard renderer returned an unsupported image payload");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function frameArtifact(input: {
  variant: MarketingCreativeVariant;
  objectKey: string;
  contentType: "image/jpeg" | "image/png";
  bytes: number;
  sha256: string;
  createdAt: string;
}): MarketingStoryboardFrameArtifact {
  return {
    schemaVersion: "tmg.marketing-storyboard-frame.v1",
    artifactId: `storyboard-${input.sha256.slice(0, 32)}`,
    variantId: input.variant.variantId,
    targetProfileId: input.variant.targetProfile.profileId,
    target: input.variant.target,
    creativeAngle: input.variant.creativeAngle,
    objectKey: input.objectKey,
    contentType: input.contentType,
    bytes: input.bytes,
    sha256: input.sha256,
    provider: "cloudflare_workers_ai",
    model: WORKERS_AI_STORYBOARD_MODEL,
    generationMode: "storyboard_keyframe",
    renderPhase: "preview",
    creativePlanSeed: input.variant.generation.seed,
    providerSeedApplied: false,
    diffusionSteps: STORYBOARD_DIFFUSION_STEPS,
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
    createdAt: input.createdAt,
  };
}

async function existingFrame(
  bucket: R2Bucket,
  input: {
    tenantId: string;
    requestId: string;
    variant: MarketingCreativeVariant;
    createdAt: string;
  },
): Promise<MarketingStoryboardFrameArtifact | undefined> {
  for (const extension of ["jpg", "png"] as const) {
    const objectKey = marketingStoryboardFrameObjectKey({
      tenantId: input.tenantId,
      requestId: input.requestId,
      variantId: input.variant.variantId,
      extension,
    });
    const existing = await bucket.head(objectKey);
    if (!existing) continue;
    const metadata = existing.customMetadata ?? {};
    if (
      metadata.requestId !== input.requestId ||
      metadata.tenantId !== input.tenantId ||
      metadata.variantId !== input.variant.variantId ||
      metadata.targetProfileId !== input.variant.targetProfile.profileId ||
      metadata.model !== WORKERS_AI_STORYBOARD_MODEL ||
      metadata.creativePlanSeed !== String(input.variant.generation.seed) ||
      metadata.providerSeedApplied !== "false" ||
      metadata.diffusionSteps !== String(STORYBOARD_DIFFUSION_STEPS) ||
      metadata.publicationAuthority !== "false" ||
      metadata.humanReviewRequired !== "true"
    ) {
      throw new Error(`immutable storyboard frame conflict: ${objectKey}`);
    }
    const sha256 = metadata.sha256;
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`persisted storyboard frame is missing SHA-256 metadata: ${objectKey}`);
    }
    return frameArtifact({
      variant: input.variant,
      objectKey,
      contentType: extension === "jpg" ? "image/jpeg" : "image/png",
      bytes: existing.size,
      sha256,
      createdAt: metadata.createdAt || input.createdAt,
    });
  }
  return undefined;
}

async function generateFrame(
  env: Env,
  input: {
    tenantId: string;
    requestId: string;
    variant: MarketingCreativeVariant;
    createdAt: string;
  },
): Promise<MarketingStoryboardFrameArtifact> {
  const reused = await existingFrame(env.MEDIA_BUCKET, input);
  if (reused) return reused;
  if (!env.AI) throw new Error("Workers AI binding is not configured for storyboard generation");

  const response = await env.AI.run(WORKERS_AI_STORYBOARD_MODEL, {
    prompt: buildMarketingStoryboardPrompt(input.variant),
    steps: STORYBOARD_DIFFUSION_STEPS,
  });
  if (!isRecord(response) || typeof response.image !== "string") {
    throw new Error("Workers AI storyboard renderer did not return an image");
  }

  const bytes = decodeBase64(response.image);
  const imageType = detectImageType(bytes);
  const sha256 = await sha256Hex(bytes);
  const objectKey = marketingStoryboardFrameObjectKey({
    tenantId: input.tenantId,
    requestId: input.requestId,
    variantId: input.variant.variantId,
    extension: imageType.extension,
  });

  await env.MEDIA_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType: imageType.contentType },
    customMetadata: {
      requestId: input.requestId,
      tenantId: input.tenantId,
      variantId: input.variant.variantId,
      targetProfileId: input.variant.targetProfile.profileId,
      model: WORKERS_AI_STORYBOARD_MODEL,
      creativePlanSeed: String(input.variant.generation.seed),
      providerSeedApplied: "false",
      diffusionSteps: String(STORYBOARD_DIFFUSION_STEPS),
      sha256,
      renderPhase: "preview",
      generationMode: "storyboard_keyframe",
      publicationAuthority: "false",
      externalDistributionAuthority: "false",
      humanReviewRequired: "true",
      createdAt: input.createdAt,
    },
  });

  const stored = await env.MEDIA_BUCKET.head(objectKey);
  if (!stored || stored.size !== bytes.byteLength) {
    await env.MEDIA_BUCKET.delete(objectKey).catch(() => undefined);
    throw new Error("Workers AI storyboard frame failed R2 persistence verification");
  }

  return frameArtifact({
    variant: input.variant,
    objectKey,
    contentType: imageType.contentType,
    bytes: stored.size,
    sha256,
    createdAt: input.createdAt,
  });
}

export class MarketingStoryboardWorkflow extends WorkflowEntrypoint<Env, MarketingStoryboardWorkflowParams> {
  async run(
    event: WorkflowEvent<MarketingStoryboardWorkflowParams>,
    step: WorkflowStep,
  ): Promise<MarketingStoryboardWorkflowResult> {
    const params = await step.do("validate storyboard request", async () => {
      assertParams(event.payload);
      return event.payload;
    });

    const brief = await step.do("load governed marketing creative brief", async () => {
      const value = await readJson<MarketingCreativeBrief>(this.env.MEDIA_BUCKET, params.creativeBriefKey);
      if (
        value.schemaVersion !== "tmg.marketing-creative-brief.v1" ||
        value.requestId !== params.requestId ||
        value.tenantId !== params.tenantId
      ) {
        throw new Error("storyboard creative brief identity mismatch");
      }
      assertStoryboardBriefEligible(value);
      return value;
    });

    const frames: MarketingStoryboardFrameArtifact[] = [];
    for (let index = 0; index < brief.variants.length; index += 1) {
      const variant = brief.variants[index];
      if (!variant) throw new Error("storyboard target variant is missing");
      const frame = await step.do(
        `generate Workers AI storyboard ${index + 1} ${variant.targetProfile.profileId}`,
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => generateFrame(this.env, {
          tenantId: params.tenantId,
          requestId: params.requestId,
          variant,
          createdAt: params.requestedAt,
        }),
      );
      frames.push(frame);
    }

    const reviewPackageKey = marketingStoryboardReviewPackageObjectKey(
      params.tenantId,
      params.requestId,
    );
    const reviewPackage: MarketingStoryboardReviewPackage = {
      schemaVersion: "tmg.marketing-storyboard-review-package.v1",
      requestId: params.requestId,
      tenantId: params.tenantId,
      creativeBriefKey: params.creativeBriefKey,
      frames,
      renderer: {
        provider: "cloudflare_workers_ai",
        model: WORKERS_AI_STORYBOARD_MODEL,
        generationMode: "storyboard_keyframe",
        freeNeuronPreview: true,
        providerSeedApplied: false,
        diffusionSteps: STORYBOARD_DIFFUSION_STEPS,
      },
      humanReviewRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
      createdAt: params.requestedAt,
    };

    await step.do("persist immutable storyboard review package", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, reviewPackageKey, reviewPackage);
    });

    return {
      status: "ready_for_review",
      requestId: params.requestId,
      tenantId: params.tenantId,
      creativeBriefKey: params.creativeBriefKey,
      reviewPackageKey,
      frameCount: frames.length,
      model: WORKERS_AI_STORYBOARD_MODEL,
      publicationAuthority: false,
      externalDistributionAuthority: false,
    };
  }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({
      service: "tmg-marketing-storyboard-renderer",
      model: WORKERS_AI_STORYBOARD_MODEL,
      mode: "free_neuron_preview",
      publicationAuthority: false,
      externalDistributionAuthority: false,
    }, {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
} satisfies ExportedHandler<Env>;
