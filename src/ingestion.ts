import { z } from "zod";
import type {
  PublicationState,
  PurposeGrants,
  RightsEnvelope,
  RightsEvidenceState,
  VideoSegmentRecord,
} from "./domain";
import type { EmbeddingProfile } from "./embedding";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "identifier contains unsupported characters");
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const isoLikeSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "expected an ISO-compatible timestamp",
});

export const SOURCE_CLASSES = ["fixture", "owned", "licensed", "partner"] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

const purposeGrantsSchema = z.object({
  externalApi: z.boolean(),
  mcp: z.boolean(),
  advertising: z.boolean(),
  datasetExport: z.boolean(),
  licensing: z.boolean(),
});

const rightsEvidenceStateSchema = z.enum([
  "verified",
  "pending",
  "rejected",
  "expired",
  "revoked",
]);

export const canonicalAssetManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  assetId: identifierSchema,
  tenantId: identifierSchema,
  ingestRunId: identifierSchema,
  source: z.object({
    sourceClass: z.enum(SOURCE_CLASSES),
    authorityRef: z.string().min(1).max(1024),
    sourceRef: z.string().min(1).max(2048).optional(),
  }),
  media: z.object({
    objectKey: z.string().min(1).max(1024).refine((value) => !value.startsWith("/")),
    sha256: sha256HexSchema,
    bytes: z.number().int().positive(),
    mimeType: z.string().min(1).max(255),
    durationMs: z.number().int().positive(),
  }),
  rightsProfileId: identifierSchema,
  publicationState: z.enum(["internal", "review", "approved", "blocked"]),
  receivedAt: isoLikeSchema,
});

export type CanonicalAssetManifest = z.infer<typeof canonicalAssetManifestSchema>;

export const rightsRegistryRecordSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    rightsProfileId: identifierSchema,
    assetId: identifierSchema,
    tenantId: identifierSchema,
    evidenceState: rightsEvidenceStateSchema,
    sourceEvidenceRef: z.string().min(1).max(2048),
    allowedTerritories: z.array(z.string().min(2).max(32)).max(256),
    allowedTenantIds: z.array(identifierSchema).max(256),
    grants: purposeGrantsSchema,
    revision: z.number().int().positive(),
    updatedAt: isoLikeSchema,
    expiresAt: isoLikeSchema.optional(),
    revokedAt: isoLikeSchema.optional(),
    revocationReason: z.string().min(1).max(2048).optional(),
  })
  .superRefine((record, ctx) => {
    if (record.evidenceState === "revoked" && !record.revokedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "revoked rights require revokedAt",
      });
    }
    if (record.revokedAt && !record.revocationReason) {
      ctx.addIssue({
        code: "custom",
        path: ["revocationReason"],
        message: "revoked rights require revocationReason",
      });
    }
  });

export type RightsRegistryRecord = z.infer<typeof rightsRegistryRecordSchema>;

export const segmentPlanEntrySchema = z.object({
  segmentId: identifierSchema,
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
});

export type SegmentPlanEntry = z.infer<typeof segmentPlanEntrySchema>;

export const governedIngestionRequestSchema = z.object({
  manifest: canonicalAssetManifestSchema,
  rights: rightsRegistryRecordSchema,
  segments: z.array(segmentPlanEntrySchema).min(1).max(512),
});

export type GovernedIngestionRequest = z.infer<typeof governedIngestionRequestSchema>;

export interface ArtifactKeys {
  assetRoot: string;
  manifest: string;
  rightsRevision: string;
  indexReceipt: (embeddingProfileId: string) => string;
  quarantineEvent: (eventId: string) => string;
  revocationEvent: (eventId: string) => string;
}

export class IngestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionValidationError";
  }
}

export function parseGovernedIngestionRequest(input: unknown): GovernedIngestionRequest {
  const parsed = governedIngestionRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new IngestionValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  assertManifestRightsBinding(parsed.data.manifest, parsed.data.rights);
  validateSegmentPlan(parsed.data.manifest, parsed.data.segments);
  return parsed.data;
}

