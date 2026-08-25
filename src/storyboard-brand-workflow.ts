import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { IMAGE_BINDING_MAX_INPUT_BYTES, imageAssetManifestKey, type ImageAssetManifest } from "./image-runtime";
import type { MarketingCreativeBrief, MarketingCreativeVariant } from "./marketing-creative";
import {
  WORKERS_AI_STORYBOARD_MODEL,
  expectedMarketingCreativeBriefObjectKey,
} from "./marketing-storyboard";
import {
  brandCardObjectKey,
  compileStoryboardTargetPlans,
  compileVideoRenderPlan,
  composedShotFrameObjectKey,
  enhanceImageAssetManifest,
  enhancedImageAssetManifestKey,
  generatedShotFrameObjectKey,
  storyboardBrandReviewPackageObjectKey,
  storyboardManifestObjectKey,
  videoRenderPlanObjectKey,
  type ImageAssetManifestV1_1,
  type StoryboardBrandCardArtifact,
  type StoryboardBrandReviewPackageV1_1,
  type StoryboardComposedFrameArtifact,
  type StoryboardGeneratedFrameArtifact,
  type StoryboardManifestTarget,
  type StoryboardManifestV1_1,
  type StoryboardShotPlan,
} from "./storyboard-brand-composition";

const STORYBOARD_DIFFUSION_STEPS = 4 as const;
const MAX_GENERATED_IMAGE_BYTES = 12 * 1024 * 1024;

export interface StoryboardBrandWorkflowParams {
  schemaVersion: "tmg.storyboard-brand-composition-request.v1.1";
  requestId: string;
  tenantId: string;
  creativeBriefKey: string;
  imageAssetManifestKey: string;
  requestedAt: string;
}

export interface StoryboardBrandWorkflowResult {
  status: "ready_for_review";
  requestId: string;
  tenantId: string;
  enhancedImageAssetManifestKey: string;
  storyboardManifestKey: string;
  videoRenderPlanKey: string;
  reviewPackageKey: string;
  targetCount: number;
  shotCount: number;
  publicationAuthority: false;
  externalDistributionAuthority: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertParams(value: unknown): asserts value is StoryboardBrandWorkflowParams {
  if (!isRecord(value)) throw new Error("storyboard brand workflow parameters are required");
  if (value.schemaVersion !== "tmg.storyboard-brand-composition-request.v1.1") {
    throw new Error("unsupported storyboard brand workflow request version");
  }
  const requestId = value.requestId;
  const tenantId = value.tenantId;
  const creativeBriefKey = value.creativeBriefKey;
  const sourceImageManifestKey = value.imageAssetManifestKey;
  const requestedAt = value.requestedAt;
  if (typeof requestId !== "string" || !requestId.trim()) throw new Error("requestId is required");
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("tenantId is required");
  if (typeof creativeBriefKey !== "string" || !creativeBriefKey.trim()) throw new Error("creativeBriefKey is required");
  if (typeof sourceImageManifestKey !== "string" || !sourceImageManifestKey.trim()) throw new Error("imageAssetManifestKey is required");
  if (typeof requestedAt !== "string" || !requestedAt.trim()) throw new Error("requestedAt is required");
  if (creativeBriefKey !== expectedMarketingCreativeBriefObjectKey(tenantId, requestId)) {
    throw new Error("creative brief key is outside the canonical request scope");
  }
  if (sourceImageManifestKey !== imageAssetManifestKey(tenantId, requestId)) {
    throw new Error("ImageAssetManifest key is outside the canonical image-runtime scope");
  }
}

function requireBindings(env: Env): { ai: NonNullable<Env["AI"]>; images: NonNullable<Env["IMAGES"]> } {
  if (!env.AI) throw new Error("Workers AI binding is not configured for storyboard brand composition");
  if (!env.IMAGES) throw new Error("Cloudflare Images binding is not configured for storyboard brand composition");
  return { ai: env.AI, images: env.IMAGES };
}

function bytesToStream(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream();
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array | string): Promise<string> {
  const input = typeof bytes === "string"
    ? new TextEncoder().encode(bytes)
    : bytes instanceof Uint8Array
      ? Uint8Array.from(bytes)
      : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(input).buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function readJsonText<T>(bucket: R2Bucket, key: string): Promise<{ value: T; text: string }> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`required storyboard brand artifact is missing: ${key}`);
  const text = await object.text();
  return { value: JSON.parse(text) as T, text };
}

