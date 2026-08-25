import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { ImageAssetManifest } from "./image-runtime";
import type { MarketingCreativeBrief, MarketingCreativeVariant } from "./marketing-creative";
import {
  STORYBOARD_MANIFEST_VERSION,
  buildStoryboardCardSpecs,
  buildStoryboardShotPlans,
  buildVideoRenderPlan,
  storyboardComposedFrameKey,
  storyboardManifestV11Key,
  storyboardRawFrameKey,
  videoRenderPlanV1Key,
  type StoryboardFrameEvidence,
  type StoryboardManifestV11,
  type StoryboardShotPlan,
  type StoryboardTargetManifest,
} from "./storyboard-brand-composition";

const MODEL = "@cf/black-forest-labs/flux-1-schnell" as const;
const DIFFUSION_STEPS = 4 as const;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface StoryboardBrandCompositionWorkflowParams {
  schemaVersion: "tmg.storyboard-brand-composition-request.v1.1";
  requestId: string;
  tenantId: string;
  creativeBriefKey: string;
  imageAssetManifestKey: string;
  requestedAt: string;
}

export interface StoryboardBrandCompositionWorkflowResult {
  status: "ready_for_review";
  requestId: string;
  tenantId: string;
  storyboardManifestKey: string;
  videoRenderPlanKey: string;
  targetCount: number;
  shotCount: number;
  publicationAuthority: false;
  paidProviderExecutionAuthorized: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertParams(value: unknown): asserts value is StoryboardBrandCompositionWorkflowParams {
  if (!isRecord(value)) throw new Error("storyboard brand composition request is required");
  if (value.schemaVersion !== "tmg.storyboard-brand-composition-request.v1.1") {
    throw new Error("unsupported storyboard brand composition request version");
  }
  const requestId = value.requestId;
  const tenantId = value.tenantId;
  const creativeBriefKey = value.creativeBriefKey;
  const imageAssetManifestKey = value.imageAssetManifestKey;
  const requestedAt = value.requestedAt;
  for (const [name, field] of Object.entries({ requestId, tenantId, creativeBriefKey, imageAssetManifestKey, requestedAt })) {
    if (typeof field !== "string" || !field.trim()) throw new Error(`storyboard brand composition ${name} is required`);
  }
  if (creativeBriefKey !== `tenants/${tenantId}/production-requests/${requestId}/marketing/creative-brief-v1.json`) {
    throw new Error("creative brief is outside the canonical production request scope");
  }
  const imagePrefix = `tenants/${tenantId}/image-runtime/`;
  if (!imageAssetManifestKey.startsWith(imagePrefix) || !imageAssetManifestKey.endsWith("/control/image-asset-manifest-v1.json")) {
    throw new Error("ImageAssetManifest is outside the canonical tenant image-runtime scope");
  }
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`required storyboard v1.1 artifact is missing: ${key}`);
  return object.json<T>();
}

