import type {
  ProcessorAuthorityEnvelope,
  ProcessorId,
  WorkRequestFile,
  WorkRequestManifest,
} from "./work-review-core";

export const RIGHTS_PERMITTED_USES = [
  "internal_analysis",
  "frame_extraction",
  "transcode",
  "derivative_generation",
  "publication",
  "external_provider",
] as const;
export type RightsPermittedUse = (typeof RIGHTS_PERMITTED_USES)[number];

export const DERIVATIVE_RECIPES = {
  "poster-jpeg-v1": {
    label: "Poster JPEG",
    actions: ["decode_video", "extract_frame", "generate_derivative"],
    requiredUses: ["frame_extraction", "derivative_generation"],
  },
  "frame-set-3-v1": {
    label: "Three-frame review set",
    actions: ["decode_video", "extract_frames", "generate_derivative"],
    requiredUses: ["frame_extraction", "derivative_generation"],
  },
  "web-mp4-720p-v1": {
    label: "Web MP4 720p",
    actions: ["decode_video", "run_ffmpeg", "transcode", "generate_derivative"],
    requiredUses: ["transcode", "derivative_generation"],
  },
  "preview-pack-v1": {
    label: "Preview pack",
    actions: ["decode_video", "run_ffmpeg", "extract_frames", "transcode", "generate_derivative"],
    requiredUses: ["frame_extraction", "transcode", "derivative_generation"],
  },
} as const;
export type DerivativeRecipeId = keyof typeof DERIVATIVE_RECIPES;

export type TechnicalInspectionReceipt = {
  schema: "tmg.technical-inspection-receipt.v1";
  receiptId: string;
  processorId: "technical-inspection";
  requestId: string;
  reviewId: string;
  chainInstanceId: string;
  fileId: string;
  sourceSha256: string;
  sourceSize: number;
  executedAt: string;
  probeSucceeded: boolean;
  decodeSucceeded: boolean;
  decodeExitCode: number;
  format: Record<string, unknown>;
  streams: Array<Record<string, unknown>>;
  corruptionSignals: string[];
  toolchain: Record<string, unknown>;
  receiptSha256: string;
};

export type RightsSufficiencyVerdict = {
  schema: "tmg.rights-sufficiency-verdict.v1";
  verdictId: string;
  requestId: string;
  reviewId: string;
  chainInstanceId: string;
  state: "sufficient" | "insufficient" | "needs_more_evidence";
  permittedUses: RightsPermittedUse[];
  permittedTerritories: string[];
  technicalReceiptSha256: string;
  evidenceBindingsSha256: string;
  decidedBy: string;
  decidedAt: string;
  expiresAt: string | null;
  note: string;
  receiptSha256: string;
};

export type DerivativeAuthorityEnvelope = {
  schema: "tmg.derivative-authority.v1";
  authorityId: string;
  requestId: string;
  reviewId: string;
  chainInstanceId: string;
  state: "authorized" | "consumed" | "revoked";
  recipeId: DerivativeRecipeId;
  allowedActions: string[];
  sourceFileId: string;
  sourceSha256: string;
  technicalReceiptSha256: string;
  rightsVerdictSha256: string;
  outputPrefix: string;
  publicationAuthorized: false;
  externalProviderEgressAuthorized: false;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  consumedAt?: string;
  note: string;
};

export type DerivativeOutput = {
  key: string;
  size: number;
  sha256: string;
  contentType: string;
};

export type DerivativeReceipt = {
  schema: "tmg.derivative-receipt.v1";
  receiptId: string;
  requestId: string;
  reviewId: string;
  chainInstanceId: string;
  recipeId: DerivativeRecipeId;
  authorityId: string;
  sourceFileId: string;
  sourceSha256: string;
  technicalReceiptSha256: string;
  rightsVerdictSha256: string;
  outputs: DerivativeOutput[];
  executedAt: string;
  receiptSha256: string;
};

