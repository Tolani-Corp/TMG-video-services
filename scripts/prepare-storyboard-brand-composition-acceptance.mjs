import crypto from "node:crypto";
import fs from "node:fs";

const requestId = process.env.TMG_STORYBOARD_V11_REQUEST_ID;
if (!requestId) throw new Error("missing TMG_STORYBOARD_V11_REQUEST_ID");

const tenantId = "storyboard_acceptance";
const assetRequestId = `${requestId}-brand-assets`;
const source = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmklEQVR4nO3QQRHAIADAMMABPxzgX+GQkccaBb3Ofe43fmzpAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAdlKgHP5AEUOQAAAABJRU5ErkJggg==", "base64");
const logo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANUlEQVR4nO3OQQEAMAjEsGNS5t/NfGBhyOCTGmjqvv5Z7GzOAQAAAAAAAAAAAAAAAAAAkmQAiqIDIhLbFzwAAAAASUVORK5CYII=", "base64");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const root = `tenants/${tenantId}/image-runtime/${assetRequestId}`;
const sourceKey = `${root}/inputs/source.png`;
const logoKey = `${root}/inputs/logo.png`;
const manifestKey = `${root}/control/image-asset-manifest-v1.json`;

fs.writeFileSync("storyboard-v11-source.png", source);
fs.writeFileSync("storyboard-v11-logo.png", logo);
fs.writeFileSync("storyboard-v11-image-manifest.json", JSON.stringify({
  schemaVersion: "tmg.image-asset-manifest.v1",
  requestId: assetRequestId,
  tenantId,
  source: {
    artifactId: "storyboard-v11-synthetic-source",
    objectKey: sourceKey,
    sha256: sha(source),
    bytes: source.length,
    mimeType: "image/png",
    authorityRef: "fixture://storyboard-v11/source",
    inspection: { format: "image/png", width: 64, height: 64, fileSize: source.length },
  },
  approvedLogo: {
    artifactId: "storyboard-v11-approved-logo",
    objectKey: logoKey,
    sha256: sha(logo),
    bytes: logo.length,
    mimeType: "image/png",
    authorityRef: "fixture://storyboard-v11/logo",
    inspection: { format: "image/png", width: 32, height: 32, fileSize: logo.length },
  },
  rights: {
    evidenceRef: "rights://storyboard-v11/synthetic-brand-package",
    evidenceState: "verified",
    purpose: "marketing_creative",
    sourceReuseAuthorized: true,
    logoOverlayAuthorized: true,
  },
  derivatives: [],
  provenance: {
    processor: "cloudflare_images_binding",
    sourceStorage: "cloudflare_r2",
    transformationVersion: "tmg.image-runtime.v1",
    processedAt: new Date().toISOString(),
  },
  governance: {
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  },
}, null, 2) + "\n");

fs.writeFileSync("storyboard-v11-fixture.json", JSON.stringify({
  tenantId,
  requestId,
  assetRequestId,
  sourceKey,
  logoKey,
  manifestKey,
  sourceSha256: sha(source),
  logoSha256: sha(logo),
}, null, 2) + "\n");