async function putImmutableJson(bucket: R2Bucket, key: string, value: unknown, schema: string): Promise<void> {
  const serialized = JSON.stringify(value);
  const existing = await bucket.get(key);
  if (existing) {
    const current = await existing.text();
    if (current !== serialized) throw new Error(`immutable storyboard brand artifact conflict: ${key}`);
    return;
  }
  await bucket.put(key, serialized, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      immutable: "true",
      schema,
      humanReviewRequired: "true",
      publicationAuthority: "false",
      externalDistributionAuthority: "false",
    },
  });
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.trim().replace(/\s+/g, "");
  if (!compact || compact.length > MAX_GENERATED_IMAGE_BYTES * 2) {
    throw new Error("Workers AI storyboard frame is missing or exceeds encoded size boundary");
  }
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new Error("Workers AI storyboard frame is not valid base64");
  }
  if (binary.length <= 0 || binary.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error("Workers AI storyboard frame exceeds decoded size boundary");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function detectImageType(bytes: Uint8Array): { contentType: "image/jpeg" | "image/png"; extension: "jpg" | "png" } {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { contentType: "image/png", extension: "png" };
  }
  throw new Error("Workers AI storyboard renderer returned unsupported image bytes");
}

async function readVerifiedImage(
  bucket: R2Bucket,
  objectKey: string,
  expectedSha256: string,
  label: string,
): Promise<ArrayBuffer> {
  const object = await bucket.get(objectKey);
  if (!object) throw new Error(`${label} is missing from R2`);
  if (object.size <= 0 || object.size > IMAGE_BINDING_MAX_INPUT_BYTES) {
    throw new Error(`${label} exceeds the Cloudflare Images input boundary`);
  }
  const bytes = await object.arrayBuffer();
  if (await sha256Hex(bytes) !== expectedSha256) throw new Error(`${label} SHA-256 mismatch`);
  return bytes;
}

function generatedArtifact(input: {
  variant: MarketingCreativeVariant;
  shot: StoryboardShotPlan;
  objectKey: string;
  contentType: "image/jpeg" | "image/png";
  bytes: number;
  sha256: string;
  promptSha256: string;
}): StoryboardGeneratedFrameArtifact {
  return {
    schemaVersion: "tmg.storyboard-generated-frame.v1.1",
    artifactId: `generated-${input.sha256.slice(0, 32)}`,
    variantId: input.variant.variantId,
    shotId: input.shot.shotId,
    targetProfileId: input.variant.targetProfile.profileId,
    objectKey: input.objectKey,
    sha256: input.sha256,
    bytes: input.bytes,
    contentType: input.contentType,
    promptSha256: input.promptSha256,
    provider: "cloudflare_workers_ai",
    model: WORKERS_AI_STORYBOARD_MODEL,
    diffusionSteps: STORYBOARD_DIFFUSION_STEPS,
    providerSeedApplied: false,
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  };
}

async function existingGeneratedFrame(
  bucket: R2Bucket,
  input: { tenantId: string; requestId: string; variant: MarketingCreativeVariant; shot: StoryboardShotPlan; promptSha256: string },
): Promise<StoryboardGeneratedFrameArtifact | undefined> {
  for (const extension of ["jpg", "png"] as const) {
    const objectKey = generatedShotFrameObjectKey({
      tenantId: input.tenantId,
      requestId: input.requestId,
      variantId: input.variant.variantId,
      shotId: input.shot.shotId,
      extension,
    });
    const existing = await bucket.head(objectKey);
    if (!existing) continue;
    const metadata = existing.customMetadata ?? {};
    if (
      metadata.promptSha256 !== input.promptSha256 ||
      metadata.model !== WORKERS_AI_STORYBOARD_MODEL ||
      metadata.diffusionSteps !== String(STORYBOARD_DIFFUSION_STEPS) ||
      metadata.providerSeedApplied !== "false" ||
      metadata.publicationAuthority !== "false" ||
      metadata.humanReviewRequired !== "true" ||
      !metadata.sha256
    ) {
      throw new Error(`immutable generated storyboard frame conflict: ${objectKey}`);
    }
    return generatedArtifact({
      variant: input.variant,
      shot: input.shot,
      objectKey,
      contentType: extension === "jpg" ? "image/jpeg" : "image/png",
      bytes: existing.size,
      sha256: metadata.sha256,
      promptSha256: input.promptSha256,
    });
  }
  return undefined;
}

