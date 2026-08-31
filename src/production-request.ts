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
  "campaign_plan",
  "branded_marketing_videos",
  "social_copy",
] as const;

export type ProductionDeliverable = (typeof PRODUCTION_DELIVERABLES)[number];

export const MARKETING_DELIVERABLES = [
  "campaign_plan",
  "branded_marketing_videos",
  "social_copy",
] as const satisfies readonly ProductionDeliverable[];

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
  "distribution_targets",
  "brand_assets",
  "reference_media",
  "delivery_preferences",
] as const;

export type ChecklistItemKind = (typeof CHECKLIST_ITEM_KINDS)[number];

export const DISTRIBUTION_PLATFORMS = [
  "youtube",
  "tiktok",
  "instagram",
  "facebook",
  "linkedin",
  "x",
  "website",
  "web_app",
  "mobile_app",
  "ott_streaming",
  "email_landing_page",
  "digital_signage",
  "internal",
  "general_master",
  "custom",
] as const;

export type DistributionPlatform = (typeof DISTRIBUTION_PLATFORMS)[number];

export const DISTRIBUTION_USAGES = [
  "organic",
  "paid_ad",
  "owned_media",
  "internal",
  "undecided",
] as const;

export type DistributionUsage = (typeof DISTRIBUTION_USAGES)[number];

