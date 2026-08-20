export const RETRIEVAL_PURPOSES = [
  "internal_search",
  "external_api",
  "mcp",
  "advertising",
  "dataset_export",
  "licensing",
] as const;

export type RetrievalPurpose = (typeof RETRIEVAL_PURPOSES)[number];

export const PUBLICATION_STATES = [
  "internal",
  "review",
  "approved",
  "blocked",
] as const;

export type PublicationState = (typeof PUBLICATION_STATES)[number];

export type RightsEvidenceState =
  | "verified"
  | "pending"
  | "rejected"
  | "expired"
  | "revoked";

export interface PurposeGrants {
  externalApi: boolean;
  mcp: boolean;
  advertising: boolean;
  datasetExport: boolean;
  licensing: boolean;
}

export interface RightsEnvelope {
  rightsProfileId: string;
  evidenceState: RightsEvidenceState;
  sourceEvidenceRef: string;
  allowedTerritories: string[];
  allowedTenantIds: string[];
  grants: PurposeGrants;
  expiresAt?: string;
}

export interface VideoSegmentRecord {
  assetId: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  publicationState: PublicationState;
  tenantId: string;
  embeddingProfileId: string;
  embeddingDimensions: number;
  rights: RightsEnvelope;
}

export interface RetrievalContext {
  purpose: RetrievalPurpose;
  tenantId: string;
  territory?: string;
  nowIso?: string;
}

export interface RetrievalDecision {
  allowed: boolean;
  reasons: string[];
}

export interface VectorSearchRequest {
  queryVector: number[];
  topK: number;
  namespace: string;
  tenantId: string;
  territory?: string;
  purpose: RetrievalPurpose;
}

export interface VideoMomentMatch {
  vectorId: string;
  score: number;
  assetId: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  rightsProfileId: string;
  embeddingProfileId: string;
}
