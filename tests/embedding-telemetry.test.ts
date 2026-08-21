import { describe, expect, it } from "vitest";
import { buildEmbeddingUsageEvent } from "../src/embedding-telemetry";
import { DEFAULT_MODEL_COMPATIBILITY_REGISTRY } from "../src/model-registry";

describe("buildEmbeddingUsageEvent", () => {
  it("records measured provider usage without inventing cost", () => {
    const entry = DEFAULT_MODEL_COMPATIBILITY_REGISTRY.providers[0];
    if (!entry) throw new Error("fixture provider missing");

    const event = buildEmbeddingUsageEvent({
      registryEntry: entry,
      tenantId: "tmg_fixture",
      assetId: "harmless_fixture_001",
      segmentCount: 1,
      mediaDurationMs: 1000,
      inputBytes: 1441,
      vectorCount: 1,
      createdAt: "2026-08-20T20:00:00.000Z",
    });

    expect(event.providerId).toBe("fixture");
    expect(event.embeddingProfileId).toBe("fixture_video_512_v1");
    expect(event.compatibilityGroup).toBe("fixture_video_512");
    expect(event.egressClass).toBe("none");
    expect(event.vectorCount).toBe(1);
    expect(event.dimensions).toBe(512);
    expect(event).not.toHaveProperty("cost");
    expect(event).not.toHaveProperty("estimatedCost");
  });
});