async function generateShotFrame(
  env: Env,
  input: { tenantId: string; requestId: string; variant: MarketingCreativeVariant; shot: StoryboardShotPlan },
): Promise<StoryboardGeneratedFrameArtifact> {
  const promptSha256 = await sha256Hex(input.shot.fluxPrompt);
  const reused = await existingGeneratedFrame(env.MEDIA_BUCKET, { ...input, promptSha256 });
  if (reused) return reused;
  const { ai } = requireBindings(env);
  const response = await ai.run(WORKERS_AI_STORYBOARD_MODEL, {
    prompt: input.shot.fluxPrompt,
    steps: STORYBOARD_DIFFUSION_STEPS,
  });
  if (!isRecord(response) || typeof response.image !== "string") {
    throw new Error("Workers AI storyboard brand renderer did not return an image");
  }
  const bytes = decodeBase64(response.image);
  const type = detectImageType(bytes);
  const sha256 = await sha256Hex(bytes);
  const objectKey = generatedShotFrameObjectKey({
    tenantId: input.tenantId,
    requestId: input.requestId,
    variantId: input.variant.variantId,
    shotId: input.shot.shotId,
    extension: type.extension,
  });
  await env.MEDIA_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType: type.contentType },
    customMetadata: {
      immutable: "true",
      schema: "tmg.storyboard-generated-frame.v1.1",
      promptSha256,
      model: WORKERS_AI_STORYBOARD_MODEL,
      diffusionSteps: String(STORYBOARD_DIFFUSION_STEPS),
      providerSeedApplied: "false",
      sha256,
      humanReviewRequired: "true",
      publicationAuthority: "false",
      externalDistributionAuthority: "false",
    },
  });
  return generatedArtifact({
    variant: input.variant,
    shot: input.shot,
    objectKey,
    contentType: type.contentType,
    bytes: bytes.byteLength,
    sha256,
    promptSha256,
  });
}

