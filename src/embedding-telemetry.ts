import type { ProviderRegistryEntry } from "./model-registry";

export interface EmbeddingUsageEvent {
  schemaVersion: "1.0.0";
  eventType: "embedding_usage";
  providerId: string;
  embeddingProfileId: string;
  compatibilityGroup: string;
  egressClass: "none" | "external";
  tenantId: string;
  assetId: string;
  segmentCount: number;
  mediaDurationMs: number;
  inputBytes: number;
  vectorCount: number;
  dimensions: number;
  createdAt: string;
}

export function buildEmbeddingUsageEvent(input: {
  registryEntry: ProviderRegistryEntry;
  tenantId: string;
  assetId: string;
  segmentCount: number;
  mediaDurationMs: number;
  inputBytes: number;
  vectorCount: number;
  createdAt: string;
}): EmbeddingUsageEvent {
  return {
    schemaVersion: "1.0.0",
    eventType: "embedding_usage",
    providerId: input.registryEntry.id,
    embeddingProfileId: input.registryEntry.profile.id,
    compatibilityGroup: input.registryEntry.profile.compatibilityGroup,
    egressClass: input.registryEntry.egressClass,
    tenantId: input.tenantId,
    assetId: input.assetId,
    segmentCount: input.segmentCount,
    mediaDurationMs: input.mediaDurationMs,
    inputBytes: input.inputBytes,
    vectorCount: input.vectorCount,
    dimensions: input.registryEntry.profile.dimensions,
    createdAt: input.createdAt,
  };
}
