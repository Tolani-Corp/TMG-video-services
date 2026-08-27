export type WorkRequestStatus =
  | "draft_uploading"
  | "received_unreviewed"
  | "reviewing"
  | "approved_for_processing"
  | "processing"
  | "action_required"
  | "completed"
  | "rejected"
  | "withdrawn"
  | "failed";

export type WorkRequestFile = {
  fileId: string;
  name: string;
  size: number;
  type: string;
  sha256: string;
  status: "pending" | "uploaded";
  objectKey: string;
  etag?: string;
  uploadedAt?: string;
};

export type WorkRequestControls = {
  processingAuthorized: boolean;
  publicationAuthorized: boolean;
  externalProviderEgressAuthorized: boolean;
};

export type ReviewRecord = {
  state: "started" | "approved" | "rejected";
  reviewId: string;
  reviewerEmail: string;
  note: string;
  at: string;
};

export type ProcessorId = "rights-provenance" | "media-inspection" | "content-analysis" | "custom";

export type ProcessorAuthorityEnvelope = {
  schema: "tmg.processor-authority.v1";
  authorityId: string;
  processorId: ProcessorId;
  state: "authorized" | "consumed" | "revoked";
  requestId: string;
  serviceType: string;
  reviewId: string;
  workflowInstanceId: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  consumedAt?: string;
  localExecutionOnly: true;
  publicationAuthorized: false;
  externalProviderEgressAuthorized: false;
  allowedActions: string[];
  evidenceBindings: Array<{ fileId: string; sha256: string; size: number }>;
  note: string;
};

export type ProcessorRoute = {
  processorId: ProcessorId;
  state: string;
  authorizable: boolean;
  localOnly: boolean;
  adapter: "rights-provenance-v1" | "media-inspection-v1" | null;
  allowedActions: string[];
  nextAction: string;
};

export type WorkflowRecord = Record<string, unknown> & {
  instanceId?: string;
  dispatchState?: string;
  phase?: string;
  progress?: number;
  headline?: string;
  summary?: string;
  processorId?: ProcessorId;
  processorState?: string;
  processorAuthorizationState?: string;
  processorResults?: Record<string, Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  outcome?: Record<string, unknown>;
};

export type WorkRequestManifest = {
  schema: "tmg.work-request.v1";
  requestId: string;
  status: WorkRequestStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  requester: { name: string; email: string; organization: string | null };
  request: {
    serviceType: string;
    title: string;
    description: string;
    desiredOutcome: string;
    targetDate: string | null;
  };
  rights: { authorizedToShare: boolean; humanReviewAcknowledged: boolean };
  controls: WorkRequestControls;
  tokenHash: string;
  files: WorkRequestFile[];
  review?: ReviewRecord;
  processorAuthorizations?: Partial<Record<ProcessorId, ProcessorAuthorityEnvelope>>;
  workflow?: WorkflowRecord;
};

export type WorkflowInstance = {
  id?: string;
  sendEvent(options: { type: string; payload: unknown }): Promise<void>;
  status?(): Promise<unknown>;
};

export type WorkflowBinding = {
  create(options?: { id?: string; params?: unknown }): Promise<{ id: string }>;
  get(id: string): Promise<WorkflowInstance>;
};

export type ReviewEnv = {
  WORK_REQUESTS: R2Bucket;
  WORK_REQUEST_PROCESSOR: WorkflowBinding;
  TMG_REVIEW_ALLOWED_EMAIL_DOMAINS?: string;
};

export type DispatchPayload = { requestId: string; reviewId: string; reviewerEmail: string };
export type ProcessorAuthorizationEvent = { authorityId: string; processorId: ProcessorId; reviewId: string };

export const VALID_STATUSES = new Set<WorkRequestStatus>([
  "draft_uploading", "received_unreviewed", "reviewing", "approved_for_processing", "processing",
  "action_required", "completed", "rejected", "withdrawn", "failed",
]);

export function manifestKey(requestId: string): string {
  return `requests/${requestId}/manifest.json`;
}

export function validRequestId(value: string): boolean {
  return /^wr_[0-9]{8}_[0-9a-f-]{36}$/i.test(value);
}

