import { describe, expect, it } from "vitest";
import { DeterministicFixtureEmbeddingProvider } from "../src/fixture-provider";

describe("DeterministicFixtureEmbeddingProvider", () => {
  it("generates deterministic normalized vectors at the configured dimensions", async () => {
    const provider = new DeterministicFixtureEmbeddingProvider(8);
    const input = {
      assetId: "asset_1",
      segmentId: "segment_1",
      startMs: 0,
      endMs: 1000,
      mediaRef: "r2://fixture.mp4",
    };

    const first = await provider.embedSegment(input);
    const second = await provider.embedSegment(input);

    expect(first).toEqual(second);
    expect(first).toHaveLength(8);
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("changes the vector when the temporal segment changes", async () => {
    const provider = new DeterministicFixtureEmbeddingProvider(8);
    const first = await provider.embedSegment({
      assetId: "asset_1",
      segmentId: "segment_1",
      startMs: 0,
      endMs: 1000,
      mediaRef: "r2://fixture.mp4",
    });
    const second = await provider.embedSegment({
      assetId: "asset_1",
      segmentId: "segment_2",
      startMs: 1000,
      endMs: 2000,
      mediaRef: "r2://fixture.mp4",
    });

    expect(first).not.toEqual(second);
  });
});
