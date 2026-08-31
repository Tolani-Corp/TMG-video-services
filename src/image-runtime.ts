import { z } from "zod";

export const IMAGE_PRESET_IDS = [
  "tiktok.cover.v1",
  "youtube.thumbnail.v1",
  "instagram.square.v1",
  "web.hero.v1",
] as const;

export type ImagePresetId = (typeof IMAGE_PRESET_IDS)[number];

export interface ImageTargetPreset {
  presetId: ImagePresetId;
  platform: "tiktok" | "youtube" | "instagram" | "website";
  width: number;
  height: number;
  aspectRatio: "9:16" | "16:9" | "1:1";
  fit: "cover";
  format: "image/webp";
  quality: number;
  logoWidthRatio: number;
  logoInsetRatio: number;
}

export const IMAGE_TARGET_PRESETS: Record<ImagePresetId, ImageTargetPreset> = {
  "tiktok.cover.v1": {
    presetId: "tiktok.cover.v1",
    platform: "tiktok",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    fit: "cover",
    format: "image/webp",
    quality: 86,
    logoWidthRatio: 0.2,
    logoInsetRatio: 0.04,
  },
  "youtube.thumbnail.v1": {
    presetId: "youtube.thumbnail.v1",
    platform: "youtube",
    width: 1280,
    height: 720,
    aspectRatio: "16:9",
    fit: "cover",
    format: "image/webp",
    quality: 88,
    logoWidthRatio: 0.18,
    logoInsetRatio: 0.035,
  },
  "instagram.square.v1": {
    presetId: "instagram.square.v1",
    platform: "instagram",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
    fit: "cover",
    format: "image/webp",
    quality: 86,
    logoWidthRatio: 0.2,
    logoInsetRatio: 0.04,
  },
  "web.hero.v1": {
    presetId: "web.hero.v1",
    platform: "website",
    width: 1600,
    height: 900,
    aspectRatio: "16:9",
    fit: "cover",
    format: "image/webp",
    quality: 88,
    logoWidthRatio: 0.16,
    logoInsetRatio: 0.035,
  },
};

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const objectKeySchema = z.string().trim().min(1).max(1024).refine((value) => !value.startsWith("/"), {
  message: "R2 object keys must be relative",
});

const sourceAssetSchema = z.object({
  artifactId: z.string().trim().min(1).max(160),
  objectKey: objectKeySchema,
  expectedSha256: sha256HexSchema,
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  authorityRef: z.string().trim().min(1).max(1024),
  reuseAuthorized: z.literal(true),
});

const logoAssetSchema = z.object({
  artifactId: z.string().trim().min(1).max(160),
  objectKey: objectKeySchema,
  expectedSha256: sha256HexSchema,
  mimeType: z.enum(["image/png", "image/webp"]),
  authorityRef: z.string().trim().min(1).max(1024),
  overlayAuthorized: z.literal(true),
});

export const imageProcessingRequestSchema = z.object({
  schemaVersion: z.literal("tmg.image-processing-request.v1"),
  requestId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/),
  tenantId: z.string().trim().min(2).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  source: sourceAssetSchema,
  logo: logoAssetSchema,
  rights: z.object({
    evidenceRef: z.string().trim().min(1).max(2048),
    evidenceState: z.literal("verified"),
    purpose: z.literal("marketing_creative"),
  }),
  targets: z.array(z.enum(IMAGE_PRESET_IDS)).min(1).max(IMAGE_PRESET_IDS.length).transform((values) => [...new Set(values)]),
  governance: z.object({
    humanReviewRequired: z.literal(true),
    publicationAuthority: z.literal(false),
    externalDistributionAuthority: z.literal(false),
  }),
});

export type ImageProcessingRequest = z.infer<typeof imageProcessingRequestSchema>;

export interface ImageTechnicalInspection {
  format: string;
  width: number;
  height: number;
  fileSize: number;
}

export interface ImageDerivativeArtifact {
  artifactId: string;
  presetId: ImagePresetId;
  platform: ImageTargetPreset["platform"];
  objectKey: string;
  sha256: string;
  bytes: number;
  mimeType: "image/webp";
  width: number;
  height: number;
  aspectRatio: ImageTargetPreset["aspectRatio"];
  sourceSha256: string;
  logoSha256: string;
  exactApprovedLogoOverlayApplied: true;
  humanReviewRequired: true;
  publicationAuthority: false;
}

export interface ImageAssetManifest {
  schemaVersion: "tmg.image-asset-manifest.v1";
  requestId: string;
  tenantId: string;
  source: {
    artifactId: string;
    objectKey: string;
    sha256: string;
    bytes: number;
    mimeType: string;
    authorityRef: string;
    inspection: ImageTechnicalInspection;
  };
  approvedLogo: {
    artifactId: string;
    objectKey: string;
    sha256: string;
    bytes: number;
    mimeType: string;
    authorityRef: string;
    inspection: ImageTechnicalInspection;
  };
  rights: {
    evidenceRef: string;
    evidenceState: "verified";
    purpose: "marketing_creative";
    sourceReuseAuthorized: true;
    logoOverlayAuthorized: true;
  };
  derivatives: ImageDerivativeArtifact[];
  provenance: {
    processor: "cloudflare_images_binding";
    sourceStorage: "cloudflare_r2";
    transformationVersion: "tmg.image-runtime.v1";
    processedAt: string;
  };
  governance: {
    humanReviewRequired: true;
    publicationAuthority: false;
    externalDistributionAuthority: false;
  };
}

export interface ImageCampaignReviewPackage {
  schemaVersion: "tmg.image-campaign-review-package.v1";
  requestId: string;
  tenantId: string;
  imageAssetManifestKey: string;
  derivatives: Array<Pick<ImageDerivativeArtifact, "artifactId" | "presetId" | "platform" | "objectKey" | "sha256" | "bytes" | "mimeType" | "width" | "height" | "aspectRatio">>;
  humanReviewRequired: true;
  publicationAuthority: false;
  externalDistributionAuthority: false;
  createdAt: string;
}

export const IMAGE_BINDING_MAX_INPUT_BYTES = 20 * 1024 * 1024;

export function imageAssetManifestKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/image-runtime/${requestId}/control/image-asset-manifest-v1.json`;
}

export function imageCampaignReviewPackageKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/image-runtime/${requestId}/review/image-campaign-review-package-v1.json`;
}

export function imageDerivativeObjectKey(tenantId: string, requestId: string, presetId: ImagePresetId): string {
  return `tenants/${tenantId}/image-runtime/${requestId}/derivatives/${presetId}.webp`;
}

export function assertTenantScopedImageRequest(request: ImageProcessingRequest): void {
  const prefix = `tenants/${request.tenantId}/`;
  if (!request.source.objectKey.startsWith(prefix)) {
    throw new Error("image source object must be scoped to the request tenant");
  }
  if (!request.logo.objectKey.startsWith(prefix)) {
    throw new Error("approved logo object must be scoped to the request tenant");
  }
  if (request.source.objectKey === request.logo.objectKey) {
    throw new Error("source image and approved logo must be distinct R2 objects");
  }
}

export function parseImageProcessingRequest(value: unknown): ImageProcessingRequest {
  const request = imageProcessingRequestSchema.parse(value);
  assertTenantScopedImageRequest(request);
  return request;
}

export function targetPresets(ids: readonly ImagePresetId[]): ImageTargetPreset[] {
  return ids.map((id) => IMAGE_TARGET_PRESETS[id]);
}
