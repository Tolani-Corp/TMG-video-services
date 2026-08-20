import { z } from "zod";
import type {
  VectorSearchRequest,
  VideoMomentMatch,
  VideoSegmentRecord,
} from "./domain";
import { evaluateRetrievalPolicy, purposeFilterKey } from "./policy";

const metadataSchema = z.object({
  assetId: z.string(),
  segmentId: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  publicationState: z.enum(["internal", "review", "approved", "blocked"]),
  tenantId: z.string(),
  embeddingProfileId: z.string(),
  embeddingDimensions: z.number().int().positive(),
  rightsProfileId: z.string(),
  rightsEvidenceState: z.enum(["verified", "pending", "rejected", "expired", "revoked"]),
  sourceEvidenceRef: z.string(),
  allowedTerritories: z.array(z.string()).default([]),
  allowedTenantIds: z.array(z.string()).default([]),
  externalApi: z.boolean(),
  mcp: z.boolean(),
  advertising: z.boolean(),
  datasetExport: z.boolean(),
  licensing: z.boolean(),
  rightsExpiresAt: z.string().optional(),
});

export class VectorDimensionError extends Error {
  constructor(expected: number, actual: number) {
    super(`Expected a ${expected}-dimension query vector; received ${actual}.`);
    this.name = "VectorDimensionError";
  }
}

export function buildCoarseVectorFilter(
  request: VectorSearchRequest,
): Record<string, string | number | boolean> {
  const filter: Record<string, string | number | boolean> = {
    tenantId: request.tenantId,
    rightsVerified: true,
  };

  const grantKey = purposeFilterKey(request.purpose);
  if (grantKey) {
    filter.publicationState = "approved";
    filter[grantKey] = true;
  }

  return filter;
}

function decodeSegmentMetadata(metadata: unknown): VideoSegmentRecord | null {
  const parsed = metadataSchema.safeParse(metadata);
  if (!parsed.success) return null;

  const value = parsed.data;
  return {
    assetId: value.assetId,
    segmentId: value.segmentId,
    startMs: value.startMs,
    endMs: value.endMs,
    publicationState: value.publicationState,
    tenantId: value.tenantId,
    embeddingProfileId: value.embeddingProfileId,
    embeddingDimensions: value.embeddingDimensions,
    rights: {
      rightsProfileId: value.rightsProfileId,
      evidenceState: value.rightsEvidenceState,
      sourceEvidenceRef: value.sourceEvidenceRef,
      allowedTerritories: value.allowedTerritories,
      allowedTenantIds: value.allowedTenantIds,
      grants: {
        externalApi: value.externalApi,
        mcp: value.mcp,
        advertising: value.advertising,
        datasetExport: value.datasetExport,
        licensing: value.licensing,
      },
      ...(value.rightsExpiresAt ? { expiresAt: value.rightsExpiresAt } : {}),
    },
  };
}

export async function searchVideoMoments(
  env: Env,
  request: VectorSearchRequest,
): Promise<VideoMomentMatch[]> {
  const expectedDimensions = Number(env.TMG_EMBEDDING_DIMENSIONS);
  if (request.queryVector.length !== expectedDimensions) {
    throw new VectorDimensionError(expectedDimensions, request.queryVector.length);
  }

  const candidateTopK = Math.min(Math.max(request.topK * 3, request.topK), 50);
  const response = await env.VIDEO_INDEX.query(request.queryVector, {
    topK: candidateTopK,
    namespace: request.namespace,
    returnValues: false,
    returnMetadata: "all",
    filter: buildCoarseVectorFilter(request),
  });

  const matches: VideoMomentMatch[] = [];

  for (const match of response.matches) {
    const segment = decodeSegmentMetadata(match.metadata);
    if (!segment) continue;

    const decision = evaluateRetrievalPolicy(segment, {
      purpose: request.purpose,
      tenantId: request.tenantId,
      ...(request.territory ? { territory: request.territory } : {}),
    });

    if (!decision.allowed) continue;

    matches.push({
      vectorId: match.id,
      score: match.score,
      assetId: segment.assetId,
      segmentId: segment.segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      rightsProfileId: segment.rights.rightsProfileId,
      embeddingProfileId: segment.embeddingProfileId,
    });

    if (matches.length >= request.topK) break;
  }

  return matches;
}
