import { z } from "zod";

export const PRODUCTION_DELIVERABLES = [
  "clips",
  "thumbnails",
  "captions",
  "transcript",
  "highlight_reel",
  "trailer",
  "chapters",
  "metadata",
] as const;

export type ProductionDeliverable = (typeof PRODUCTION_DELIVERABLES)[number];

export const PRODUCTION_REQUEST_STATUSES = [
  "draft",
  "ready",
  "submitted",
  "processing",
  "completed",
  "failed",
] as const;

export type ProductionRequestStatus = (typeof PRODUCTION_REQUEST_STATUSES)[number];

export const CHECKLIST_ITEM_STATUSES = [
  "pending",
  "uploading",
  "completed",
  "failed",
] as const;

export type ChecklistItemStatus = (typeof CHECKLIST_ITEM_STATUSES)[number];

export const CHECKLIST_ITEM_KINDS = [
  "project_brief",
  "source_media",
  "rights_evidence",
  "brand_assets",
  "reference_media",
  "delivery_preferences",
] as const;

export type ChecklistItemKind = (typeof CHECKLIST_ITEM_KINDS)[number];

export const productionRequestCreateSchema = z.object({
  tenantId: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "tenantId must be a stable lowercase slug"),
  title: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(4000).optional(),
  deliverables: z
    .array(z.enum(PRODUCTION_DELIVERABLES))
    .min(1)
    .max(PRODUCTION_DELIVERABLES.length)
    .transform((values) => [...new Set(values)]),
});

export const uploadStartSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(3).max(160),
  declaredBytes: z.number().int().positive().max(5 * 1024 * 1024 * 1024 * 1024).optional(),
});

export const uploadCompleteSchema = z.object({
  uploadId: z.string().trim().min(1).max(256),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().trim().min(1).max(256),
      }),
    )
    .min(1)
    .max(10_000),
});

export const checklistReferenceSchema = z.object({
  value: z.string().trim().min(1).max(4000),
});

export interface ProductionChecklistArtifact {
  artifactId: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  etag?: string;
  createdAt: string;
}

export interface ProductionChecklistItem {
  itemId: string;
  kind: ChecklistItemKind;
  label: string;
  description: string;
  required: boolean;
  acceptsUploads: boolean;
  acceptsReference: boolean;
  allowsMultiple: boolean;
  status: ChecklistItemStatus;
  referenceValue?: string;
  artifacts: ProductionChecklistArtifact[];
  updatedAt: string;
}

export interface ProductionRequestSnapshot {
  schemaVersion: "tmg.production-request.v1";
  requestId: string;
  tenantId: string;
  title: string;
  notes?: string;
  status: ProductionRequestStatus;
  deliverables: ProductionDeliverable[];
  checklist: ProductionChecklistItem[];
  workflowInstanceId?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
}

export interface ChecklistTemplateItem {
  kind: ChecklistItemKind;
  label: string;
  description: string;
  required: boolean;
  acceptsUploads: boolean;
  acceptsReference: boolean;
  allowsMultiple: boolean;
}

export interface ProductionPlanDeliverable {
  type: ProductionDeliverable;
  skill: string;
  publicationAuthority: false;
}

export interface ProductionPlan {
  schemaVersion: "tmg.production-plan.v1";
  requestId: string;
  tenantId: string;
  title: string;
  sourceInputs: Array<{
    itemId: string;
    kind: ChecklistItemKind;
    referenceValue?: string;
    artifacts: ProductionChecklistArtifact[];
  }>;
  deliverables: ProductionPlanDeliverable[];
  governance: {
    rightsEvidenceRequired: true;
    publicationAuthority: false;
    externalDistributionAuthority: false;
  };
  compiledAt: string;
}

const DELIVERABLE_SKILLS: Record<ProductionDeliverable, string> = {
  clips: "smart_clip_extraction",
  thumbnails: "thumbnail_generation",
  captions: "caption_generation",
  transcript: "transcription",
  highlight_reel: "highlight_reel_assembly",
  trailer: "trailer_assembly",
  chapters: "chapter_generation",
  metadata: "media_metadata_enrichment",
};

