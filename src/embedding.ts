export interface EmbeddingProfile {
  id: string;
  provider: string;
  model: string;
  modelVersion: string;
  dimensions: number;
  modalities: readonly string[];
  compatibilityGroup: string;
}

export interface SegmentEmbeddingInput {
  assetId: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  mediaRef: string;
}

export interface EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  embedSegment(input: SegmentEmbeddingInput): Promise<number[]>;
}

export class EmbeddingProfileMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProfileMismatchError";
  }
}

export function validateEmbedding(
  profile: EmbeddingProfile,
  vector: readonly number[],
): void {
  if (vector.length !== profile.dimensions) {
    throw new EmbeddingProfileMismatchError(
      `Embedding profile ${profile.id} requires ${profile.dimensions} dimensions; received ${vector.length}.`,
    );
  }

  if (vector.some((value) => !Number.isFinite(value))) {
    throw new EmbeddingProfileMismatchError(
      `Embedding profile ${profile.id} produced a non-finite value.`,
    );
  }
}