async function putImmutableJson(bucket: R2Bucket, key: string, value: unknown, schema: string): Promise<void> {
  const serialized = JSON.stringify(value);
  const existing = await bucket.get(key);
  if (existing) {
    if (await existing.text() !== serialized) throw new Error(`immutable storyboard v1.1 control artifact conflict: ${key}`);
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

function requireAi(env: Env): NonNullable<Env["AI"]> {
  if (!env.AI) throw new Error("Workers AI binding is not configured for storyboard v1.1");
  return env.AI;
}

function requireImages(env: Env): NonNullable<Env["IMAGES"]> {
  if (!env.IMAGES) throw new Error("Cloudflare Images binding is not configured for storyboard v1.1");
  return env.IMAGES;
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.trim().replace(/\s+/g, "");
  if (!compact || compact.length > MAX_IMAGE_BYTES * 2) throw new Error("Workers AI storyboard frame is missing or oversized");
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new Error("Workers AI storyboard frame is not valid base64");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Workers AI storyboard frame violates size boundary");
  return bytes;
}

function detectImageType(bytes: Uint8Array): { mimeType: "image/jpeg" | "image/png"; extension: "jpg" | "png" } {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: "png" };
  }
  throw new Error("Workers AI storyboard frame is not JPEG or PNG");
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const owned = bytes instanceof Uint8Array ? Uint8Array.from(bytes).buffer : bytes.slice(0);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToStream(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream();
}

async function verifiedApprovedLogo(env: Env, manifest: ImageAssetManifest): Promise<ArrayBuffer> {
  const object = await env.MEDIA_BUCKET.get(manifest.approvedLogo.objectKey);
  if (!object) throw new Error("approved logo object is missing before storyboard composition");
  if (object.size <= 0 || object.size > MAX_IMAGE_BYTES) throw new Error("approved logo violates image size boundary");
  const bytes = await object.arrayBuffer();
  if (await sha256Hex(bytes) !== manifest.approvedLogo.sha256) {
    throw new Error("approved logo SHA-256 no longer matches ImageAssetManifest");
  }
  return bytes;
}

async function generateAndComposeShot(input: {
  env: Env;
  params: StoryboardBrandCompositionWorkflowParams;
  imageManifest: ImageAssetManifest;
  variant: MarketingCreativeVariant;
  plan: StoryboardShotPlan;
}): Promise<StoryboardFrameEvidence> {
  const rawCandidates = ["jpg", "png"] as const;
  for (const extension of rawCandidates) {
    const rawKey = storyboardRawFrameKey({
      tenantId: input.params.tenantId,
      requestId: input.params.requestId,
      targetProfileId: input.plan.targetProfileId,
      shotId: input.plan.shotId,
      extension,
    });
    const composedKey = storyboardComposedFrameKey({
      tenantId: input.params.tenantId,
      requestId: input.params.requestId,
      targetProfileId: input.plan.targetProfileId,
      shotId: input.plan.shotId,
    });
    const [raw, composed] = await Promise.all([input.env.MEDIA_BUCKET.head(rawKey), input.env.MEDIA_BUCKET.head(composedKey)]);
    if (!raw && !composed) continue;
    if (!raw || !composed) throw new Error(`partial immutable storyboard shot conflict: ${input.plan.shotId}`);
    const rawMeta = raw.customMetadata ?? {};
    const composedMeta = composed.customMetadata ?? {};
    if (
      rawMeta.shotId !== input.plan.shotId || rawMeta.prompt !== input.plan.prompt || !rawMeta.sha256 ||
      composedMeta.shotId !== input.plan.shotId || composedMeta.rawFrameSha256 !== rawMeta.sha256 ||
      composedMeta.approvedLogoSha256 !== input.imageManifest.approvedLogo.sha256 || !composedMeta.sha256
    ) {
      throw new Error(`immutable storyboard shot metadata conflict: ${input.plan.shotId}`);
    }
    return {
      shotId: input.plan.shotId,
      rawFrame: {
        objectKey: rawKey,
        sha256: rawMeta.sha256,
        bytes: raw.size,
        mimeType: extension === "jpg" ? "image/jpeg" : "image/png",
        provider: "cloudflare_workers_ai",
        model: MODEL,
      },
      composedFrame: {
        objectKey: composedKey,
        sha256: composedMeta.sha256,
        bytes: composed.size,
        mimeType: "image/webp",
        exactApprovedLogoOverlayApplied: true,
        approvedLogoSha256: input.imageManifest.approvedLogo.sha256,
      },
    };
  }

  const response = await requireAi(input.env).run(MODEL, {
    prompt: input.plan.prompt,
    steps: DIFFUSION_STEPS,
  });
  if (!isRecord(response) || typeof response.image !== "string") {
    throw new Error("Workers AI did not return a storyboard image");
  }
  const rawBytes = decodeBase64(response.image);
  const rawType = detectImageType(rawBytes);
  const rawSha = await sha256Hex(rawBytes);
  const rawKey = storyboardRawFrameKey({
    tenantId: input.params.tenantId,
    requestId: input.params.requestId,
    targetProfileId: input.plan.targetProfileId,
    shotId: input.plan.shotId,
    extension: rawType.extension,
  });
  await input.env.MEDIA_BUCKET.put(rawKey, rawBytes, {
    httpMetadata: { contentType: rawType.mimeType },
    customMetadata: {
      immutable: "true",
      schema: "tmg.storyboard-raw-frame.v1.1",
      requestId: input.params.requestId,
      tenantId: input.params.tenantId,
      shotId: input.plan.shotId,
      targetProfileId: input.plan.targetProfileId,
      prompt: input.plan.prompt,
      sha256: rawSha,
      provider: "cloudflare_workers_ai",
      model: MODEL,
      diffusionSteps: String(DIFFUSION_STEPS),
      humanReviewRequired: "true",
      publicationAuthority: "false",
    },
  });

  const logoBytes = await verifiedApprovedLogo(input.env, input.imageManifest);
  const logoWidth = Math.max(72, Math.round(input.plan.width * 0.16));
  const inset = Math.max(24, Math.round(Math.min(input.plan.width, input.plan.height) * 0.035));
  const images = requireImages(input.env);
  const composedResponse = (
    await images
      .input(new Blob([Uint8Array.from(rawBytes)]).stream())
      .transform({ width: input.plan.width, height: input.plan.height, fit: "cover" })
      .draw(images.input(bytesToStream(logoBytes)).transform({ width: logoWidth }), {
        right: inset,
        bottom: inset,
        opacity: 1,
      })
      .output({ format: "image/webp", quality: 88, anim: false })
  ).response();
  if (!composedResponse.ok || !composedResponse.body) {
    throw new Error(`Cloudflare Images storyboard composition failed (${composedResponse.status})`);
  }
  const composedBytes = await composedResponse.arrayBuffer();
  if (composedBytes.byteLength <= 0 || composedBytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("composed storyboard frame violates image size boundary");
  }
  const composedSha = await sha256Hex(composedBytes);
  const composedKey = storyboardComposedFrameKey({
    tenantId: input.params.tenantId,
    requestId: input.params.requestId,
    targetProfileId: input.plan.targetProfileId,
    shotId: input.plan.shotId,
  });
  await input.env.MEDIA_BUCKET.put(composedKey, composedBytes, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: {
      immutable: "true",
      schema: "tmg.storyboard-composed-frame.v1.1",
      requestId: input.params.requestId,
      tenantId: input.params.tenantId,
      shotId: input.plan.shotId,
      targetProfileId: input.plan.targetProfileId,
      rawFrameSha256: rawSha,
      approvedLogoSha256: input.imageManifest.approvedLogo.sha256,
      rightsEvidenceRef: input.imageManifest.rights.evidenceRef,
      sha256: composedSha,
      exactApprovedLogoOverlayApplied: "true",
      humanReviewRequired: "true",
      publicationAuthority: "false",
      externalDistributionAuthority: "false",
    },
  });

  return {
    shotId: input.plan.shotId,
    rawFrame: {
      objectKey: rawKey,
      sha256: rawSha,
      bytes: rawBytes.byteLength,
      mimeType: rawType.mimeType,
      provider: "cloudflare_workers_ai",
      model: MODEL,
    },
    composedFrame: {
      objectKey: composedKey,
      sha256: composedSha,
      bytes: composedBytes.byteLength,
      mimeType: "image/webp",
      exactApprovedLogoOverlayApplied: true,
      approvedLogoSha256: input.imageManifest.approvedLogo.sha256,
    },
  };
}