export type ProcessorChainRecord = {
  schema: "tmg.processor-chain.v1.1";
  chainId: string;
  instanceId: string;
  state:
    | "requested"
    | "waiting_technical_authority"
    | "technical_processing"
    | "waiting_rights_verdict"
    | "rights_blocked"
    | "waiting_derivative_authority"
    | "derivative_processing"
    | "derivative_complete"
    | "failed";
  sourceFileId: string;
  startedBy: string;
  startedAt: string;
  technicalAuthority?: ProcessorAuthorityEnvelope;
  technicalReceipt?: TechnicalInspectionReceipt;
  rightsVerdict?: RightsSufficiencyVerdict;
  derivativeAuthority?: DerivativeAuthorityEnvelope;
  derivativeReceipt?: DerivativeReceipt;
};

export type ProcessorChainDispatch = {
  requestId: string;
  reviewId: string;
  chainId: string;
  chainInstanceId: string;
  startedBy: string;
};

export type TechnicalAuthorityEvent = { authorityId: string; requestId: string; reviewId: string };
export type RightsVerdictEvent = { verdictId: string; requestId: string; reviewId: string };
export type DerivativeAuthorityEvent = { authorityId: string; requestId: string; reviewId: string };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

export async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function evidenceBindingsSha256(files: WorkRequestFile[]): Promise<string> {
  return sha256Json(files.map((file) => ({ fileId: file.fileId, sha256: file.sha256, size: file.size })).sort((a, b) => a.fileId.localeCompare(b.fileId)));
}

export function chainOf(manifest: WorkRequestManifest): ProcessorChainRecord | null {
  const raw = manifest.workflow?.processorChain;
  if (!raw || typeof raw !== "object") return null;
  const chain = raw as ProcessorChainRecord;
  return chain.schema === "tmg.processor-chain.v1.1" ? chain : null;
}

export function setChain(manifest: WorkRequestManifest, chain: ProcessorChainRecord): void {
  if (!manifest.workflow) manifest.workflow = {};
  manifest.workflow.processorChain = chain;
}

export function sourceMediaFile(manifest: WorkRequestManifest): WorkRequestFile | null {
  return manifest.files.find((file) => file.status === "uploaded" && (file.type.startsWith("video/") || file.type.startsWith("image/"))) ?? null;
}

export function technicalInspectionRoute(): {
  processorId: ProcessorId;
  allowedActions: string[];
} {
  return {
    processorId: "technical-inspection",
    allowedActions: ["read_bound_media", "run_ffprobe", "decode_media", "record_technical_receipt"],
  };
}

export function buildTechnicalAuthority(
  manifest: WorkRequestManifest,
  chain: ProcessorChainRecord,
  operatorEmail: string,
  note: string,
  ttlMs = 60 * 60 * 1000,
): ProcessorAuthorityEnvelope {
  if (!manifest.review?.reviewId) throw new Error("approved_review_required");
  const route = technicalInspectionRoute();
  const grantedAt = new Date().toISOString();
  return {
    schema: "tmg.processor-authority.v1",
    authorityId: `pa_${crypto.randomUUID()}`,
    processorId: "technical-inspection",
    state: "authorized",
    requestId: manifest.requestId,
    serviceType: manifest.request.serviceType,
    reviewId: manifest.review.reviewId,
    workflowInstanceId: chain.instanceId,
    grantedBy: operatorEmail,
    grantedAt,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    localExecutionOnly: true,
    publicationAuthorized: false,
    externalProviderEgressAuthorized: false,
    allowedActions: route.allowedActions,
    evidenceBindings: manifest.files.map((file) => ({ fileId: file.fileId, sha256: file.sha256, size: file.size })),
    note,
  };
}

