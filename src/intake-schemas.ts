import { z } from "zod";

export const MAX_MEDIA_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_EVIDENCE_UPLOAD_BYTES = 20 * 1024 * 1024;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/i, "expected a 64-character SHA-256 hex digest");

export const createRequestSchema = z.object({
  requestName: z.string().trim().min(1).max(120),
  audience: z.string().trim().max(200).default(""),
  businessGoal: z.string().trim().min(1).max(2_000),
  priority: z.enum(["standard", "high", "critical_review"]).default("standard"),
  deliverables: z.array(z.string().trim().min(1).max(80)).min(1).max(16),
  outputFormat: z.string().trim().min(1).max(80),
  targetDuration: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(4_000).default(""),
});

export const registerAssetSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(160).refine(
    (value) => value.startsWith("video/") || value.startsWith("audio/") || value.startsWith("image/"),
    "media MIME type must be video, audio, or image",
  ),
  expectedBytes: z.number().int().positive().max(MAX_MEDIA_UPLOAD_BYTES),
  expectedSha256: sha256Hex,
});

export const registerRightsEvidenceSchema = z.object({
  evidenceKind: z.enum(["license", "contract", "release", "ownership_attestation", "synthetic_repo_owned"]),
  description: z.string().trim().min(1).max(2_000),
  filename: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(160),
  expectedBytes: z.number().int().positive().max(MAX_EVIDENCE_UPLOAD_BYTES),
  expectedSha256: sha256Hex,
  grantsInternalProcessing: z.boolean().default(false),
  grantsDerivativeUse: z.boolean().default(false),
  grantsExternalProviderEvaluation: z.boolean().default(false),
});

export const verifyRightsEvidenceSchema = z.object({
  decision: z.enum(["verify", "reject"]),
  rationale: z.string().trim().max(2_000).default(""),
});

export const createJobSchema = z.object({
  acknowledgement: z.literal("processing-authority-remains-blocked-at-g0"),
});

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type RegisterAssetInput = z.infer<typeof registerAssetSchema>;
export type RegisterRightsEvidenceInput = z.infer<typeof registerRightsEvidenceSchema>;