async function composeShotFrame(
  env: Env,
  input: {
    tenantId: string;
    requestId: string;
    variant: MarketingCreativeVariant;
    shot: StoryboardShotPlan;
    generated: StoryboardGeneratedFrameArtifact;
  },
): Promise<StoryboardComposedFrameArtifact> {
  const objectKey = composedShotFrameObjectKey({
    tenantId: input.tenantId,
    requestId: input.requestId,
    variantId: input.variant.variantId,
    shotId: input.shot.shotId,
  });
  const compositionSha256 = await sha256Hex(JSON.stringify(input.shot.composition));
  const existing = await env.MEDIA_BUCKET.head(objectKey);
  const expectedProductSha = input.shot.composition.exactProductAsset?.sha256 ?? "none";
  if (existing) {
    const metadata = existing.customMetadata ?? {};
    if (
      metadata.generatedFrameSha256 !== input.generated.sha256 ||
      metadata.approvedLogoSha256 !== input.shot.composition.exactLogo.sha256 ||
      metadata.approvedProductAssetSha256 !== expectedProductSha ||
      metadata.compositionSha256 !== compositionSha256 ||
      !metadata.sha256
    ) {
      throw new Error(`immutable composed storyboard frame conflict: ${objectKey}`);
    }
    return {
      schemaVersion: "tmg.storyboard-composed-frame.v1.1",
      artifactId: `composed-${metadata.sha256.slice(0, 32)}`,
      variantId: input.variant.variantId,
      shotId: input.shot.shotId,
      targetProfileId: input.variant.targetProfile.profileId,
      objectKey,
      sha256: metadata.sha256,
      bytes: existing.size,
      contentType: "image/webp",
      width: input.variant.targetProfile.width,
      height: input.variant.targetProfile.height,
      generatedFrameSha256: input.generated.sha256,
      approvedLogoSha256: input.shot.composition.exactLogo.sha256,
      ...(input.shot.composition.exactProductAsset ? { approvedProductAssetSha256: input.shot.composition.exactProductAsset.sha256 } : {}),
      exactApprovedLogoOverlayApplied: true,
      exactApprovedProductAssetApplied: Boolean(input.shot.composition.exactProductAsset),
      compositionPlan: input.shot.composition,
      humanReviewRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
    };
  }

  const generatedBytes = await readVerifiedImage(env.MEDIA_BUCKET, input.generated.objectKey, input.generated.sha256, "generated storyboard frame");
  const logoBytes = await readVerifiedImage(
    env.MEDIA_BUCKET,
    input.shot.composition.exactLogo.objectKey,
    input.shot.composition.exactLogo.sha256,
    "approved storyboard logo",
  );
  const productBytes = input.shot.composition.exactProductAsset
    ? await readVerifiedImage(
      env.MEDIA_BUCKET,
      input.shot.composition.exactProductAsset.objectKey,
      input.shot.composition.exactProductAsset.sha256,
      "approved storyboard product derivative",
    )
    : undefined;
  const { images } = requireBindings(env);
  const width = input.variant.targetProfile.width;
  const height = input.variant.targetProfile.height;
  const logoWidth = Math.max(64, Math.round(width * input.shot.composition.exactLogo.widthRatio));
  const inset = Math.max(24, Math.round(Math.min(width, height) * 0.04));
  const base = images.input(bytesToStream(generatedBytes)).transform({ width, height, fit: "cover" });
  const withProduct = productBytes && input.shot.composition.exactProductAsset
    ? base.draw(
      images.input(bytesToStream(productBytes)).transform({ width: Math.round(width * input.shot.composition.exactProductAsset.widthRatio) }),
      { left: Math.round(width * 0.27), top: Math.round(height * 0.27), opacity: 1 },
    )
    : base;
  const composed = withProduct.draw(
    images.input(bytesToStream(logoBytes)).transform({ width: logoWidth }),
    { right: inset, bottom: inset, opacity: 1 },
  );
  const response = (await composed.output({ format: "image/webp", quality: 88, anim: false })).response();
  if (!response.ok || !response.body) throw new Error(`Cloudflare Images storyboard composition failed (${response.status})`);
  const output = await response.arrayBuffer();
  if (output.byteLength <= 0 || output.byteLength > IMAGE_BINDING_MAX_INPUT_BYTES) {
    throw new Error("composed storyboard frame failed output size boundary");
  }
  const sha256 = await sha256Hex(output);
  await env.MEDIA_BUCKET.put(objectKey, output, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: {
      immutable: "true",
      schema: "tmg.storyboard-composed-frame.v1.1",
      generatedFrameSha256: input.generated.sha256,
      approvedLogoSha256: input.shot.composition.exactLogo.sha256,
      approvedProductAssetSha256: expectedProductSha,
      compositionSha256,
      sha256,
      humanReviewRequired: "true",
      publicationAuthority: "false",
      externalDistributionAuthority: "false",
    },
  });
  return {
    schemaVersion: "tmg.storyboard-composed-frame.v1.1",
    artifactId: `composed-${sha256.slice(0, 32)}`,
    variantId: input.variant.variantId,
    shotId: input.shot.shotId,
    targetProfileId: input.variant.targetProfile.profileId,
    objectKey,
    sha256,
    bytes: output.byteLength,
    contentType: "image/webp",
    width,
    height,
    generatedFrameSha256: input.generated.sha256,
    approvedLogoSha256: input.shot.composition.exactLogo.sha256,
    ...(input.shot.composition.exactProductAsset ? { approvedProductAssetSha256: input.shot.composition.exactProductAsset.sha256 } : {}),
    exactApprovedLogoOverlayApplied: true,
    exactApprovedProductAssetApplied: Boolean(input.shot.composition.exactProductAsset),
    compositionPlan: input.shot.composition,
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  };
}

