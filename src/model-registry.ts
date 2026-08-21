import type { EmbeddingProfile } from "./embedding";

export type ProviderRegistryStatus = "enabled" | "shadow" | "disabled";
export type ProviderEgressClass = "none" | "external";
export type ProviderAcceptanceRequirement = "none" | "development_acceptance";

export interface CompatibilityGroupDefinition {
  id: string;
  dimensions: number;
  metric: "cosine" | "euclidean" | "dot-product";
  vectorIndexBinding: string;
  state: "development" | "staging" | "production";
}

export interface ProviderRegistryEntry {
  id: string;
  status: ProviderRegistryStatus;
  egressClass: ProviderEgressClass;
  acceptanceRequirement: ProviderAcceptanceRequirement;
  profile: EmbeddingProfile;
}

export interface ModelCompatibilityRegistry {
  schemaVersion: "1.0.0";
  defaultProviderId: string;
  externalProviderEgressAllowed: boolean;
  compatibilityGroups: readonly CompatibilityGroupDefinition[];
  providers: readonly ProviderRegistryEntry[];
}

export const DEFAULT_MODEL_COMPATIBILITY_REGISTRY: ModelCompatibilityRegistry = {
  schemaVersion: "1.0.0",
  defaultProviderId: "fixture",
  externalProviderEgressAllowed: false,
  compatibilityGroups: [
    {
      id: "fixture_video_512",
      dimensions: 512,
      metric: "cosine",
      vectorIndexBinding: "VIDEO_INDEX",
      state: "development",
    },
    {
      id: "marengo3_fused_512_v1",
      dimensions: 512,
      metric: "cosine",
      vectorIndexBinding: "MARENGO_VIDEO_INDEX",
      state: "development",
    },
  ],
  providers: [
    {
      id: "fixture",
      status: "enabled",
      egressClass: "none",
      acceptanceRequirement: "none",
      profile: {
        id: "fixture_video_512_v1",
        provider: "fixture",
        model: "deterministic-sha256-fixture",
        modelVersion: "1",
        dimensions: 512,
        modalities: ["visual", "audio", "transcription", "fused"],
        compatibilityGroup: "fixture_video_512",
      },
    },
    {
      id: "twelvelabs-marengo3",
      status: "shadow",
      egressClass: "external",
      acceptanceRequirement: "development_acceptance",
      profile: {
        id: "twelvelabs_marengo3_fused_512_v1",
        provider: "twelvelabs",
        model: "marengo3.0",
        modelVersion: "3.0",
        dimensions: 512,
        modalities: ["visual", "audio", "transcription", "fused"],
        compatibilityGroup: "marengo3_fused_512_v1",
      },
    },
  ],
};

export class ModelRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRegistryError";
  }
}

export function getProviderRegistryEntry(
  registry: ModelCompatibilityRegistry,
  providerId: string,
): ProviderRegistryEntry {
  const entry = registry.providers.find((candidate) => candidate.id === providerId);
  if (!entry) throw new ModelRegistryError(`Provider ${providerId} is not registered.`);
  return entry;
}

export function getCompatibilityGroup(
  registry: ModelCompatibilityRegistry,
  groupId: string,
): CompatibilityGroupDefinition {
  const group = registry.compatibilityGroups.find((candidate) => candidate.id === groupId);
  if (!group) throw new ModelRegistryError(`Compatibility group ${groupId} is not registered.`);
  return group;
}

export function assertProviderRegistryConsistency(
  registry: ModelCompatibilityRegistry,
  entry: ProviderRegistryEntry,
): CompatibilityGroupDefinition {
  const group = getCompatibilityGroup(registry, entry.profile.compatibilityGroup);
  if (entry.profile.dimensions !== group.dimensions) {
    throw new ModelRegistryError(
      `Provider ${entry.id} declares ${entry.profile.dimensions} dimensions but compatibility group ${group.id} requires ${group.dimensions}.`,
    );
  }
  return group;
}
