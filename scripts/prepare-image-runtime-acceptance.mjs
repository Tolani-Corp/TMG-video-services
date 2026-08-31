import crypto from "node:crypto";
import fs from "node:fs";

const requestId = process.env.TMG_IMAGE_ACCEPT_REQUEST_ID;
if (!requestId) throw new Error("missing TMG_IMAGE_ACCEPT_REQUEST_ID");

const source = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmklEQVR4nO3QQRHAIADAMMABPxzgX+GQkccaBb3Ofe43fmzpAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAdlKgHP5AEUOQAAAABJRU5ErkJggg==", "base64");
const logo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANUlEQVR4nO3OQQEAMAjEsGNS5t/NfGBhyOCTGmjqvv5Z7GzOAQAAAAAAAAAAAAAAAAAAkmQAiqIDIhLbFzwAAAAASUVORK5CYII=", "base64");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const root = `tenants/image_acceptance/image-runtime/${requestId}/inputs`;

fs.writeFileSync("image-acceptance-source.png", source);
fs.writeFileSync("image-acceptance-logo.png", logo);
fs.writeFileSync("image-acceptance-request.json", JSON.stringify({
  schemaVersion: "tmg.image-processing-request.v1",
  requestId,
  tenantId: "image_acceptance",
  source: {
    artifactId: "synthetic-source-v1",
    objectKey: `${root}/source.png`,
    expectedSha256: sha(source),
    mimeType: "image/png",
    authorityRef: "fixture://tmg/image-runtime/source-v1",
    reuseAuthorized: true,
  },
  logo: {
    artifactId: "synthetic-logo-v1",
    objectKey: `${root}/logo.png`,
    expectedSha256: sha(logo),
    mimeType: "image/png",
    authorityRef: "fixture://tmg/image-runtime/logo-v1",
    overlayAuthorized: true,
  },
  rights: {
    evidenceRef: "rights://tmg/image-runtime-acceptance/synthetic-v1",
    evidenceState: "verified",
    purpose: "marketing_creative",
  },
  targets: ["tiktok.cover.v1", "youtube.thumbnail.v1", "instagram.square.v1", "web.hero.v1"],
  governance: {
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  },
}, null, 2) + "\n");