async function renderBrandCard(
  env: Env,
  input: {
    tenantId: string;
    requestId: string;
    variant: MarketingCreativeVariant;
    imageManifest: ImageAssetManifestV1_1;
    cardType: "title" | "end";
  },
): Promise<StoryboardBrandCardArtifact> {
  const preferredPreset = input.variant.target.platform === "tiktok"
    ? "tiktok.cover.v1"
    : input.variant.target.platform === "youtube"
      ? "youtube.thumbnail.v1"
      : input.variant.target.platform === "instagram"
        ? "instagram.square.v1"
        : "web.hero.v1";
  const derivative = input.imageManifest.derivatives.find((candidate) => candidate.presetId === preferredPreset);
  if (!derivative) throw new Error(`brand card derivative ${preferredPreset} is missing`);
  const objectKey = brandCardObjectKey({
    tenantId: input.tenantId,
    requestId: input.requestId,
    variantId: input.variant.variantId,
    cardType: input.cardType,
  });
  const existing = await env.MEDIA_BUCKET.head(objectKey);
  if (existing) {
    const metadata = existing.customMetadata ?? {};
    if (
      metadata.sourceDerivativeSha256 !== derivative.sha256 ||
      metadata.approvedLogoSha256 !== input.imageManifest.approvedLogo.sha256 ||
      metadata.cardType !== input.cardType ||
      !metadata.sha256
    ) throw new Error(`immutable storyboard brand card conflict: ${objectKey}`);
    return {
      schemaVersion: "tmg.storyboard-brand-card.v1.1",
      artifactId: `card-${metadata.sha256.slice(0, 32)}`,
      cardType: input.cardType,
      variantId: input.variant.variantId,
      targetProfileId: input.variant.targetProfile.profileId,
      objectKey,
      sha256: metadata.sha256,
      bytes: existing.size,
      contentType: "image/webp",
      width: input.variant.targetProfile.width,
      height: input.variant.targetProfile.height,
      exactApprovedLogoOverlayApplied: true,
      sourceDerivativeSha256: derivative.sha256,
      approvedLogoSha256: input.imageManifest.approvedLogo.sha256,
      verifiedCopy: input.cardType === "title"
        ? { headline: input.variant.hook, supportingText: input.variant.valueProposition }
        : { headline: input.variant.callToAction, supportingText: input.variant.valueProposition, callToAction: input.variant.callToAction },
      textRenderedInImage: false,
      humanReviewRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
    };
  }
  const [background, logo] = await Promise.all([
    readVerifiedImage(env.MEDIA_BUCKET, derivative.objectKey, derivative.sha256, "authorized brand-card background"),
    readVerifiedImage(env.MEDIA_BUCKET, input.imageManifest.approvedLogo.objectKey, input.imageManifest.approvedLogo.sha256, "approved brand-card logo"),
  ]);
  const { images } = requireBindings(env);
  const width = input.variant.targetProfile.width;
  const height = input.variant.targetProfile.height;
  const logoWidth = Math.max(80, Math.round(width * (input.cardType === "end" ? 0.30 : 0.20)));
  const inset = Math.max(24, Math.round(Math.min(width, height) * 0.05));
  const base = images.input(bytesToStream(background)).transform({ width, height, fit: "cover" });
  const card = input.cardType === "end"
    ? base.draw(
      images.input(bytesToStream(logo)).transform({ width: logoWidth }),
      { left: Math.round((width - logoWidth) / 2), top: Math.round(height * 0.32), opacity: 1 },
    )
    : base.draw(
      images.input(bytesToStream(logo)).transform({ width: logoWidth }),
      { right: inset, bottom: inset, opacity: 1 },
    );
  const response = (await card.output({ format: "image/webp", quality: 88, anim: false })).response();
  if (!response.ok || !response.body) throw new Error(`Cloudflare Images brand card failed (${response.status})`);
  const output = await response.arrayBuffer();
  const sha256 = await sha256Hex(output);
  await env.MEDIA_BUCKET.put(objectKey, output, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: {
      immutable: "true",
      schema: "tmg.storyboard-brand-card.v1.1",
      cardType: input.cardType,
      sourceDerivativeSha256: derivative.sha256,
      approvedLogoSha256: input.imageManifest.approvedLogo.sha256,
      sha256,
      textRenderedInImage: "false",
      humanReviewRequired: "true",
      publicationAuthority: "false",
      externalDistributionAuthority: "false",
    },
  });
  return {
    schemaVersion: "tmg.storyboard-brand-card.v1.1",
    artifactId: `card-${sha256.slice(0, 32)}`,
    cardType: input.cardType,
    variantId: input.variant.variantId,
    targetProfileId: input.variant.targetProfile.profileId,
    objectKey,
    sha256,
    bytes: output.byteLength,
    contentType: "image/webp",
    width,
    height,
    exactApprovedLogoOverlayApplied: true,
    sourceDerivativeSha256: derivative.sha256,
    approvedLogoSha256: input.imageManifest.approvedLogo.sha256,
    verifiedCopy: input.cardType === "title"
      ? { headline: input.variant.hook, supportingText: input.variant.valueProposition }
      : { headline: input.variant.callToAction, supportingText: input.variant.valueProposition, callToAction: input.variant.callToAction },
    textRenderedInImage: false,
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  };
}

