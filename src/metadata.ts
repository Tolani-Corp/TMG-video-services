import type { VideoSegmentRecord } from "./domain";

export type VectorSegmentMetadata = Record<
  string,
  string | number | boolean | string[]
>;

export function toVectorSegmentMetadata(
  segment: VideoSegmentRecord,
): VectorSegmentMetadata {
  const metadata: VectorSegmentMetadata = {
    assetId: segment.assetId,
    segmentId: segment.segmentId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    publicationState: segment.publicationState,
    tenantId: segment.tenantId,
    embeddingProfileId: segment.embeddingProfileId,
    embeddingDimensions: segment.embeddingDimensions,
    rightsProfileId: segment.rights.rightsProfileId,
    rightsEvidenceState: segment.rights.evidenceState,
    rightsVerified: segment.rights.evidenceState === "verified",
    sourceEvidenceRef: segment.rights.sourceEvidenceRef,
    allowedTerritories: segment.rights.allowedTerritories,
    allowedTenantIds: segment.rights.allowedTenantIds,
    externalApi: segment.rights.grants.externalApi,
    mcp: segment.rights.grants.mcp,
    advertising: segment.rights.grants.advertising,
    datasetExport: segment.rights.grants.datasetExport,
    licensing: segment.rights.grants.licensing,
  };

  if (segment.rights.expiresAt) {
    metadata.rightsExpiresAt = segment.rights.expiresAt;
  }

  return metadata;
}
