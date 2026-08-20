import type { CanonicalAssetManifest } from "./ingestion";

export interface MediaEvidenceDecision {
  verified: boolean;
  reasons: string[];
  objectVersion?: string;
  etag?: string;
}

function bufferToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Body(body: ArrayBuffer): Promise<string> {
  return bufferToHex(await crypto.subtle.digest("SHA-256", body));
}

export async function verifyPhysicalMediaEvidence(
  bucket: R2Bucket,
  manifest: CanonicalAssetManifest,
  fixtureFallbackMaxBytes = 1_000_000,
): Promise<MediaEvidenceDecision> {
  const object = await bucket.head(manifest.media.objectKey);
  if (!object) {
    return { verified: false, reasons: ["media_object_missing"] };
  }

  const reasons: string[] = [];
  if (object.size !== manifest.media.bytes) {
    reasons.push("media_size_mismatch");
  }

  const storedSha256 = object.checksums.sha256
    ? bufferToHex(object.checksums.sha256)
    : undefined;

  if (storedSha256) {
    if (storedSha256 !== manifest.media.sha256) {
      reasons.push("media_sha256_mismatch");
    }
  } else if (
    manifest.source.sourceClass === "fixture" &&
    object.size <= fixtureFallbackMaxBytes
  ) {
    const bodyObject = await bucket.get(manifest.media.objectKey);
    if (!bodyObject || !bodyObject.body) {
      reasons.push("fixture_media_body_unavailable");
    } else {
      const calculated = await sha256Body(await bodyObject.arrayBuffer());
      if (calculated !== manifest.media.sha256) {
        reasons.push("fixture_media_sha256_mismatch");
      }
    }
  } else {
    reasons.push("media_sha256_checksum_missing");
  }

  return {
    verified: reasons.length === 0,
    reasons,
    objectVersion: object.version,
    etag: object.etag,
  };
}
