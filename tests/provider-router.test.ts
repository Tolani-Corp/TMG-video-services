import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../src/embedding";
import type { ModelCompatibilityRegistry, ProviderRegistryEntry } from "../src/model-registry";
import { EmbeddingProviderRouter, ProviderRouterError } from "../src/provider-router";

function externalRegistry(status: ProviderRegistryEntry["status"] = "enabled"): ModelCompatibilityRegistry {
  return {
    schemaVersion: "1.0.0",
    defaultProviderId: "external-test",
    externalProviderEgressAllowed: true,
    compatibilityGroups: [
      {
        id: "external_512",
        dimensions: 512,
        metric: "cosine",
        vectorIndexBinding: "VIDEO_INDEX",
        state: "development",
      },
    ],
    providers: [
      {
        id: "external-test",
        status,
        egressClass: "external",
        acceptanceRequirement: "development_acceptance",
        profile: {
          id: "external_test_512_v1",
          provider: "external-test",
          model: "test-model",
          modelVersion: "1",
          dimensions: 512,
          modalities: ["fused"],
          compatibilityGroup: "external_512",
        },
      },
    ],
  };
}

function externalProvider(profileId = "external_test_512_v1"): EmbeddingProvider {
  return {
    profile: {
      id: profileId,
      provider: "external-test",
      model: "test-model",
      modelVersion: "1",
      dimensions: 512,
      modalities: ["fused"],
      compatibilityGroup: "external_512",
    },
    async embedSegment() {
      return Array.from({ length: 512 }, () => 0);
    },
  };
}

describe("EmbeddingProviderRouter", () => {
  it("resolves the no-egress fixture provider without acceptance evidence", () => {
    const resolution = new EmbeddingProviderRouter().resolve({
      selectedProviderId: "fixture",
      externalEgressEnabled: false,
      acceptanceState: "unverified",
    });

    expect(resolution.registryEntry.id).toBe("fixture");
    expect(resolution.provider.profile.id).toBe("fixture_video_512_v1");
    expect(resolution.registryEntry.egressClass).toBe("none");
  });

  it("rejects disabled providers", () => {
    const router = new EmbeddingProviderRouter(
      externalRegistry("disabled"),
      new Map([["external-test", () => externalProvider()]]),
    );

    expect(() =>
      router.resolve({
        selectedProviderId: "external-test",
        externalEgressEnabled: true,
        acceptanceState: "passed",
      }),
    ).toThrow(ProviderRouterError);
  });

  it("rejects external providers when egress is not explicitly enabled", () => {
    const router = new EmbeddingProviderRouter(
      externalRegistry(),
      new Map([["external-test", () => externalProvider()]]),
    );

    expect(() =>
      router.resolve({
        selectedProviderId: "external-test",
        externalEgressEnabled: false,
        acceptanceState: "passed",
      }),
    ).toThrow(/external egress/);
  });

  it("rejects external providers until development acceptance evidence passes", () => {
    const router = new EmbeddingProviderRouter(
      externalRegistry(),
      new Map([["external-test", () => externalProvider()]]),
    );

    expect(() =>
      router.resolve({
        selectedProviderId: "external-test",
        externalEgressEnabled: true,
        acceptanceState: "unverified",
      }),
    ).toThrow(/acceptance evidence/);
  });

  it("rejects an adapter whose runtime profile drifts from the registry", () => {
    const router = new EmbeddingProviderRouter(
      externalRegistry(),
      new Map([["external-test", () => externalProvider("wrong_profile")]]),
    );

    expect(() =>
      router.resolve({
        selectedProviderId: "external-test",
        externalEgressEnabled: true,
        acceptanceState: "passed",
      }),
    ).toThrow(/does not match registry profile/);
  });
});
