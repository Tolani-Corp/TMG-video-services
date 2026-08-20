import type { EmbeddingProfile } from "./embedding";
import { validateEmbedding } from "./embedding";
import type { VideoSegmentRecord } from "./domain";
import { toVectorSegmentMetadata, type VectorSegmentMetadata } from "./metadata";

export interface PreparedVectorUpsert {
  id: string;
  namespace: string;
  values: number[];
  metadata: VectorSegmentMetadata;
}

export class IndexPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexPreparationError";
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareVectorUpsert(
  segment: VideoSegmentRecord,
  profile: EmbeddingProfile,
  vector: number[],
): Promise<PreparedVectorUpsert> {
  if (segment.rights.evidenceState !== "verified") {
    throw new IndexPreparationError("Only segments with verified rights evidence may enter the searchable index.");
  }

  if (!segment.rights.sourceEvidenceRef) {
    throw new IndexPreparationError("A canonical source-evidence reference is required before indexing.");
  }

  if (segment.embeddingProfileId !== profile.id) {
    throw new IndexPreparationError(
      `Segment embedding profile ${segment.embeddingProfileId} does not match provider profile ${profile.id}.`,
    );
  }

  if (segment.embeddingDimensions !== profile.dimensions) {
    throw new IndexPreparationError(
      `Segment declares ${segment.embeddingDimensions} dimensions but profile ${profile.id} declares ${profile.dimensions}.`,
    );
  }

  validateEmbedding(profile, vector);

  const id = await sha256Hex(
    [segment.tenantId, segment.assetId, segment.segmentId, profile.id].join(":"),
  );

  return {
    id,
    namespace: segment.tenantId,
    values: vector,
    metadata: toVectorSegmentMetadata(segment),
  };
}