export function checklistTemplate(): ChecklistTemplateItem[] {
  return [
    {
      kind: "project_brief",
      label: "Project brief",
      description: "Upload a brief or enter the production instructions TMG should follow.",
      required: true,
      acceptsUploads: true,
      acceptsReference: true,
      allowsMultiple: false,
    },
    {
      kind: "source_media",
      label: "Source media",
      description: "Upload the video, audio, images, or source assets TMG should process.",
      required: true,
      acceptsUploads: true,
      acceptsReference: false,
      allowsMultiple: true,
    },
    {
      kind: "rights_evidence",
      label: "Rights and usage evidence",
      description: "Provide governed evidence or an existing rights reference before production begins.",
      required: true,
      acceptsUploads: true,
      acceptsReference: true,
      allowsMultiple: true,
    },
    {
      kind: "brand_assets",
      label: "Brand assets",
      description: "Optional logos, fonts-by-reference, style guides, overlays, or brand examples.",
      required: false,
      acceptsUploads: true,
      acceptsReference: true,
      allowsMultiple: true,
    },
    {
      kind: "reference_media",
      label: "Reference media",
      description: "Optional visual or editorial references that communicate the desired style.",
      required: false,
      acceptsUploads: true,
      acceptsReference: true,
      allowsMultiple: true,
    },
    {
      kind: "delivery_preferences",
      label: "Delivery preferences",
      description: "Optional platform, duration, aspect-ratio, naming, packaging, or review preferences.",
      required: false,
      acceptsUploads: true,
      acceptsReference: true,
      allowsMultiple: false,
    },
  ];
}

export function requiredChecklistSatisfied(snapshot: ProductionRequestSnapshot): boolean {
  return snapshot.checklist.every((item) => !item.required || item.status === "completed");
}

export function compileProductionPlan(
  snapshot: ProductionRequestSnapshot,
  compiledAt = new Date().toISOString(),
): ProductionPlan {
  if (!requiredChecklistSatisfied(snapshot)) {
    throw new Error("required checklist items are incomplete");
  }
  if (!["ready", "submitted"].includes(snapshot.status)) {
    throw new Error(`production request is not submit-ready: ${snapshot.status}`);
  }

  return {
    schemaVersion: "tmg.production-plan.v1",
    requestId: snapshot.requestId,
    tenantId: snapshot.tenantId,
    title: snapshot.title,
    sourceInputs: snapshot.checklist
      .filter((item) => item.status === "completed")
      .map((item) => ({
        itemId: item.itemId,
        kind: item.kind,
        ...(item.referenceValue ? { referenceValue: item.referenceValue } : {}),
        artifacts: item.artifacts,
      })),
    deliverables: snapshot.deliverables.map((type) => ({
      type,
      skill: DELIVERABLE_SKILLS[type],
      publicationAuthority: false as const,
    })),
    governance: {
      rightsEvidenceRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
    },
    compiledAt,
  };
}

export function safeUploadFileName(fileName: string): string {
  const normalized = fileName.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_");
  const trimmed = normalized.replace(/^[_\.]+/, "").slice(0, 180);
  return trimmed || "upload.bin";
}

export function productionInputObjectKey(input: {
  tenantId: string;
  requestId: string;
  itemId: string;
  artifactId: string;
  fileName: string;
}): string {
  return [
    "tenants",
    input.tenantId,
    "production-requests",
    input.requestId,
    "inputs",
    input.itemId,
    input.artifactId,
    safeUploadFileName(input.fileName),
  ].join("/");
}

export function productionPlanObjectKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/production-requests/${requestId}/control/production-plan-v1.json`;
}

export function productionPackageObjectKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/production-requests/${requestId}/outputs/production-package-v1.json`;
}
