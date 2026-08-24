import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  IMAGE_BINDING_MAX_INPUT_BYTES,
  imageAssetManifestKey,
  imageCampaignReviewPackageKey,
  imageDerivativeObjectKey,
  parseImageProcessingRequest,
  targetPresets,
  type ImageAssetManifest,
  type ImageCampaignReviewPackage,
  type ImageDerivativeArtifact,
  type ImageProcessingRequest,
  type ImageTechnicalInspection,
  type ImageTargetPreset,
} from "./image-runtime";

interface ImageRuntimeResult {
  status: "ready_for_review";
  requestId: string;
  manifestKey: string;
  reviewPackageKey: string;
  derivativeCount: number;
}

interface InspectedInput {
  sha256: string;
  bytes: number;
  inspection: ImageTechnicalInspection;
}

function requireImages(env: Env): NonNullable<Env["IMAGES"]> {
  if (!env.IMAGES) throw new Error("Cloudflare Images binding is not configured");
  return env.IMAGES;
}

function requireImageRuntime(env: Env): void {
  if (String(env.TMG_IMAGE_RUNTIME_ENABLED ?? "false") !== "true") {
    throw new Error("TMG image runtime is disabled");
  }
  requireImages(env);
}

function bytesToStream(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream();
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeInspection(value: unknown): ImageTechnicalInspection {
  if (!value || typeof value !== "object") throw new Error("Cloudflare Images returned invalid inspection metadata");
  const record = value as Record<string, unknown>;
  const width = Number(record.width);
  const height = Number(record.height);
  const fileSize = Number(record.fileSize);
  const format = typeof record.format === "string" ? record.format : "unknown";
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("image technical inspection returned invalid dimensions");
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error("image technical inspection returned invalid file size");
  }
  return { format, width, height, fileSize };
}

async function readAndInspect(
  env: Env,
  input: { objectKey: string; expectedSha256: string; mimeType: string; label: string },
): Promise<InspectedInput> {
  const object = await env.MEDIA_BUCKET.get(input.objectKey);
  if (!object) throw new Error(`${input.label} R2 object is missing`);
  if (object.size <= 0 || object.size > IMAGE_BINDING_MAX_INPUT_BYTES) {
    throw new Error(`${input.label} exceeds the Cloudflare Images binding input boundary`);
  }
  const bytes = await object.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== input.expectedSha256) {
    throw new Error(`${input.label} SHA-256 does not match the authorized request`);
  }
  const inspection = normalizeInspection(await requireImages(env).info(bytesToStream(bytes)));
  if (inspection.fileSize !== object.size) {
    throw new Error(`${input.label} technical inspection byte count does not match R2 evidence`);
  }
  if (inspection.format !== input.mimeType) {
    throw new Error(`${input.label} decoded format does not match the authorized MIME type`);
  }
  return { sha256, bytes: object.size, inspection };
}

function assertRightsGate(request: ImageProcessingRequest): void {
  if (request.rights.evidenceState !== "verified") throw new Error("image rights evidence is not verified");
  if (request.rights.purpose !== "marketing_creative") throw new Error("image rights evidence does not grant marketing creative use");
  if (request.source.reuseAuthorized !== true) throw new Error("source image reuse is not authorized");
  if (request.logo.overlayAuthorized !== true) throw new Error("logo overlay is not authorized");
}

async function existingDerivative(
  env: Env,
  request: ImageProcessingRequest,
  preset: ImageTargetPreset,
  sourceSha256: string,
  logoSha256: string,
): Promise<ImageDerivativeArtifact | null> {
  const objectKey = imageDerivativeObjectKey(request.tenantId, request.requestId, preset.presetId);
  const existing = await env.MEDIA_BUCKET.head(objectKey);
  if (!existing) return null;
  const metadata = existing.customMetadata ?? {};
  if (
    metadata.sourceSha256 !== sourceSha256 ||
    metadata.logoSha256 !== logoSha256 ||
    metadata.presetId !== preset.presetId ||
    metadata.rightsEvidenceRef !== request.rights.evidenceRef ||
    !metadata.sha256
  ) {
    throw new Error(`immutable image derivative conflict: ${objectKey}`);
  }
  return {
    artifactId: `${request.requestId}-${preset.presetId}`,
    presetId: preset.presetId,
    platform: preset.platform,
    objectKey,
    sha256: metadata.sha256,
    bytes: existing.size,
    mimeType: "image/webp",
    width: preset.width,
    height: preset.height,
    aspectRatio: preset.aspectRatio,
    sourceSha256,
    logoSha256,
    exactApprovedLogoOverlayApplied: true,
    humanReviewRequired: true,
    publicationAuthority: false,
  };
}