export class StoryboardBrandCompositionWorkflow extends WorkflowEntrypoint<Env, StoryboardBrandWorkflowParams> {
  async run(
    event: WorkflowEvent<StoryboardBrandWorkflowParams>,
    step: WorkflowStep,
  ): Promise<StoryboardBrandWorkflowResult> {
    requireBindings(this.env);
    const params = await step.do("validate storyboard brand request", async () => {
      assertParams(event.payload);
      return event.payload;
    });

    const brief = await step.do("load governed creative brief", async () => {
      const { value } = await readJsonText<MarketingCreativeBrief>(this.env.MEDIA_BUCKET, params.creativeBriefKey);
      if (
        value.schemaVersion !== "tmg.marketing-creative-brief.v1" ||
        value.requestId !== params.requestId ||
        value.tenantId !== params.tenantId ||
        value.humanReviewRequired !== true ||
        value.publicationAuthority !== false ||
        value.externalDistributionAuthority !== false
      ) throw new Error("creative brief identity or governance mismatch");
      return value;
    });

    const enhancedManifest = await step.do("enhance authorized ImageAssetManifest for composition", async () => {
      const { value, text } = await readJsonText<ImageAssetManifest>(this.env.MEDIA_BUCKET, params.imageAssetManifestKey);
      if (value.requestId !== params.requestId || value.tenantId !== params.tenantId) {
        throw new Error("ImageAssetManifest identity mismatch");
      }
      const enhanced = enhanceImageAssetManifest({
        manifest: value,
        sourceManifestKey: params.imageAssetManifestKey,
        sourceManifestSha256: await sha256Hex(text),
      });
      await putImmutableJson(
        this.env.MEDIA_BUCKET,
        enhancedImageAssetManifestKey(params.tenantId, params.requestId),
        enhanced,
        enhanced.schemaVersion,
      );
      return enhanced;
    });

    const plans = await step.do("compile multi-shot storyboard and composition plans", async () =>
      compileStoryboardTargetPlans({ brief, imageManifest: enhancedManifest }),
    );

    const targets: StoryboardManifestTarget[] = [];
    for (const targetPlan of plans) {
      const variant = brief.variants.find((candidate) => candidate.variantId === targetPlan.variantId);
      if (!variant) throw new Error(`creative variant ${targetPlan.variantId} disappeared during storyboard planning`);
      const shots: StoryboardManifestTarget["shots"] = [];
      for (const shot of targetPlan.shots) {
        const generated = await step.do(
          `generate FLUX shot ${variant.variantId} ${shot.shotId}`,
          { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" },
          async () => generateShotFrame(this.env, {
            tenantId: params.tenantId,
            requestId: params.requestId,
            variant,
            shot,
          }),
        );
        const composed = await step.do(
          `compose exact brand assets ${variant.variantId} ${shot.shotId}`,
          { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "3 minutes" },
          async () => composeShotFrame(this.env, {
            tenantId: params.tenantId,
            requestId: params.requestId,
            variant,
            shot,
            generated,
          }),
        );
        shots.push({ ...shot, generatedFrame: generated, composedFrame: composed });
      }
      const titleCard = await step.do(
        `render title card ${variant.variantId}`,
        { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "3 minutes" },
        async () => renderBrandCard(this.env, {
          tenantId: params.tenantId,
          requestId: params.requestId,
          variant,
          imageManifest: enhancedManifest,
          cardType: "title",
        }),
      );
      const endCard = await step.do(
        `render end card ${variant.variantId}`,
        { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "3 minutes" },
        async () => renderBrandCard(this.env, {
          tenantId: params.tenantId,
          requestId: params.requestId,
          variant,
          imageManifest: enhancedManifest,
          cardType: "end",
        }),
      );
      targets.push({
        variantId: targetPlan.variantId,
        targetProfile: targetPlan.targetProfile,
        target: targetPlan.target,
        creativeAngle: targetPlan.creativeAngle,
        shots,
        titleCard,
        endCard,
      });
    }

    const createdAt = params.requestedAt;
    const enhancedKey = enhancedImageAssetManifestKey(params.tenantId, params.requestId);
    const manifestKey = storyboardManifestObjectKey(params.tenantId, params.requestId);
    const manifest: StoryboardManifestV1_1 = {
      schemaVersion: "tmg.storyboard-manifest.v1.1",
      requestId: params.requestId,
      tenantId: params.tenantId,
      creativeBriefKey: params.creativeBriefKey,
      imageAssetManifestKey: params.imageAssetManifestKey,
      enhancedImageAssetManifestKey: enhancedKey,
      renderer: {
        conceptProvider: "cloudflare_workers_ai",
        conceptModel: WORKERS_AI_STORYBOARD_MODEL,
        compositionProvider: "cloudflare_images_binding",
        deterministicExactAssetComposition: true,
      },
      targets,
      governance: {
        humanReviewRequired: true,
        publicationAuthority: false,
        externalDistributionAuthority: false,
      },
      createdAt,
    };
    await step.do("persist immutable StoryboardManifest", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, manifestKey, manifest, manifest.schemaVersion);
    });