export function validFileId(value: string): boolean {
  return /^file_[0-9a-f-]{36}$/i.test(value);
}

export function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, max) : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export async function loadManifest(env: Pick<ReviewEnv, "WORK_REQUESTS">, requestId: string): Promise<WorkRequestManifest | null> {
  if (!validRequestId(requestId)) return null;
  const object = await env.WORK_REQUESTS.get(manifestKey(requestId));
  if (!object) return null;
  try {
    const manifest = JSON.parse(await object.text()) as WorkRequestManifest;
    if (manifest.schema !== "tmg.work-request.v1" || !VALID_STATUSES.has(manifest.status)) return null;
    return manifest;
  } catch {
    return null;
  }
}

export async function writeManifest(env: Pick<ReviewEnv, "WORK_REQUESTS">, manifest: WorkRequestManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await env.WORK_REQUESTS.put(manifestKey(manifest.requestId), JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "no-store" },
    customMetadata: { schema: manifest.schema, requestId: manifest.requestId, status: manifest.status },
  });
}

export function workflowOf(manifest: WorkRequestManifest): WorkflowRecord {
  const workflow = manifest.workflow ?? {};
  manifest.workflow = workflow;
  if (!Array.isArray(workflow.events)) workflow.events = [];
  return workflow;
}

export function appendEvent(
  manifest: WorkRequestManifest,
  event: { phase: string; state: string; title: string; detail?: string | null },
): void {
  const workflow = workflowOf(manifest);
  const events = Array.isArray(workflow.events) ? workflow.events : [];
  events.push({
    id: `evt_${crypto.randomUUID()}`,
    at: new Date().toISOString(),
    phase: event.phase,
    state: event.state,
    title: event.title.slice(0, 140),
    detail: event.detail?.slice(0, 480) ?? null,
  });
  workflow.events = events.slice(-40);
}

export function processorRoute(serviceType: string): ProcessorRoute {
  switch (serviceType) {
    case "video-intelligence":
      return {
        processorId: "media-inspection",
        state: "processor_authorization_required",
        authorizable: true,
        localOnly: true,
        adapter: "media-inspection-v1",
        allowedActions: ["read_bound_media_header", "inspect_media_signature", "record_local_inspection"],
        nextAction: "Explicitly authorize the local media-inspection adapter. Video intelligence remains separately gated after inspection.",
      };
    case "media-processing":
      return {
        processorId: "media-inspection",
        state: "processor_authorization_required",
        authorizable: true,
        localOnly: true,
        adapter: "media-inspection-v1",
        allowedActions: ["read_bound_media_header", "inspect_media_signature", "record_local_inspection"],
        nextAction: "Explicitly authorize the local media-inspection adapter. Derivative processing recipes remain separately gated after inspection.",
      };
    case "image-processing":
      return {
        processorId: "media-inspection",
        state: "processor_authorization_required",
        authorizable: true,
        localOnly: true,
        adapter: "media-inspection-v1",
        allowedActions: ["read_bound_media_header", "inspect_media_signature", "record_local_inspection"],
        nextAction: "Explicitly authorize the local media-inspection adapter. Image transformation remains separately gated after inspection.",
      };
    case "rights-provenance":
      return {
        processorId: "rights-provenance",
        state: "processor_authorization_required",
        authorizable: true,
        localOnly: true,
        adapter: "rights-provenance-v1",
        allowedActions: ["validate_bound_evidence", "validate_rights_attestations", "record_structural_provenance"],
        nextAction: "Explicitly authorize the local rights/provenance structural verifier. Legal/contractual sufficiency remains a human decision.",
      };
    case "content-analysis":
      return {
        processorId: "content-analysis",
        state: "provider_egress_gated",
        authorizable: false,
        localOnly: false,
        adapter: null,
        allowedActions: [],
        nextAction: "Select an approved local or governed provider path; external-provider egress remains disabled.",
      };
    default:
      return {
        processorId: "custom",
        state: "operator_routing_required",
        authorizable: false,
        localOnly: false,
        adapter: null,
        allowedActions: [],
        nextAction: "Assign a governed processor and record its authority envelope before execution.",
      };
  }
}