async function renderDerivative(
  env: Env,
  request: ImageProcessingRequest,
  preset: ImageTargetPreset,
  sourceSha256: string,
  logoSha256: string,
): Promise<ImageDerivativeArtifact> {
  const cached = await existingDerivative(env, request, preset, sourceSha256, logoSha256);
  if (cached) return cached;

  const [sourceObject, logoObject] = await Promise.all([
    env.MEDIA_BUCKET.get(request.source.objectKey),
    env.MEDIA_BUCKET.get(request.logo.objectKey),
  ]);
  if (!sourceObject || !logoObject) throw new Error("authorized image inputs disappeared before transformation");
  if (sourceObject.size > IMAGE_BINDING_MAX_INPUT_BYTES || logoObject.size > IMAGE_BINDING_MAX_INPUT_BYTES) {
    throw new Error("image input exceeds Cloudflare Images binding limit");
  }

  const [sourceBytes, logoBytes] = await Promise.all([sourceObject.arrayBuffer(), logoObject.arrayBuffer()]);
  const [verifiedSourceSha, verifiedLogoSha] = await Promise.all([sha256Hex(sourceBytes), sha256Hex(logoBytes)]);
  if (verifiedSourceSha !== sourceSha256 || verifiedLogoSha !== logoSha256) {
    throw new Error("authorized image input changed after technical inspection");
  }

  const images = requireImages(env);
  const logoWidth = Math.max(64, Math.round(preset.width * preset.logoWidthRatio));
  const inset = Math.max(24, Math.round(Math.min(preset.width, preset.height) * preset.logoInsetRatio));
  const transformed = images
    .input(bytesToStream(sourceBytes))
    .transform({ width: preset.width, height: preset.height, fit: preset.fit })
    .draw(
      images.input(bytesToStream(logoBytes)).transform({ width: logoWidth }),
      { right: inset, bottom: inset, opacity: 1 },
    );
  const response = (await transformed.output({ format: preset.format, quality: preset.quality, anim: false })).response();
  if (!response.ok || !response.body) throw new Error(`Cloudflare Images transformation failed (${response.status})`);
  const outputBytes = await response.arrayBuffer();
  if (outputBytes.byteLength <= 0 || outputBytes.byteLength > IMAGE_BINDING_MAX_INPUT_BYTES) {
    throw new Error("image derivative failed output size boundary");
  }
  const outputSha256 = await sha256Hex(outputBytes);
  const objectKey = imageDerivativeObjectKey(request.tenantId, request.requestId, preset.presetId);
  await env.MEDIA_BUCKET.put(objectKey, outputBytes, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: {
      immutable: "true",
      schema: "tmg.image-artifact.v1",
      requestId: request.requestId,
      tenantId: request.tenantId,
      presetId: preset.presetId,
      sourceSha256,
      logoSha256,
      sha256: outputSha256,
      rightsEvidenceRef: request.rights.evidenceRef,
      humanReviewRequired: "true",
      publicationAuthority: "false",
    },
  });

  return {
    artifactId: `${request.requestId}-${preset.presetId}`,
    presetId: preset.presetId,
    platform: preset.platform,
    objectKey,
    sha256: outputSha256,
    bytes: outputBytes.byteLength,
    mimeType: "image/webp",
    width: preset.width,
    height: preset.height,
    aspectRatio: preset.aspectRatio,
    sourceSha256,
    logoSha256,
    exactApprovedLogoOverlayApplied: true,
    humanReviewRequired: true,
    publicationAuthority: false,
  };
}

async function putImmutableJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  const existing = await bucket.get(key);
  if (existing) {
    const current = await existing.text();
    if (current !== serialized) throw new Error(`immutable image control artifact conflict: ${key}`);
    return;
  }
  await bucket.put(key, serialized, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { immutable: "true", schema: "tmg-image-runtime-v1" },
  });
}