export class StoryboardBrandCompositionWorkflow extends WorkflowEntrypoint<Env, StoryboardBrandCompositionWorkflowParams> {
  async run(
    event: WorkflowEvent<StoryboardBrandCompositionWorkflowParams>,
    step: WorkflowStep,
  ): Promise<StoryboardBrandCompositionWorkflowResult> {
    const params = await step.do("validate storyboard brand composition request", async () => {
      assertParams(event.payload);
      return event.payload;
    });

    const inputs = await step.do("load governed creative and ImageAssetManifest", async () => {
      const [brief, imageManifest] = await Promise.all([
        readJson<MarketingCreativeBrief>(this.env.MEDIA_BUCKET, params.creativeBriefKey),
        readJson<ImageAssetManifest>(this.env.MEDIA_BUCKET, params.imageAssetManifestKey),
      ]);
      if (brief.schemaVersion !== "tmg.marketing-creative-brief.v1" || brief.requestId !== params.requestId || brief.tenantId !== params.tenantId) {
        throw new Error("creative brief identity mismatch for storyboard v1.1");
      }
      if (!brief.contextQuality.generationEligible || brief.humanReviewRequired !== true || brief.publicationAuthority !== false || brief.externalDistributionAuthority !== false) {
        throw new Error("creative brief is not eligible for review-only storyboard v1.1 generation");
      }
      return { brief, imageManifest };
    });

    const plans = await step.do("plan deterministic multi-shot targets", async () =>
      Array.from(buildStoryboardShotPlans(inputs.brief, inputs.imageManifest).entries()),
    );

    const targets: StoryboardTargetManifest[] = [];
    let totalShots = 0;
    for (const [targetProfileId, shotPlans] of plans) {
      const variant = inputs.brief.variants.find((candidate) => candidate.targetProfile.profileId === targetProfileId);
      if (!variant) throw new Error(`creative variant disappeared for ${targetProfileId}`);
      const completed: StoryboardTargetManifest["shots"] = [];
      for (let index = 0; index < shotPlans.length; index += 1) {
        const plan = shotPlans[index];
        if (!plan) throw new Error(`storyboard shot plan ${index + 1} is missing`);
        const evidence = await step.do(
          `render and compose ${targetProfileId} shot ${index + 1}`,
          { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" },
          async () => generateAndComposeShot({
            env: this.env,
            params,
            imageManifest: inputs.imageManifest,
            variant,
            plan,
          }),
        );
        completed.push({ ...plan, evidence });
        totalShots += 1;
      }
      const first = completed[0];
      const last = completed[completed.length - 1];
      if (!first || !last) throw new Error(`storyboard target ${targetProfileId} produced no shots`);
      const cards = buildStoryboardCardSpecs({
        variant,
        firstComposedFrameKey: first.evidence.composedFrame.objectKey,
        lastComposedFrameKey: last.evidence.composedFrame.objectKey,
        imageManifest: inputs.imageManifest,
      });
      targets.push({
        targetProfileId,
        target: variant.target,
        durationSeconds: variant.targetProfile.durationSeconds,
        aspectRatio: variant.targetProfile.aspectRatio,
        shots: completed,
        ...cards,
      });
    }

    const manifestKey = storyboardManifestV11Key(params.tenantId, params.requestId);
    const manifest: StoryboardManifestV11 = {
      schemaVersion: STORYBOARD_MANIFEST_VERSION,
      requestId: params.requestId,
      tenantId: params.tenantId,
      creativeBriefKey: params.creativeBriefKey,
      imageAssetManifestKey: params.imageAssetManifestKey,
      targets,
      rights: {
        evidenceRef: inputs.imageManifest.rights.evidenceRef,
        imageReuseAuthorized: true,
        exactLogoOverlayAuthorized: true,
      },
      provenance: {
        planner: "tmg.storyboard-brand-composition.v1.1",
        generatedImageProvider: "cloudflare_workers_ai",
        generatedImageModel: MODEL,
        exactCompositionProvider: "cloudflare_images_binding",
        createdAt: params.requestedAt,
      },
      governance: {
        humanReviewRequired: true,
        publicationAuthority: false,
        externalDistributionAuthority: false,
      },
    };
    await step.do("persist immutable StoryboardManifest v1.1", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, manifestKey, manifest, STORYBOARD_MANIFEST_VERSION);
    });

    const renderPlanKey = videoRenderPlanV1Key(params.tenantId, params.requestId);
    const renderPlan = buildVideoRenderPlan({
      requestId: params.requestId,
      tenantId: params.tenantId,
      storyboardManifestKey: manifestKey,
      manifest,
      createdAt: params.requestedAt,
    });
    await step.do("persist immutable VideoRenderPlan v1", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, renderPlanKey, renderPlan, "tmg.video-render-plan.v1");
    });

    return {
      status: "ready_for_review",
      requestId: params.requestId,
      tenantId: params.tenantId,
      storyboardManifestKey: manifestKey,
      videoRenderPlanKey: renderPlanKey,
      targetCount: targets.length,
      shotCount: totalShots,
      publicationAuthority: false,
      paidProviderExecutionAuthorized: false,
    };
  }
}
