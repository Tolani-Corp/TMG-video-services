type ServiceFetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type RateLimiter = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

type R2ObjectLike = {
  size: number;
  etag?: string;
  text?: () => Promise<string>;
};

type WorkRequestBucket = {
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: {
      httpMetadata?: { contentType?: string; contentDisposition?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
      sha256?: ArrayBuffer | string;
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<R2ObjectLike | null>;
};

type SiteEnv = {
  ASSETS: ServiceFetcher;
  TMG_BACKEND: ServiceFetcher;
  WORK_REQUESTS: WorkRequestBucket;
  WORK_REQUEST_START_LIMITER: RateLimiter;
  WORK_REQUEST_UPLOAD_LIMITER: RateLimiter;
  TMG_WORK_REQUEST_INTAKE_ENABLED?: string;
};

type UnknownRecord = Record<string, unknown>;

type WorkRequestStatus =
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

type WorkRequestFile = {
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

type WorkRequestControls = {
  processingAuthorized: boolean;
  publicationAuthorized: boolean;
  externalProviderEgressAuthorized: boolean;
};

type WorkRequestManifest = {
  schema: "tmg.work-request.v1";
  requestId: string;
  status: WorkRequestStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  requester: {
    name: string;
    email: string;
    organization: string | null;
  };
  request: {
    serviceType: string;
    title: string;
    description: string;
    desiredOutcome: string;
    targetDate: string | null;
  };
  rights: {
    authorizedToShare: boolean;
    humanReviewAcknowledged: boolean;
  };
  controls: WorkRequestControls;
  tokenHash: string;
  files: WorkRequestFile[];
  workflow?: UnknownRecord;
};

const MAX_FILES = 5;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);
const SERVICE_TYPES = new Set([
  "video-intelligence",
  "media-processing",
  "rights-provenance",
  "image-processing",
  "content-analysis",
  "custom",
]);
const WORK_REQUEST_STATUSES = new Set<WorkRequestStatus>([
  "draft_uploading",
  "received_unreviewed",
  "reviewing",
  "approved_for_processing",
  "processing",
  "action_required",
  "completed",
  "rejected",
  "withdrawn",
  "failed",
]);
const PROCESSING_STAGE_LABELS = [
  ["intake", "Intake"],
  ["review", "Human review"],
  ["authorization", "Authority"],
  ["processing", "Processing"],
  ["outcome", "Outcome"],
] as const;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asString(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function cleanOptionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return "";
  return cleanText(value, maxLength);
}

function normalizeFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  if (!name || name.length > 180 || name === "." || name === "..") return null;
  return name;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function intakeEnabled(env: SiteEnv): boolean {
  return env.TMG_WORK_REQUEST_INTAKE_ENABLED === "true";
}

function intakeConfig(env: SiteEnv): Response {
  return json({
    schema: "tmg.work-request-intake-config.v1",
    enabled: intakeEnabled(env),
    maxFiles: MAX_FILES,
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    allowedTypes: [...ALLOWED_TYPES],
    posture: "private_quarantine_human_review",
    processingAuthorized: false,
    publicationAuthorized: false,
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestManifestKey(requestId: string): string {
  return `requests/${requestId}/manifest.json`;
}

function validRequestId(value: string): boolean {
  return /^wr_[0-9]{8}_[0-9a-f-]{36}$/i.test(value);
}

function validFileId(value: string): boolean {
  return /^file_[0-9a-f-]{36}$/i.test(value);
}

async function loadManifest(env: SiteEnv, requestId: string): Promise<WorkRequestManifest | null> {
  if (!validRequestId(requestId)) return null;
  const object = await env.WORK_REQUESTS.get(requestManifestKey(requestId));
  if (!object?.text) return null;
  try {
    const manifest = JSON.parse(await object.text()) as WorkRequestManifest;
    if (!WORK_REQUEST_STATUSES.has(manifest.status)) return null;
    return manifest;
  } catch {
    return null;
  }
}

async function writeManifest(env: SiteEnv, manifest: WorkRequestManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await env.WORK_REQUESTS.put(requestManifestKey(manifest.requestId), JSON.stringify(manifest, null, 2), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-store",
    },
    customMetadata: {
      schema: manifest.schema,
      requestId: manifest.requestId,
      status: manifest.status,
    },
  });
}

async function authenticateRequest(request: Request, manifest: WorkRequestManifest): Promise<boolean> {
  const token = request.headers.get("x-work-request-token");
  if (!token || token.length > 256) return false;
  return (await sha256Hex(token)) === manifest.tokenHash;
}

function rateLimitKey(request: Request, suffix: string): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return `${suffix}:${ip}`;
}

function lifecycleDefaults(status: WorkRequestStatus): {
  rank: number;
  progress: number;
  phase: string;
  state: "active" | "waiting" | "action_required" | "terminal";
  headline: string;
  summary: string;
} {
  switch (status) {
    case "draft_uploading":
      return {
        rank: 0,
        progress: 15,
        phase: "intake",
        state: "active",
        headline: "Securing your request",
        summary: "Files are being checksum-bound and placed in private quarantine.",
      };
    case "received_unreviewed":
      return {
        rank: 1,
        progress: 35,
        phase: "human_review",
        state: "waiting",
        headline: "Awaiting human review",
        summary: "The request is sealed in quarantine. Processing has not started and no publication authority exists.",
      };
    case "reviewing":
      return {
        rank: 1,
        progress: 45,
        phase: "human_review",
        state: "active",
        headline: "Human review in progress",
        summary: "Scope, rights evidence, requested outcome, and processing boundaries are being evaluated.",
      };
    case "approved_for_processing":
      return {
        rank: 2,
        progress: 58,
        phase: "authorization",
        state: "waiting",
        headline: "Processing authority approved",
        summary: "The request has passed review and is waiting for an authorized workflow execution slot.",
      };
    case "processing":
      return {
        rank: 3,
        progress: 72,
        phase: "processing",
        state: "active",
        headline: "Governed processing in progress",
        summary: "Authorized workflow steps are executing. Live evidence and outcome context will appear here as they are recorded.",
      };
    case "action_required":
      return {
        rank: 3,
        progress: 76,
        phase: "action_required",
        state: "action_required",
        headline: "Your input is required",
        summary: "The workflow is holding at a governed checkpoint pending additional context or a human decision.",
      };
    case "completed":
      return {
        rank: 4,
        progress: 100,
        phase: "outcome",
        state: "terminal",
        headline: "Processing complete",
        summary: "The governed workflow reached a terminal outcome. Review the outcome context and available deliverables below.",
      };
    case "rejected":
      return {
        rank: 4,
        progress: 100,
        phase: "closed",
        state: "terminal",
        headline: "Request closed during review",
        summary: "The request did not receive authority to proceed into processing.",
      };
    case "withdrawn":
      return {
        rank: 4,
        progress: 100,
        phase: "closed",
        state: "terminal",
        headline: "Request withdrawn",
        summary: "The request is closed and no additional workflow activity is authorized.",
      };
    case "failed":
      return {
        rank: 4,
        progress: 100,
        phase: "failed",
        state: "terminal",
        headline: "Processing stopped",
        summary: "The workflow reached a failure state. The recorded outcome context identifies the latest safe checkpoint.",
      };
  }
}

function clampProgress(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sanitizedWorkflowEvents(workflow: UnknownRecord, fallbackPhase: string, fallbackAt: string): Array<UnknownRecord> {
  const source = Array.isArray(workflow.events) ? workflow.events.slice(-12) : [];
  const events: Array<UnknownRecord> = [];
  for (let index = 0; index < source.length; index += 1) {
    const event = asRecord(source[index]);
    const title = boundedText(event.title, 140);
    if (!title) continue;
    events.push({
      id: boundedText(event.id, 80) ?? `event-${index + 1}`,
      at: boundedText(event.at, 48) ?? fallbackAt,
      phase: boundedText(event.phase, 48) ?? fallbackPhase,
      state: boundedText(event.state, 32) ?? "observed",
      title,
      detail: boundedText(event.detail, 480),
    });
  }
  return events;
}

function sanitizedOutcome(workflow: UnknownRecord): UnknownRecord | null {
  const outcome = asRecord(workflow.outcome);
  const headline = boundedText(outcome.headline, 180);
  const summary = boundedText(outcome.summary, 1200);
  const nextAction = boundedText(outcome.nextAction, 480);
  const confidence = boundedText(outcome.confidence, 80);

  const evidence = (Array.isArray(outcome.evidence) ? outcome.evidence : [])
    .slice(0, 8)
    .map((raw) => {
      const item = asRecord(raw);
      const label = boundedText(item.label, 120);
      const value = boundedText(item.value, 320);
      return label && value ? { label, value } : null;
    })
    .filter((item): item is { label: string; value: string } => item !== null);

  const deliverables = (Array.isArray(outcome.deliverables) ? outcome.deliverables : [])
    .slice(0, 8)
    .map((raw) => {
      const item = asRecord(raw);
      const label = boundedText(item.label, 140);
      const state = boundedText(item.status, 64) ?? "available";
      return label ? { label, status: state } : null;
    })
    .filter((item): item is { label: string; status: string } => item !== null);

  if (!headline && !summary && !nextAction && !confidence && evidence.length === 0 && deliverables.length === 0) return null;
  return {
    status: boundedText(outcome.status, 48) ?? "recorded",
    headline,
    summary,
    nextAction,
    confidence,
    evidence,
    deliverables,
  };
}

function processingStatusFromManifest(manifest: WorkRequestManifest): UnknownRecord {
  const defaults = lifecycleDefaults(manifest.status);
  const workflow = asRecord(manifest.workflow);
  const progress = clampProgress(workflow.progress, defaults.progress);
  const phase = boundedText(workflow.phase, 64) ?? defaults.phase;
  const headline = boundedText(workflow.headline, 180) ?? defaults.headline;
  const summary = boundedText(workflow.summary, 1200) ?? defaults.summary;
  const terminal = defaults.state === "terminal";
  const stages = PROCESSING_STAGE_LABELS.map(([key, label], index) => ({
    key,
    label,
    state: manifest.status === "completed"
      ? "complete"
      : index < defaults.rank
        ? "complete"
        : index === defaults.rank
          ? terminal
            ? "blocked"
            : "active"
          : "pending",
  }));

  const uploadedFiles = manifest.files.filter((file) => file.status === "uploaded").length;
  return {
    schema: "tmg.work-request-processing-status.v1",
    requestId: manifest.requestId,
    status: manifest.status,
    updatedAt: manifest.updatedAt,
    createdAt: manifest.createdAt,
    request: {
      title: manifest.request.title,
      serviceType: manifest.request.serviceType,
      desiredOutcome: manifest.request.desiredOutcome,
      targetDate: manifest.request.targetDate,
    },
    lifecycle: {
      phase,
      state: defaults.state,
      progress,
      headline,
      summary,
      stages,
    },
    context: {
      files: { total: manifest.files.length, uploaded: uploadedFiles },
      rights: {
        authorizedToShare: manifest.rights.authorizedToShare === true,
        humanReviewAcknowledged: manifest.rights.humanReviewAcknowledged === true,
      },
      controls: {
        processingAuthorized: manifest.controls.processingAuthorized === true,
        publicationAuthorized: manifest.controls.publicationAuthorized === true,
        externalProviderEgressAuthorized: manifest.controls.externalProviderEgressAuthorized === true,
      },
    },
    events: sanitizedWorkflowEvents(workflow, phase, manifest.updatedAt),
    outcome: sanitizedOutcome(workflow),
    clientActions: ["pause_live_updates", "refresh", "copy_reference", "download_snapshot", "new_request"],
  };
}

async function getWorkRequestProcessingStatus(request: Request, env: SiteEnv, requestId: string): Promise<Response> {
  if (!intakeEnabled(env) || !validRequestId(requestId)) return json({ error: "not_found" }, 404);

  const limit = await env.WORK_REQUEST_UPLOAD_LIMITER.limit({ key: `status:${requestId}` });
  if (!limit.success) return json({ error: "rate_limit_exceeded" }, 429);

  const manifest = await loadManifest(env, requestId);
  if (!manifest || !(await authenticateRequest(request, manifest))) return json({ error: "not_found" }, 404);
  return json(processingStatusFromManifest(manifest));
}

async function startWorkRequest(request: Request, env: SiteEnv): Promise<Response> {
  if (!intakeEnabled(env)) {
    return json({ error: "work_request_intake_disabled" }, 503);
  }

  const limit = await env.WORK_REQUEST_START_LIMITER.limit({ key: rateLimitKey(request, "start") });
  if (!limit.success) return json({ error: "rate_limit_exceeded" }, 429);

  const body = asRecord(await request.json().catch(() => null));
  const requester = asRecord(body.requester);
  const requestBody = asRecord(body.request);
  const filesInput = Array.isArray(body.files) ? body.files : [];

  const name = cleanText(requester.name, 120);
  const emailRaw = cleanText(requester.email, 254);
  const organizationRaw = cleanOptionalText(requester.organization, 160);
  const organization = organizationRaw === "" ? null : organizationRaw;
  const serviceType = cleanText(requestBody.serviceType, 64);
  const title = cleanText(requestBody.title, 160);
  const description = cleanText(requestBody.description, 4000);
  const desiredOutcome = cleanText(requestBody.desiredOutcome, 2000);
  const targetDateRaw = cleanOptionalText(requestBody.targetDate, 10);
  const targetDate = targetDateRaw === "" ? null : targetDateRaw;

  if (!name || !emailRaw || !isEmail(emailRaw) || !serviceType || !SERVICE_TYPES.has(serviceType) || !title || !description || !desiredOutcome) {
    return json({ error: "invalid_work_request" }, 400);
  }
  if (targetDate !== null && !isIsoDate(targetDate)) return json({ error: "invalid_target_date" }, 400);
  if (body.authorizedToShare !== true || body.humanReviewAcknowledged !== true) {
    return json({ error: "required_attestations_missing" }, 400);
  }
  if (filesInput.length > MAX_FILES) return json({ error: "too_many_files", maxFiles: MAX_FILES }, 400);

  let totalBytes = 0;
  const pendingFiles: Array<Omit<WorkRequestFile, "fileId" | "objectKey" | "status">> = [];
  for (const raw of filesInput) {
    const file = asRecord(raw);
    const fileName = normalizeFileName(file.name);
    const fileType = cleanText(file.type, 120);
    const fileSize = typeof file.size === "number" && Number.isSafeInteger(file.size) ? file.size : -1;
    const fileSha = typeof file.sha256 === "string" ? file.sha256.toLowerCase() : "";
    if (!fileName || !fileType || !ALLOWED_TYPES.has(fileType) || fileSize < 1 || fileSize > MAX_FILE_BYTES || !isSha256(fileSha)) {
      return json({ error: "invalid_file_metadata", file: fileName ?? "unknown" }, 400);
    }
    totalBytes += fileSize;
    pendingFiles.push({ name: fileName, type: fileType, size: fileSize, sha256: fileSha });
  }
  if (totalBytes > MAX_TOTAL_BYTES) return json({ error: "total_upload_too_large", maxTotalBytes: MAX_TOTAL_BYTES }, 400);

  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const requestId = `wr_${today}_${crypto.randomUUID()}`;
  const uploadToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const tokenHash = await sha256Hex(uploadToken);
  const createdAt = new Date().toISOString();
  const files: WorkRequestFile[] = pendingFiles.map((file) => {
    const fileId = `file_${crypto.randomUUID()}`;
    return {
      ...file,
      fileId,
      status: "pending",
      objectKey: `quarantine/${requestId}/files/${fileId}`,
    };
  });

  const manifest: WorkRequestManifest = {
    schema: "tmg.work-request.v1",
    requestId,
    status: "draft_uploading",
    createdAt,
    updatedAt: createdAt,
    requester: {
      name,
      email: emailRaw.toLowerCase(),
      organization,
    },
    request: {
      serviceType,
      title,
      description,
      desiredOutcome,
      targetDate,
    },
    rights: {
      authorizedToShare: true,
      humanReviewAcknowledged: true,
    },
    controls: {
      processingAuthorized: false,
      publicationAuthorized: false,
      externalProviderEgressAuthorized: false,
    },
    tokenHash,
    files,
  };

  await writeManifest(env, manifest);

  return json(
    {
      schema: "tmg.work-request-receipt.v1",
      requestId,
      uploadToken,
      status: manifest.status,
      files: files.map(({ fileId, name, size, type }) => ({ fileId, name, size, type })),
      controls: manifest.controls,
    },
    201,
  );
}

async function uploadWorkRequestFile(request: Request, env: SiteEnv, requestId: string, fileId: string): Promise<Response> {
  if (!intakeEnabled(env)) return json({ error: "work_request_intake_disabled" }, 503);
  if (!validRequestId(requestId) || !validFileId(fileId)) return json({ error: "not_found" }, 404);

  const manifest = await loadManifest(env, requestId);
  if (!manifest || !(await authenticateRequest(request, manifest))) return json({ error: "not_found" }, 404);
  if (manifest.status !== "draft_uploading") return json({ error: "request_not_accepting_uploads" }, 409);

  const limit = await env.WORK_REQUEST_UPLOAD_LIMITER.limit({ key: requestId });
  if (!limit.success) return json({ error: "rate_limit_exceeded" }, 429);

  const expected = manifest.files.find((file) => file.fileId === fileId);
  if (!expected) return json({ error: "file_not_registered" }, 404);
  if (expected.status === "uploaded") return json({ error: "file_already_uploaded" }, 409);

  const contentLength = Number(request.headers.get("content-length"));
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!Number.isSafeInteger(contentLength) || contentLength !== expected.size || contentLength > MAX_FILE_BYTES) {
    return json({ error: "file_size_mismatch" }, 400);
  }
  if (contentType !== expected.type) return json({ error: "file_type_mismatch" }, 400);
  if (!request.body) return json({ error: "file_body_required" }, 400);

  const existing = await env.WORK_REQUESTS.head(expected.objectKey);
  if (existing) return json({ error: "file_already_uploaded" }, 409);

  const stored = await env.WORK_REQUESTS.put(expected.objectKey, request.body, {
    httpMetadata: {
      contentType: expected.type,
      contentDisposition: `attachment; filename="${expected.name.replaceAll('"', "_")}"`,
      cacheControl: "no-store",
    },
    customMetadata: {
      requestId,
      fileId,
      originalName: expected.name,
      intakeStatus: "quarantine_unreviewed",
    },
    sha256: hexToArrayBuffer(expected.sha256),
  });

  if (!stored || stored.size !== expected.size) return json({ error: "upload_integrity_failure" }, 500);

  expected.status = "uploaded";
  if (stored.etag) expected.etag = stored.etag;
  expected.uploadedAt = new Date().toISOString();
  await writeManifest(env, manifest);

  return json({
    schema: "tmg.work-request-file-receipt.v1",
    requestId,
    fileId,
    status: "uploaded_quarantine",
    size: stored.size,
    sha256: expected.sha256,
  });
}

async function completeWorkRequest(request: Request, env: SiteEnv, requestId: string): Promise<Response> {
  if (!intakeEnabled(env)) return json({ error: "work_request_intake_disabled" }, 503);
  const manifest = await loadManifest(env, requestId);
  if (!manifest || !(await authenticateRequest(request, manifest))) return json({ error: "not_found" }, 404);
  if (manifest.status === "received_unreviewed") {
    return json({
      schema: "tmg.work-request-receipt.v1",
      requestId,
      status: manifest.status,
      controls: manifest.controls,
    });
  }
  if (manifest.status !== "draft_uploading") return json({ error: "request_not_completable" }, 409);

  for (const file of manifest.files) {
    if (file.status !== "uploaded") return json({ error: "uploads_incomplete", fileId: file.fileId }, 409);
    const object = await env.WORK_REQUESTS.head(file.objectKey);
    if (!object || object.size !== file.size) return json({ error: "upload_integrity_failure", fileId: file.fileId }, 409);
  }

  manifest.status = "received_unreviewed";
  manifest.completedAt = new Date().toISOString();
  await writeManifest(env, manifest);

  return json({
    schema: "tmg.work-request-receipt.v1",
    requestId,
    status: manifest.status,
    receivedAt: manifest.completedAt,
    controls: manifest.controls,
    nextStep: "human_review",
  });
}

async function backendGet(env: SiteEnv, path: string): Promise<Response> {
  return env.TMG_BACKEND.fetch(
    new Request(`https://tmg.internal${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-tmg-caller": "tolani-media-group-site",
      },
    }),
  );
}

function publicStatusFromBootstrap(bootstrap: UnknownRecord): unknown {
  const runtime = asRecord(bootstrap.runtime);
  const release = asRecord(bootstrap.release);

  return {
    schema: "tmg.public-status.v1",
    site: { status: "ok", worker: "tolani-media-group-site" },
    backend: {
      status: "reachable",
      worker: "tmg-video-services-production",
      service: asString(bootstrap.service),
      publicStatusGate: asString(bootstrap.publicStatusGate),
      policyVersion: asString(runtime.policyVersion),
      syncContract: "ui-bootstrap-v1",
    },
    runtime: {
      publicApiEnabled: asBoolean(runtime.publicApiEnabled),
      mcpEnabled: asBoolean(runtime.mcpEnabled),
      ingestWorkflowEnabled: asBoolean(runtime.ingestWorkflowEnabled),
      externalProviderEgressEnabled: asBoolean(runtime.externalProviderEgressEnabled),
      tenantUsageLedgerEnabled: asBoolean(runtime.tenantUsageLedgerEnabled),
      providerAcceptanceState: asString(runtime.providerAcceptanceState),
    },
    release: {
      status: asString(release.status),
      activationAuthorized: asBoolean(release.activationAuthorized),
      publicApiAuthorized: asBoolean(release.publicApiAuthorized),
      mcpAuthorized: asBoolean(release.mcpAuthorized),
      ingestionAuthorized: asBoolean(release.ingestionAuthorized),
      externalProviderEgressAuthorized: asBoolean(release.externalProviderEgressAuthorized),
      commercialUseAuthorized: asBoolean(release.commercialUseAuthorized),
    },
    synchronizedAt: new Date().toISOString(),
  };
}

function publicStatusFromHealth(health: UnknownRecord): unknown {
  return {
    schema: "tmg.public-status.v1",
    site: { status: "ok", worker: "tolani-media-group-site" },
    backend: {
      status: "reachable",
      worker: "tmg-video-services-production",
      service: asString(health.service),
      publicStatusGate: asString(health.publicStatusGate),
      policyVersion: asString(health.policyVersion),
      syncContract: "health-v1",
    },
    runtime: {
      publicApiEnabled: asBoolean(health.publicApiEnabled),
      mcpEnabled: asBoolean(health.mcpEnabled),
      ingestWorkflowEnabled: null,
      externalProviderEgressEnabled: null,
      tenantUsageLedgerEnabled: null,
      providerAcceptanceState: "not_exposed_by_health_contract",
    },
    release: null,
    synchronizedAt: new Date().toISOString(),
  };
}

async function buildPublicStatus(env: SiteEnv): Promise<Response> {
  try {
    const bootstrapResponse = await backendGet(env, "/v1/ui/bootstrap");
    if (bootstrapResponse.ok) return json(publicStatusFromBootstrap(asRecord(await bootstrapResponse.json())));

    const healthResponse = await backendGet(env, "/health");
    if (healthResponse.ok) return json(publicStatusFromHealth(asRecord(await healthResponse.json())));

    return json(
      {
        schema: "tmg.public-status.v1",
        site: { status: "ok", worker: "tolani-media-group-site" },
        backend: {
          status: "degraded",
          worker: "tmg-video-services-production",
          bootstrapHttpStatus: bootstrapResponse.status,
          healthHttpStatus: healthResponse.status,
        },
      },
      503,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "public_site_backend_sync_failed",
        message: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return json(
      {
        schema: "tmg.public-status.v1",
        site: { status: "ok", worker: "tolani-media-group-site" },
        backend: { status: "unavailable", worker: "tmg-video-services-production" },
      },
      503,
    );
  }
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/status.json") return buildPublicStatus(env);
    if (request.method === "GET" && url.pathname === "/work-requests/config") return intakeConfig(env);
    if (request.method === "POST" && url.pathname === "/work-requests") return startWorkRequest(request, env);

    const fileMatch = url.pathname.match(/^\/work-requests\/(wr_[^/]+)\/files\/(file_[^/]+)$/);
    if (request.method === "PUT" && fileMatch) return uploadWorkRequestFile(request, env, fileMatch[1]!, fileMatch[2]!);

    const completeMatch = url.pathname.match(/^\/work-requests\/(wr_[^/]+)\/complete$/);
    if (request.method === "POST" && completeMatch) return completeWorkRequest(request, env, completeMatch[1]!);

    const processingStatusMatch = url.pathname.match(/^\/work-requests\/(wr_[^/]+)\/status$/);
    if (request.method === "GET" && processingStatusMatch) {
      return getWorkRequestProcessingStatus(request, env, processingStatusMatch[1]!);
    }

    return env.ASSETS.fetch(request);
  },
};