export function assertManifestRightsBinding(
  manifest: CanonicalAssetManifest,
  rights: RightsRegistryRecord,
): void {
  if (manifest.assetId !== rights.assetId) {
    throw new IngestionValidationError("manifest assetId does not match rights assetId");
  }
  if (manifest.tenantId !== rights.tenantId) {
    throw new IngestionValidationError("manifest tenantId does not match rights tenantId");
  }
  if (manifest.rightsProfileId !== rights.rightsProfileId) {
    throw new IngestionValidationError("manifest rightsProfileId does not match rights record");
  }
}

export function validateSegmentPlan(
  manifest: CanonicalAssetManifest,
  segments: readonly SegmentPlanEntry[],
): void {
  let previousEnd = -1;
  const seen = new Set<string>();

  for (const segment of segments) {
    if (segment.endMs <= segment.startMs) {
      throw new IngestionValidationError(`segment ${segment.segmentId} endMs must be greater than startMs`);
    }
    if (segment.endMs > manifest.media.durationMs) {
      throw new IngestionValidationError(`segment ${segment.segmentId} exceeds media duration`);
    }
    if (segment.startMs < previousEnd) {
      throw new IngestionValidationError(`segment ${segment.segmentId} overlaps the previous segment`);
    }
    if (seen.has(segment.segmentId)) {
      throw new IngestionValidationError(`duplicate segment id ${segment.segmentId}`);
    }
    seen.add(segment.segmentId);
    previousEnd = segment.endMs;
  }
}

export function buildArtifactKeys(
  manifest: CanonicalAssetManifest,
  rights: RightsRegistryRecord,
): ArtifactKeys {
  const assetRoot = `tenants/${manifest.tenantId}/assets/${manifest.assetId}`;
  return {
    assetRoot,
    manifest: `${assetRoot}/control/manifest-v1.json`,
    rightsRevision: `${assetRoot}/control/rights/${rights.rightsProfileId}/r${rights.revision}.json`,
    indexReceipt: (embeddingProfileId) =>
      `${assetRoot}/control/index-receipts/${embeddingProfileId}.json`,
    quarantineEvent: (eventId) => `${assetRoot}/events/quarantine/${eventId}.json`,
    revocationEvent: (eventId) => `${assetRoot}/events/revocation/${eventId}.json`,
  };
}

export function effectiveRightsEvidenceState(
  rights: RightsRegistryRecord,
  nowIso: string,
): RightsEvidenceState {
  if (rights.revokedAt || rights.evidenceState === "revoked") return "revoked";
  if (rights.expiresAt && Date.parse(rights.expiresAt) <= Date.parse(nowIso)) return "expired";
  return rights.evidenceState as RightsEvidenceState;
}

export function toRightsEnvelope(rights: RightsRegistryRecord, nowIso: string): RightsEnvelope {
  return {
    rightsProfileId: rights.rightsProfileId,
    evidenceState: effectiveRightsEvidenceState(rights, nowIso),
    sourceEvidenceRef: rights.sourceEvidenceRef,
    allowedTerritories: rights.allowedTerritories,
    allowedTenantIds: rights.allowedTenantIds,
    grants: rights.grants as PurposeGrants,
    ...(rights.expiresAt ? { expiresAt: rights.expiresAt } : {}),
  };
}

export function buildVideoSegmentRecords(
  manifest: CanonicalAssetManifest,
  rights: RightsRegistryRecord,
  profile: EmbeddingProfile,
  segments: readonly SegmentPlanEntry[],
  nowIso: string,
): VideoSegmentRecord[] {
  const envelope = toRightsEnvelope(rights, nowIso);
  return segments.map((segment) => ({
    assetId: manifest.assetId,
    segmentId: segment.segmentId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    publicationState: manifest.publicationState as PublicationState,
    tenantId: manifest.tenantId,
    embeddingProfileId: profile.id,
    embeddingDimensions: profile.dimensions,
    rights: envelope,
  }));
}