export async function validateTechnicalAuthority(
  manifest: WorkRequestManifest,
  chain: ProcessorChainRecord,
  authority: ProcessorAuthorityEnvelope | undefined,
  event: TechnicalAuthorityEvent,
  nowMs = Date.now(),
): Promise<string[]> {
  const reasons: string[] = [];
  if (!authority) return ["technical_authority_missing"];
  if (authority.schema !== "tmg.processor-authority.v1" || authority.processorId !== "technical-inspection") reasons.push("technical_authority_schema_or_processor_invalid");
  if (authority.state !== "authorized") reasons.push("technical_authority_not_active");
  if (authority.requestId !== manifest.requestId || authority.reviewId !== manifest.review?.reviewId || authority.workflowInstanceId !== chain.instanceId) reasons.push("technical_authority_binding_mismatch");
  if (authority.localExecutionOnly !== true || authority.publicationAuthorized !== false || authority.externalProviderEgressAuthorized !== false) reasons.push("technical_authority_scope_invalid");
  if (Date.parse(authority.expiresAt) <= nowMs) reasons.push("technical_authority_expired");
  if (event.authorityId !== authority.authorityId || event.requestId !== manifest.requestId || event.reviewId !== manifest.review?.reviewId) reasons.push("technical_authority_event_mismatch");
  const routeActions = technicalInspectionRoute().allowedActions;
  if (routeActions.length !== authority.allowedActions.length || !routeActions.every((action) => authority.allowedActions.includes(action))) reasons.push("technical_authority_actions_mismatch");
  if (await evidenceBindingsSha256(manifest.files) !== await evidenceBindingsSha256(authority.evidenceBindings.map((binding) => ({ ...binding, name: "", type: "", status: "uploaded", objectKey: "" } as WorkRequestFile)))) reasons.push("technical_authority_evidence_mismatch");
  if (!manifest.controls.processingAuthorized || manifest.controls.publicationAuthorized || manifest.controls.externalProviderEgressAuthorized) reasons.push("request_authority_scope_invalid");
  return reasons;
}

export async function withReceiptSha<T extends Record<string, unknown>>(receipt: Omit<T, "receiptSha256">): Promise<T> {
  const receiptSha256 = await sha256Json(receipt);
  return { ...receipt, receiptSha256 } as unknown as T;
}

export async function validateReceiptSha(receipt: Record<string, unknown>): Promise<boolean> {
  const expected = receipt.receiptSha256;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const { receiptSha256: _ignored, ...rest } = receipt;
  return (await sha256Json(rest)).toLowerCase() === expected.toLowerCase();
}

export async function buildRightsVerdict(
  manifest: WorkRequestManifest,
  chain: ProcessorChainRecord,
  input: {
    state: RightsSufficiencyVerdict["state"];
    permittedUses: RightsPermittedUse[];
    permittedTerritories: string[];
    expiresAt: string | null;
    note: string;
  },
  operatorEmail: string,
): Promise<RightsSufficiencyVerdict> {
  if (!manifest.review?.reviewId || !chain.technicalReceipt) throw new Error("technical_receipt_and_review_required");
  const base = {
    schema: "tmg.rights-sufficiency-verdict.v1" as const,
    verdictId: `rv_${crypto.randomUUID()}`,
    requestId: manifest.requestId,
    reviewId: manifest.review.reviewId,
    chainInstanceId: chain.instanceId,
    state: input.state,
    permittedUses: [...new Set(input.permittedUses)],
    permittedTerritories: [...new Set(input.permittedTerritories.map((value) => value.trim()).filter(Boolean))].slice(0, 64),
    technicalReceiptSha256: chain.technicalReceipt.receiptSha256,
    evidenceBindingsSha256: await evidenceBindingsSha256(manifest.files),
    decidedBy: operatorEmail,
    decidedAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
    note: input.note,
  };
  return withReceiptSha<RightsSufficiencyVerdict>(base as Omit<RightsSufficiencyVerdict, "receiptSha256">);
}

export function recipeDefinition(recipeId: string): (typeof DERIVATIVE_RECIPES)[DerivativeRecipeId] | null {
  return Object.prototype.hasOwnProperty.call(DERIVATIVE_RECIPES, recipeId)
    ? DERIVATIVE_RECIPES[recipeId as DerivativeRecipeId]
    : null;
}