    const renderPlan = compileVideoRenderPlan({ manifest, storyboardManifestKey: manifestKey });
    const renderPlanKey = videoRenderPlanObjectKey(params.tenantId, params.requestId);
    await step.do("persist disabled paid VideoRenderPlan handoff", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, renderPlanKey, renderPlan, renderPlan.schemaVersion);
    });

    const reviewPackageKey = storyboardBrandReviewPackageObjectKey(params.tenantId, params.requestId);
    const shotCount = targets.reduce((sum, target) => sum + target.shots.length, 0);
    const reviewPackage: StoryboardBrandReviewPackageV1_1 = {
      schemaVersion: "tmg.storyboard-brand-review-package.v1.1",
      requestId: params.requestId,
      tenantId: params.tenantId,
      storyboardManifestKey: manifestKey,
      enhancedImageAssetManifestKey: enhancedKey,
      videoRenderPlanKey: renderPlanKey,
      targetCount: targets.length,
      shotCount,
      humanReviewRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
      createdAt,
    };
    await step.do("persist storyboard brand review package", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, reviewPackageKey, reviewPackage, reviewPackage.schemaVersion);
    });

    return {
      status: "ready_for_review",
      requestId: params.requestId,
      tenantId: params.tenantId,
      enhancedImageAssetManifestKey: enhancedKey,
      storyboardManifestKey: manifestKey,
      videoRenderPlanKey: renderPlanKey,
      reviewPackageKey,
      targetCount: targets.length,
      shotCount,
      publicationAuthority: false,
      externalDistributionAuthority: false,
    };
  }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({
      service: "tmg-storyboard-brand-composition",
      version: "v1.1",
      conceptModel: WORKERS_AI_STORYBOARD_MODEL,
      exactBrandComposition: true,
      pVideoExecutionAuthorized: false,
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
