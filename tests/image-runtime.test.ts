import { describe, expect, it } from "vitest";
import {
  IMAGE_BINDING_MAX_INPUT_BYTES,
  IMAGE_TARGET_PRESETS,
  imageAssetManifestKey,
  imageCampaignReviewPackageKey,
  imageDerivativeObjectKey,
  parseImageProcessingRequest,
  targetPresets,
} from "../src/image-runtime";

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);

function validRequest() {
  return {
    schemaVersion: "tmg.image-processing-request.v1" as const,
    requestId: "image-request-1",
    tenantId: "acme",
    source: {
      artifactId: "source-image-1",
      objectKey: "tenants/acme/uploads/source-image-1.png",
      expectedSha256: shaA,
      mimeType: "image/png" as const,
      authorityRef: "contract://acme/campaign-assets/v1",
      reuseAuthorized: true as const,
    },
    logo: {
      artifactId: "logo-1",
      objectKey: "tenants/acme/uploads/logo-1.png",
      expectedSha256: shaB,
      mimeType: "image/png" as const,
      authorityRef: "brand://acme/logo/v3",
      overlayAuthorized: true as const,
    },
    rights: {
      evidenceRef: "rights://acme/image-campaign/v1",
      evidenceState: "verified" as const,
      purpose: "marketing_creative" as const,
    },
    targets: [
      "tiktok.cover.v1",
      "youtube.thumbnail.v1",
      "instagram.square.v1",
      "web.hero.v1",
    ] as const,
    governance: {
      humanReviewRequired: true as const,
      publicationAuthority: false as const,
      externalDistributionAuthority: false as const,
    },
  };
}

describe("TMG Image Runtime v1", () => {
  it("accepts only explicitly authorized tenant-scoped image inputs", () => {
    const parsed = parseImageProcessingRequest(validRequest());
    expect(parsed.source.reuseAuthorized).toBe(true);
    expect(parsed.logo.overlayAuthorized).toBe(true);
    expect(parsed.rights.evidenceState).toBe("verified");
    expect(parsed.governance.publicationAuthority).toBe(false);
  });

  it("rejects cross-tenant R2 image references", () => {
    const request = validRequest();
    request.source.objectKey = "tenants/other/uploads/source.png";
    expect(() => parseImageProcessingRequest(request)).toThrow(/scoped to the request tenant/);
  });

  it("requires exact approved-logo overlay authority", () => {
    const request = validRequest() as Record<string, any>;
    request.logo.overlayAuthorized = false;
    expect(() => parseImageProcessingRequest(request)).toThrow();
  });

  it("provides deterministic platform image presets", () => {
    const presets = targetPresets([
      "tiktok.cover.v1",
      "youtube.thumbnail.v1",
      "instagram.square.v1",
      "web.hero.v1",
    ]);
    expect(presets.map((preset) => [preset.presetId, preset.width, preset.height])).toEqual([
      ["tiktok.cover.v1", 1080, 1920],
      ["youtube.thumbnail.v1", 1280, 720],
      ["instagram.square.v1", 1080, 1080],
      ["web.hero.v1", 1600, 900],
    ]);
    expect(presets.every((preset) => preset.format === "image/webp")).toBe(true);
    expect(IMAGE_TARGET_PRESETS["tiktok.cover.v1"].aspectRatio).toBe("9:16");
  });

  it("uses immutable tenant/request-scoped control and derivative keys", () => {
    expect(imageAssetManifestKey("acme", "request-1")).toBe(
      "tenants/acme/image-runtime/request-1/control/image-asset-manifest-v1.json",
    );
    expect(imageCampaignReviewPackageKey("acme", "request-1")).toBe(
      "tenants/acme/image-runtime/request-1/review/image-campaign-review-package-v1.json",
    );
    expect(imageDerivativeObjectKey("acme", "request-1", "web.hero.v1")).toBe(
      "tenants/acme/image-runtime/request-1/derivatives/web.hero.v1.webp",
    );
    expect(IMAGE_BINDING_MAX_INPUT_BYTES).toBe(20 * 1024 * 1024);
  });
});