export class ImageProcessingWorkflow extends WorkflowEntrypoint<Env, ImageProcessingRequest> {
  async run(
    event: WorkflowEvent<ImageProcessingRequest>,
    step: WorkflowStep,
  ): Promise<ImageRuntimeResult> {
    requireImageRuntime(this.env);

    const request = await step.do("validate governed image processing request", async () =>
      parseImageProcessingRequest(event.payload),
    );

    const inspection = await step.do("hash and technically inspect authorized image inputs", async () => {
      const [source, logo] = await Promise.all([
        readAndInspect(this.env, {
          objectKey: request.source.objectKey,
          expectedSha256: request.source.expectedSha256,
          mimeType: request.source.mimeType,
          label: "source image",
        }),
        readAndInspect(this.env, {
          objectKey: request.logo.objectKey,
          expectedSha256: request.logo.expectedSha256,
          mimeType: request.logo.mimeType,
          label: "approved logo",
        }),
      ]);
      return { source, logo };
    });

    await step.do("enforce image rights and exact-logo overlay authority", async () => {
      assertRightsGate(request);
    });

    const derivatives: ImageDerivativeArtifact[] = [];
    for (const preset of targetPresets(request.targets)) {
      const artifact = await step.do(
        `render governed image preset ${preset.presetId}`,
        { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "3 minutes" },
        async () => renderDerivative(
          this.env,
          request,
          preset,
          inspection.source.sha256,
          inspection.logo.sha256,
        ),
      );
      derivatives.push(artifact);
    }

    const processedAt = event.timestamp.toISOString();
    const manifest: ImageAssetManifest = {
      schemaVersion: "tmg.image-asset-manifest.v1",
      requestId: request.requestId,
      tenantId: request.tenantId,
      source: {
        artifactId: request.source.artifactId,
        objectKey: request.source.objectKey,
        sha256: inspection.source.sha256,
        bytes: inspection.source.bytes,
        mimeType: request.source.mimeType,
        authorityRef: request.source.authorityRef,
        inspection: inspection.source.inspection,
      },
      approvedLogo: {
        artifactId: request.logo.artifactId,
        objectKey: request.logo.objectKey,
        sha256: inspection.logo.sha256,
        bytes: inspection.logo.bytes,
        mimeType: request.logo.mimeType,
        authorityRef: request.logo.authorityRef,
        inspection: inspection.logo.inspection,
      },
      rights: {
        evidenceRef: request.rights.evidenceRef,
        evidenceState: "verified",
        purpose: "marketing_creative",
        sourceReuseAuthorized: true,
        logoOverlayAuthorized: true,
      },
      derivatives,
      provenance: {
        processor: "cloudflare_images_binding",
        sourceStorage: "cloudflare_r2",
        transformationVersion: "tmg.image-runtime.v1",
        processedAt,
      },
      governance: {
        humanReviewRequired: true,
        publicationAuthority: false,
        externalDistributionAuthority: false,
      },
    };

    const manifestKey = imageAssetManifestKey(request.tenantId, request.requestId);
    await step.do("persist immutable ImageAssetManifest", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, manifestKey, manifest);
    });

    const reviewPackage: ImageCampaignReviewPackage = {
      schemaVersion: "tmg.image-campaign-review-package.v1",
      requestId: request.requestId,
      tenantId: request.tenantId,
      imageAssetManifestKey: manifestKey,
      derivatives: derivatives.map((artifact) => ({
        artifactId: artifact.artifactId,
        presetId: artifact.presetId,
        platform: artifact.platform,
        objectKey: artifact.objectKey,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        mimeType: artifact.mimeType,
        width: artifact.width,
        height: artifact.height,
        aspectRatio: artifact.aspectRatio,
      })),
      humanReviewRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
      createdAt: processedAt,
    };
    const reviewPackageKey = imageCampaignReviewPackageKey(request.tenantId, request.requestId);
    await step.do("persist image campaign review package", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, reviewPackageKey, reviewPackage);
    });

    return {
      status: "ready_for_review",
      requestId: request.requestId,
      manifestKey,
      reviewPackageKey,
      derivativeCount: derivatives.length,
    };
  }
}
