import type {
  EmbeddingProfile,
  EmbeddingProvider,
  SegmentEmbeddingInput,
} from "./embedding";

function byteToUnitFloat(byte: number): number {
  return (byte - 127.5) / 127.5;
}

async function digestBytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

export class DeterministicFixtureEmbeddingProvider implements EmbeddingProvider {
  readonly profile: EmbeddingProfile;

  constructor(dimensions = 512) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error("fixture embedding dimensions must be a positive integer");
    }

    this.profile = {
      id: `fixture_video_${dimensions}_v1`,
      provider: "fixture",
      model: "deterministic-sha256-fixture",
      modelVersion: "1",
      dimensions,
      modalities: ["visual", "audio", "transcription", "fused"],
      compatibilityGroup: `fixture_video_${dimensions}`,
    };
  }

  async embedSegment(input: SegmentEmbeddingInput): Promise<number[]> {
    const seed = [
      input.assetId,
      input.segmentId,
      input.startMs,
      input.endMs,
      input.mediaRef,
    ].join("\u0000");

    const values: number[] = [];
    let counter = 0;
    while (values.length < this.profile.dimensions) {
      const bytes = await digestBytes(`${seed}\u0000${counter}`);
      for (const byte of bytes) {
        if (values.length >= this.profile.dimensions) break;
        values.push(byteToUnitFloat(byte));
      }
      counter += 1;
    }

    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) {
      throw new Error("fixture embedding normalization failed");
    }

    return values.map((value) => value / norm);
  }
}