export const distributionTargetSchema = z.object({
  platform: z.enum(DISTRIBUTION_PLATFORMS),
  surface: z.string().trim().min(1).max(64),
  usage: z.enum(DISTRIBUTION_USAGES),
  profileId: z.string().trim().min(1).max(128).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export type DistributionTarget = z.infer<typeof distributionTargetSchema>;

export const distributionTargetsReferenceSchema = z.object({
  targets: z
    .array(distributionTargetSchema)
    .min(1)
    .max(20)
    .transform((targets) => {
      const seen = new Set<string>();
      return targets.filter((target) => {
        const key = `${target.platform}:${target.surface}:${target.usage}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }),
});

export const SOURCE_CONTEXT_TYPES = [
  "website",
  "web_app",
  "mobile_app",
  "product_page",
  "docs_site",
] as const;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const sourceContextReferenceSchema = z.object({
  type: z.enum(SOURCE_CONTEXT_TYPES),
  url: z.string().trim().url().refine(isHttpsUrl, "source context URL must use HTTPS"),
  authorization: z.object({
    authorizedByRequester: z.literal(true),
    assetReuseAuthorized: z.boolean().default(false),
    authenticatedCrawlAuthorized: z.boolean().default(false),
    credentialRef: z.string().trim().min(1).max(256).optional(),
  }).superRefine((value, ctx) => {
    if (value.authenticatedCrawlAuthorized && !value.credentialRef) {
      ctx.addIssue({
        code: "custom",
        message: "credentialRef is required for authenticated crawl authorization",
        path: ["credentialRef"],
      });
    }
    if (!value.authenticatedCrawlAuthorized && value.credentialRef) {
      ctx.addIssue({
        code: "custom",
        message: "credentialRef is only allowed for an authenticated crawl",
        path: ["credentialRef"],
      });
    }
  }),
  crawlScope: z.object({
    includePaths: z.array(z.string().trim().min(1).max(240)).max(25).default([]),
    excludePaths: z.array(z.string().trim().min(1).max(240)).max(25).default([]),
    allowSubdomains: z.boolean().default(false),
    maxPages: z.number().int().min(1).max(250).default(50),
    maxDiscoveryDepth: z.number().int().min(0).max(5).default(2),
  }).default({
    includePaths: [],
    excludePaths: [],
    allowSubdomains: false,
    maxPages: 50,
    maxDiscoveryDepth: 2,
  }),
});

export type SourceContextReference = z.infer<typeof sourceContextReferenceSchema>;

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
  value: z.union([
    z.string().trim().min(1).max(4000),
    z.object({}).loose(),
    z.array(z.unknown()).max(100),
  ]),
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
  targets: DistributionTarget[];
  publicationAuthority: false;
}

export interface MarketingCampaignPlan {
  requested: true;
  contextSources: SourceContextReference[];
  crawlAuthorizationRequired: boolean;
  discoveredAssetReuseRequiresRightsEvidence: true;
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
  distributionTargets: DistributionTarget[];
  deliverables: ProductionPlanDeliverable[];
  marketingCampaign?: MarketingCampaignPlan;
  governance: {
    rightsEvidenceRequired: true;
    publicationAuthority: false;
    externalDistributionAuthority: false;
    crawlAuthorizationRequired: boolean;
    discoveredAssetReuseRequiresRightsEvidence: true;
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
  campaign_plan: "marketing_campaign_planning",
  branded_marketing_videos: "campaign_video_generation",
  social_copy: "social_copy_generation",
};

export function isMarketingCampaignRequest(deliverables: ProductionDeliverable[]): boolean {
  return deliverables.some((deliverable) =>
    (MARKETING_DELIVERABLES as readonly ProductionDeliverable[]).includes(deliverable),
  );
}

export function checklistTemplate(): ChecklistTemplateItem[] {
  return [
    {
      kind: "project_brief",
      label: "Project brief",
      description: "Upload a brief or enter the production or campaign instructions TMG should follow.",
      required: true,
      acceptsUploads: true,
      acceptsReference: true,
      allowsMultiple: false,
    },
    {
      kind: "source_media",
      label: "Source media or product context",
      description: "Upload source media, or provide an authorized website/app context reference for a marketing campaign.",
      required: true,
      acceptsUploads: true,
      acceptsReference: true,
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
      kind: "distribution_targets",
      label: "Distribution targets",
      description: "Choose where the outputs will be used, such as YouTube Shorts, TikTok, a website/app, paid advertising, or a general-purpose master.",
      required: true,
      acceptsUploads: false,
      acceptsReference: true,
      allowsMultiple: false,
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
      description: "Optional duration, naming, packaging, review, API-delivery, or handoff preferences.",
      required: false,
      acceptsUploads: true,
      acceptsReference: true,
      allowsMultiple: false,
    },
  ];
}

export function normalizeChecklistReferenceValue(kind: ChecklistItemKind, value: unknown): string {
  if (kind === "distribution_targets") {
    const parsed = distributionTargetsReferenceSchema.parse(value);
    return JSON.stringify(parsed);
  }
  if (kind === "source_media" && typeof value !== "string") {
    const parsed = sourceContextReferenceSchema.parse(value);
    return JSON.stringify(parsed);
  }
  if (typeof value !== "string") {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 4000) {
      throw new Error("structured checklist reference must serialize to 1-4000 characters");
    }
    return serialized;
  }
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 4000) {
    throw new Error("checklist reference must be 1-4000 characters");
  }
  return cleaned;
}

export function requiredChecklistSatisfied(snapshot: ProductionRequestSnapshot): boolean {
  return snapshot.checklist.every((item) => !item.required || item.status === "completed");
}

function readDistributionTargets(snapshot: ProductionRequestSnapshot): DistributionTarget[] {
  const item = snapshot.checklist.find((candidate) => candidate.kind === "distribution_targets");
  if (!item?.referenceValue) throw new Error("distribution targets are required");
  let raw: unknown;
  try {
    raw = JSON.parse(item.referenceValue);
  } catch {
    throw new Error("distribution targets must use the structured target selector");
  }
  return distributionTargetsReferenceSchema.parse(raw).targets;
}

function readSourceContextReferences(snapshot: ProductionRequestSnapshot): SourceContextReference[] {
  const item = snapshot.checklist.find((candidate) => candidate.kind === "source_media");
  if (!item?.referenceValue) return [];
  try {
    return [sourceContextReferenceSchema.parse(JSON.parse(item.referenceValue))];
  } catch {
    return [];
  }
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

  const distributionTargets = readDistributionTargets(snapshot);
  const marketingRequested = isMarketingCampaignRequest(snapshot.deliverables);
  const contextSources = readSourceContextReferences(snapshot);
  const crawlAuthorizationRequired = contextSources.length > 0;

  if (marketingRequested && contextSources.length === 0) {
    const sourceMedia = snapshot.checklist.find((candidate) => candidate.kind === "source_media");
    if (!sourceMedia || sourceMedia.artifacts.length === 0) {
      throw new Error("marketing campaigns require uploaded source media or an authorized website/app context source");
    }
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
    distributionTargets,
    deliverables: snapshot.deliverables.map((type) => ({
      type,
      skill: DELIVERABLE_SKILLS[type],
      targets: distributionTargets,
      publicationAuthority: false as const,
    })),
    ...(marketingRequested
      ? {
          marketingCampaign: {
            requested: true as const,
            contextSources,
            crawlAuthorizationRequired,
            discoveredAssetReuseRequiresRightsEvidence: true as const,
          },
        }
      : {}),
    governance: {
      rightsEvidenceRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
      crawlAuthorizationRequired,
      discoveredAssetReuseRequiresRightsEvidence: true,
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

export function marketingDiscoveryPlanObjectKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/production-requests/${requestId}/control/marketing-discovery-plan-v1.json`;
}