export async function buildDerivativeAuthority(
  manifest: WorkRequestManifest,
  chain: ProcessorChainRecord,
  recipeId: DerivativeRecipeId,
  operatorEmail: string,
  note: string,
  ttlMs = 60 * 60 * 1000,
): Promise<DerivativeAuthorityEnvelope> {
  const source = sourceMediaFile(manifest);
  const recipe = recipeDefinition(recipeId);
  if (!source || !recipe || !manifest.review?.reviewId || !chain.technicalReceipt || !chain.rightsVerdict) throw new Error("derivative_upstream_receipts_required");
  if (chain.rightsVerdict.state !== "sufficient") throw new Error("rights_verdict_not_sufficient");
  for (const requiredUse of recipe.requiredUses) {
    if (!chain.rightsVerdict.permittedUses.includes(requiredUse)) throw new Error(`rights_use_not_permitted:${requiredUse}`);
  }
  const grantedAt = new Date().toISOString();
  return {
    schema: "tmg.derivative-authority.v1",
    authorityId: `da_${crypto.randomUUID()}`,
    requestId: manifest.requestId,
    reviewId: manifest.review.reviewId,
    chainInstanceId: chain.instanceId,
    state: "authorized",
    recipeId,
    allowedActions: [...recipe.actions],
    sourceFileId: source.fileId,
    sourceSha256: source.sha256,
    technicalReceiptSha256: chain.technicalReceipt.receiptSha256,
    rightsVerdictSha256: chain.rightsVerdict.receiptSha256,
    outputPrefix: `derived/${manifest.requestId}/${chain.chainId}/${recipeId}`,
    publicationAuthorized: false,
    externalProviderEgressAuthorized: false,
    grantedBy: operatorEmail,
    grantedAt,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    note,
  };
}

export async function validateDerivativeAuthority(
  manifest: WorkRequestManifest,
  chain: ProcessorChainRecord,
  authority: DerivativeAuthorityEnvelope | undefined,
  event: DerivativeAuthorityEvent,
  nowMs = Date.now(),
): Promise<string[]> {
  const reasons: string[] = [];
  const source = sourceMediaFile(manifest);
  if (!authority) return ["derivative_authority_missing"];
  const recipe = recipeDefinition(authority.recipeId);
  if (!recipe || !source || !chain.technicalReceipt || !chain.rightsVerdict) return ["derivative_upstream_receipts_missing"];
  if (authority.schema !== "tmg.derivative-authority.v1" || authority.state !== "authorized") reasons.push("derivative_authority_invalid");
  if (authority.requestId !== manifest.requestId || authority.reviewId !== manifest.review?.reviewId || authority.chainInstanceId !== chain.instanceId) reasons.push("derivative_authority_binding_mismatch");
  if (authority.sourceFileId !== source.fileId || authority.sourceSha256 !== source.sha256) reasons.push("derivative_source_binding_mismatch");
  if (authority.technicalReceiptSha256 !== chain.technicalReceipt.receiptSha256 || authority.rightsVerdictSha256 !== chain.rightsVerdict.receiptSha256) reasons.push("derivative_upstream_receipt_mismatch");
  if (!(await validateReceiptSha(chain.technicalReceipt as unknown as Record<string, unknown>))) reasons.push("technical_receipt_hash_invalid");
  if (!(await validateReceiptSha(chain.rightsVerdict as unknown as Record<string, unknown>))) reasons.push("rights_verdict_hash_invalid");
  if (chain.rightsVerdict.state !== "sufficient") reasons.push("rights_verdict_not_sufficient");
  if (chain.rightsVerdict.expiresAt && Date.parse(chain.rightsVerdict.expiresAt) <= nowMs) reasons.push("rights_verdict_expired");
  if (chain.rightsVerdict.evidenceBindingsSha256 !== await evidenceBindingsSha256(manifest.files)) reasons.push("rights_verdict_evidence_drift");
  for (const requiredUse of recipe.requiredUses) if (!chain.rightsVerdict.permittedUses.includes(requiredUse)) reasons.push(`rights_use_not_permitted:${requiredUse}`);
  if (recipe.actions.length !== authority.allowedActions.length || !recipe.actions.every((action) => authority.allowedActions.includes(action))) reasons.push("derivative_actions_mismatch");
  if (authority.publicationAuthorized !== false || authority.externalProviderEgressAuthorized !== false) reasons.push("derivative_authority_scope_invalid");
  if (Date.parse(authority.expiresAt) <= nowMs) reasons.push("derivative_authority_expired");
  if (event.authorityId !== authority.authorityId || event.requestId !== manifest.requestId || event.reviewId !== manifest.review?.reviewId) reasons.push("derivative_authority_event_mismatch");
  if (!manifest.controls.processingAuthorized || manifest.controls.publicationAuthorized || manifest.controls.externalProviderEgressAuthorized) reasons.push("request_authority_scope_invalid");
  return reasons;
}
