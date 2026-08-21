import type { EmbeddingProvider } from "./embedding";
import { DeterministicFixtureEmbeddingProvider } from "./fixture-provider";
import {
  DEFAULT_MODEL_COMPATIBILITY_REGISTRY,
  assertProviderRegistryConsistency,
  getProviderRegistryEntry,
  type ModelCompatibilityRegistry,
  type ProviderRegistryEntry,
} from "./model-registry";

export interface ProviderRuntimePolicy {
  selectedProviderId: string;
  externalEgressEnabled: boolean;
  acceptanceState: "unverified" | "passed";
}

export interface ProviderResolution {
  provider: EmbeddingProvider;
  registryEntry: ProviderRegistryEntry;
}

export type ProviderFactory = (entry: ProviderRegistryEntry) => EmbeddingProvider;

export class ProviderRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRouterError";
  }
}

export class EmbeddingProviderRouter {
  constructor(
    private readonly registry: ModelCompatibilityRegistry = DEFAULT_MODEL_COMPATIBILITY_REGISTRY,
    private readonly factories: ReadonlyMap<string, ProviderFactory> = new Map([
      ["fixture", (entry) => new DeterministicFixtureEmbeddingProvider(entry.profile.dimensions)],
    ]),
  ) {}

  resolve(policy: ProviderRuntimePolicy): ProviderResolution {
    const entry = getProviderRegistryEntry(this.registry, policy.selectedProviderId);
    assertProviderRegistryConsistency(this.registry, entry);

    if (entry.status === "disabled") {
      throw new ProviderRouterError(`Provider ${entry.id} is disabled by the model registry.`);
    }
    if (entry.status === "shadow") {
      throw new ProviderRouterError(`Provider ${entry.id} is shadow-only and cannot serve authoritative embeddings.`);
    }
    if (entry.egressClass === "external") {
      if (!this.registry.externalProviderEgressAllowed || !policy.externalEgressEnabled) {
        throw new ProviderRouterError(`Provider ${entry.id} requires external egress, which is disabled.`);
      }
    }
    if (
      entry.acceptanceRequirement === "development_acceptance" &&
      policy.acceptanceState !== "passed"
    ) {
      throw new ProviderRouterError(`Provider ${entry.id} requires passed development acceptance evidence.`);
    }

    const factory = this.factories.get(entry.id);
    if (!factory) throw new ProviderRouterError(`Provider ${entry.id} has no runtime adapter factory.`);

    const provider = factory(entry);
    if (provider.profile.id !== entry.profile.id) {
      throw new ProviderRouterError(
        `Provider ${entry.id} adapter profile ${provider.profile.id} does not match registry profile ${entry.profile.id}.`,
      );
    }
    if (
      provider.profile.dimensions !== entry.profile.dimensions ||
      provider.profile.compatibilityGroup !== entry.profile.compatibilityGroup
    ) {
      throw new ProviderRouterError(`Provider ${entry.id} adapter is incompatible with its registry contract.`);
    }

    return { provider, registryEntry: entry };
  }
}

export function providerPolicyFromEnv(env: Env): ProviderRuntimePolicy {
  const externalEgressEnabled = String(env.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED) === "true";
  const acceptanceState =
    String(env.TMG_PROVIDER_ACCEPTANCE_STATE) === "passed" ? "passed" : "unverified";

  return {
    selectedProviderId: String(env.TMG_EMBEDDING_PROVIDER_ID),
    externalEgressEnabled,
    acceptanceState,
  };
}
