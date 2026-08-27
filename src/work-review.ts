import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { REVIEW_CSS, REVIEW_JS, reviewHtml } from "./work-review-ui";

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

type ReviewRecord = {
  state: "started" | "approved" | "rejected";
  reviewId: string;
  reviewerEmail: string;
  note: string;
  at: string;
};

type WorkflowRecord = Record<string, unknown> & {
  instanceId?: string;
  dispatchState?: string;
  phase?: string;
  progress?: number;
  headline?: string;
  summary?: string;
  events?: Array<Record<string, unknown>>;
  outcome?: Record<string, unknown>;
};

type WorkRequestManifest = {
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
  workflow?: WorkflowRecord;
};

type WorkflowBinding = {
  create(options?: { id?: string; params?: unknown }): Promise<{ id: string }>;
};

type ReviewEnv = {
  WORK_REQUESTS: R2Bucket;
  WORK_REQUEST_PROCESSOR: WorkflowBinding;
  TMG_REVIEW_ALLOWED_EMAIL_DOMAINS?: string;
};

type AccessIdentity = { email?: string; name?: string; id?: string };
type AccessContext = ExecutionContext & {
  access?: {
    aud?: string;
    getIdentity(): Promise<AccessIdentity | null>;
  };
};

type Operator = { email: string; name: string | null; audience: string | null };
type DispatchPayload = { requestId: string; reviewId: string; reviewerEmail: string };

const VALID_STATUSES = new Set<WorkRequestStatus>([
  "draft_uploading", "received_unreviewed", "reviewing", "approved_for_processing", "processing",
  "action_required", "completed", "rejected", "withdrawn", "failed",
]);

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

function text(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function manifestKey(requestId: string): string {
  return `requests/${requestId}/manifest.json`;
}

function validRequestId(value: string): boolean {
  return /^wr_[0-9]{8}_[0-9a-f-]{36}$/i.test(value);
}

function validFileId(value: string): boolean {
  return /^file_[0-9a-f-]{36}$/i.test(value);
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, max) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function allowedEmailDomains(env: ReviewEnv): string[] {
  return String(env.TMG_REVIEW_ALLOWED_EMAIL_DOMAINS ?? "")
    .split(/[,;\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

async function requireOperator(ctx: AccessContext, env: ReviewEnv): Promise<Operator | null> {
  if (!ctx.access) return null;
  const identity = await ctx.access.getIdentity().catch(() => null);
  const email = identity?.email?.trim().toLowerCase();
  if (!email) return null;
  const domains = allowedEmailDomains(env);
  if (domains.length && !domains.includes(email.split("@").pop() ?? "")) return null;
  return {
    email,
    name: identity?.name?.trim() || null,
    audience: typeof ctx.access.aud === "string" ? ctx.access.aud : null,
  };
}

function sameOriginMutation(request: Request): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return true;
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin && origin !== url.origin) return false;
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return false;
  return true;
}

async function loadManifest(env: ReviewEnv, requestId: string): Promise<WorkRequestManifest | null> {
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

async function writeManifest(env: ReviewEnv, manifest: WorkRequestManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await env.WORK_REQUESTS.put(manifestKey(manifest.requestId), JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "no-store" },
    customMetadata: { schema: manifest.schema, requestId: manifest.requestId, status: manifest.status },
  });
}

function workflowOf(manifest: WorkRequestManifest): WorkflowRecord {
  const workflow = manifest.workflow ?? {};
  manifest.workflow = workflow;
  if (!Array.isArray(workflow.events)) workflow.events = [];
  return workflow;
}

function appendEvent(
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

function internalManifestView(manifest: WorkRequestManifest): Record<string, unknown> {
  return {
    schema: "tmg.work-review-detail.v1",
    requestId: manifest.requestId,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    completedAt: manifest.completedAt ?? null,
    requester: manifest.requester,
    request: manifest.request,
    rights: manifest.rights,
    controls: manifest.controls,
    files: manifest.files.map(({ fileId, name, size, type, sha256, status, uploadedAt }) => ({
      fileId, name, size, type, sha256, status, uploadedAt: uploadedAt ?? null,
    })),
    review: manifest.review ?? null,
    workflow: manifest.workflow ?? null,
  };
}

async function listQueue(env: ReviewEnv, operator: Operator): Promise<Response> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const listed = await env.WORK_REQUESTS.list({ prefix: "requests/", limit: 200, ...(cursor ? { cursor } : {}) });
    for (const object of listed.objects) if (object.key.endsWith("/manifest.json")) keys.push(object.key);
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }

  const manifests = (await Promise.all(keys.slice(-500).map(async (key) => {
    const object = await env.WORK_REQUESTS.get(key);
    if (!object) return null;
    try {
      const manifest = JSON.parse(await object.text()) as WorkRequestManifest;
      return manifest.schema === "tmg.work-request.v1" && VALID_STATUSES.has(manifest.status) ? manifest : null;
    } catch {
      return null;
    }
  }))).filter((item): item is WorkRequestManifest => item !== null);

  manifests.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return json({
    schema: "tmg.work-review-queue.v1",
    operator,
    requests: manifests.slice(0, 100).map((manifest) => ({
      requestId: manifest.requestId,
      status: manifest.status,
      title: manifest.request.title,
      serviceType: manifest.request.serviceType,
      requester: {
        name: manifest.requester.name,
        email: manifest.requester.email,
        organization: manifest.requester.organization,
      },
      controls: manifest.controls,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    })),
  });
}

async function startReview(env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  if (manifest.status !== "received_unreviewed") return json({ error: "invalid_review_transition", status: manifest.status }, 409);
  const at = new Date().toISOString();
  manifest.status = "reviewing";
  manifest.review = {
    state: "started",
    reviewId: `review_${crypto.randomUUID()}`,
    reviewerEmail: operator.email,
    note: "Review opened; no processing authority granted.",
    at,
  };
  appendEvent(manifest, {
    phase: "human_review",
    state: "active",
    title: "Human review started",
    detail: "An authenticated TMG operator opened the rights, scope, and processing-boundary review.",
  });
  await writeManifest(env, manifest);
  return json(internalManifestView(manifest));
}

async function rejectRequest(request: Request, env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  if (!new Set<WorkRequestStatus>(["received_unreviewed", "reviewing"]).has(manifest.status)) {
    return json({ error: "invalid_rejection_transition", status: manifest.status }, 409);
  }
  const body = asRecord(await request.json().catch(() => null));
  const note = bounded(body.note, 1000);
  if (!note || note.length < 10) return json({ error: "review_note_required" }, 400);
  const at = new Date().toISOString();
  const reviewId = manifest.review?.reviewId ?? `review_${crypto.randomUUID()}`;
  manifest.status = "rejected";
  manifest.completedAt = at;
  manifest.controls = { processingAuthorized: false, publicationAuthorized: false, externalProviderEgressAuthorized: false };
  manifest.review = { state: "rejected", reviewId, reviewerEmail: operator.email, note, at };
  const workflow = workflowOf(manifest);
  workflow.phase = "closed";
  workflow.progress = 100;
  workflow.headline = "Request closed during review";
  workflow.summary = "TMG review did not grant authority to enter processing.";
  workflow.outcome = {
    status: "rejected",
    headline: "Request not approved for processing",
    summary: note,
    nextAction: "Contact TMG with revised scope or additional rights evidence before submitting a new request.",
    confidence: "human_reviewed",
    evidence: [],
    deliverables: [],
  };
  appendEvent(manifest, { phase: "human_review", state: "rejected", title: "Processing authority denied", detail: note });
  await writeManifest(env, manifest);
  return json(internalManifestView(manifest));
}

function workflowInstanceId(requestId: string, reviewId: string): string {
  const left = requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 56);
  const right = reviewId.replace(/^review_/, "").replace(/-/g, "").slice(0, 24);
  return `work_${left}_${right}`.slice(0, 100);
}

async function approveAndDispatch(request: Request, env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  if (manifest.status !== "reviewing") return json({ error: "review_must_be_started_before_approval", status: manifest.status }, 409);
  const body = asRecord(await request.json().catch(() => null));
  const note = bounded(body.note, 1000);
  if (!note || note.length < 10) return json({ error: "review_note_required" }, 400);
  if (!manifest.files.every((file) => file.status === "uploaded")) return json({ error: "evidence_upload_incomplete" }, 409);
  if (!manifest.rights.authorizedToShare || !manifest.rights.humanReviewAcknowledged) return json({ error: "rights_attestation_missing" }, 409);

  const at = new Date().toISOString();
  const reviewId = manifest.review?.reviewId ?? `review_${crypto.randomUUID()}`;
  const instanceId = workflowInstanceId(manifest.requestId, reviewId);
  manifest.status = "approved_for_processing";
  manifest.controls = { processingAuthorized: true, publicationAuthorized: false, externalProviderEgressAuthorized: false };
  manifest.review = { state: "approved", reviewId, reviewerEmail: operator.email, note, at };
  const workflow = workflowOf(manifest);
  workflow.instanceId = instanceId;
  workflow.dispatchState = "requested";
  workflow.phase = "authorization";
  workflow.progress = 58;
  workflow.headline = "Processing authority approved";
  workflow.summary = "An authenticated human reviewer approved bounded processing authority. Publication and external-provider egress remain gated.";
  appendEvent(manifest, { phase: "authorization", state: "approved", title: "Processing authority granted", detail: note });
  appendEvent(manifest, { phase: "authorization", state: "dispatch_requested", title: "Governed workflow dispatch requested", detail: `Workflow instance ${instanceId} reserved for this approved review.` });
  await writeManifest(env, manifest);

  try {
    const instance = await env.WORK_REQUEST_PROCESSOR.create({
      id: instanceId,
      params: { requestId: manifest.requestId, reviewId, reviewerEmail: operator.email } satisfies DispatchPayload,
    });
    return json({ ...internalManifestView(manifest), dispatch: { instanceId: instance.id, state: "created" } });
  } catch (error) {
    const latest = await loadManifest(env, requestId);
    if (latest && latest.status === "approved_for_processing") {
      latest.status = "action_required";
      const latestWorkflow = workflowOf(latest);
      latestWorkflow.dispatchState = "failed";
      latestWorkflow.phase = "action_required";
      latestWorkflow.progress = 60;
      latestWorkflow.outcome = {
        status: "action_required",
        headline: "Workflow dispatch needs operator attention",
        summary: "Processing authority was granted, but the durable workflow instance could not be created.",
        nextAction: "Review deployment/workflow availability before retrying. Do not broaden authority to compensate.",
        confidence: "system_recorded",
        evidence: [],
        deliverables: [],
      };
      appendEvent(latest, { phase: "authorization", state: "failed", title: "Workflow dispatch failed", detail: error instanceof Error ? error.message : "unknown workflow create failure" });
      await writeManifest(env, latest);
    }
    return json({ error: "workflow_dispatch_failed" }, 502);
  }
}

async function recordOutcome(request: Request, env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  if (manifest.status !== "action_required") return json({ error: "outcome_requires_action_required_checkpoint", status: manifest.status }, 409);
  const body = asRecord(await request.json().catch(() => null));
  const status = bounded(body.status, 32);
  if (!status || !["completed", "action_required", "failed"].includes(status)) return json({ error: "invalid_outcome_status" }, 400);
  const headline = bounded(body.headline, 180);
  const summary = bounded(body.summary, 1200);
  const nextAction = bounded(body.nextAction, 480);
  const confidence = bounded(body.confidence, 80);
  if (!headline || !summary) return json({ error: "outcome_headline_and_summary_required" }, 400);

  const terminal = status === "completed" || status === "failed";
  manifest.status = status as WorkRequestStatus;
  if (terminal) {
    manifest.completedAt = new Date().toISOString();
    manifest.controls.processingAuthorized = false;
  }
  const workflow = workflowOf(manifest);
  workflow.phase = status === "completed" ? "outcome" : status === "failed" ? "failed" : "action_required";
  workflow.progress = terminal ? 100 : Math.max(Number(workflow.progress ?? 82), 82);
  workflow.headline = headline;
  workflow.summary = summary;
  workflow.outcome = {
    status,
    headline,
    summary,
    nextAction,
    confidence: confidence ?? "human_reviewed",
    evidence: Array.isArray(asRecord(workflow.outcome).evidence) ? asRecord(workflow.outcome).evidence : [],
    deliverables: Array.isArray(asRecord(workflow.outcome).deliverables) ? asRecord(workflow.outcome).deliverables : [],
    recordedBy: operator.email,
    recordedAt: new Date().toISOString(),
  };
  appendEvent(manifest, { phase: String(workflow.phase), state: status, title: terminal ? "Terminal outcome recorded" : "Operator action checkpoint updated", detail: summary });
  await writeManifest(env, manifest);
  return json(internalManifestView(manifest));
}

async function evidenceDownload(env: ReviewEnv, requestId: string, fileId: string): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  const file = manifest.files.find((candidate) => candidate.fileId === fileId && candidate.status === "uploaded");
  if (!file) return json({ error: "not_found" }, 404);
  const object = await env.WORK_REQUESTS.get(file.objectKey);
  if (!object) return json({ error: "not_found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": file.type,
      "content-length": String(object.size),
      "content-disposition": `attachment; filename="${file.name.replace(/["\\\r\n]/g, "_")}"`,
      "cache-control": "private, no-store",
      "content-security-policy": "sandbox; default-src 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function processorRoute(serviceType: string): { processorId: string; state: string; nextAction: string } {
  switch (serviceType) {
    case "video-intelligence":
      return { processorId: "video-intelligence", state: "specialized_processor_g0_gated", nextAction: "Bind an approved canonical media manifest and rights profile before video intelligence execution." };
    case "media-processing":
      return { processorId: "media-processing", state: "specialized_processor_g0_gated", nextAction: "Select and authorize the bounded derivative-processing recipe before execution." };
    case "image-processing":
      return { processorId: "image-processing", state: "specialized_processor_not_bound", nextAction: "Bind the approved image-processing recipe and destination preset before execution." };
    case "rights-provenance":
      return { processorId: "rights-provenance", state: "human_evidence_checkpoint", nextAction: "Complete human verification of the supplied rights evidence and permitted-use scope." };
    case "content-analysis":
      return { processorId: "content-analysis", state: "provider_egress_gated", nextAction: "Select an approved local or governed provider path; external-provider egress remains disabled." };
    default:
      return { processorId: "custom", state: "operator_routing_required", nextAction: "Assign a governed processor and record its authority envelope before execution." };
  }
}

export class WorkRequestProcessingWorkflow extends WorkflowEntrypoint<ReviewEnv, DispatchPayload> {
  async run(event: WorkflowEvent<DispatchPayload>, step: WorkflowStep): Promise<{ requestId: string; status: string; processorId?: string }> {
    const payload = event.payload;
    if (!payload || !validRequestId(payload.requestId) || !payload.reviewId || !payload.reviewerEmail) throw new Error("invalid_work_request_dispatch_payload");

    const serviceType = await step.do("validate approved authority and start processing", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      if (manifest.status !== "approved_for_processing" || manifest.controls.processingAuthorized !== true) throw new Error("processing_authority_not_granted");
      if (manifest.controls.publicationAuthorized || manifest.controls.externalProviderEgressAuthorized) throw new Error("work_request_authority_exceeds_dispatch_envelope");
      if (manifest.review?.state !== "approved" || manifest.review.reviewId !== payload.reviewId) throw new Error("review_authority_mismatch");
      manifest.status = "processing";
      const workflow = workflowOf(manifest);
      workflow.dispatchState = "running";
      workflow.phase = "processing";
      workflow.progress = 65;
      workflow.headline = "Governed processing started";
      workflow.summary = "The durable execution controller is validating the approved evidence inventory and selecting a bounded processor route.";
      appendEvent(manifest, { phase: "processing", state: "active", title: "Durable workflow started", detail: `Execution ${event.instanceId} began under review ${payload.reviewId}.` });
      await writeManifest(this.env, manifest);
      return manifest.request.serviceType;
    });

    const inventory = await step.do("verify quarantined evidence inventory", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      const missing: string[] = [];
      let bytes = 0;
      for (const file of manifest.files) {
        const object = await this.env.WORK_REQUESTS.head(file.objectKey);
        if (!object || object.size !== file.size) missing.push(file.fileId);
        else bytes += object.size;
      }
      return { missing, bytes, files: manifest.files.length };
    });

    if (inventory.missing.length) {
      await step.do("record evidence inventory failure", async () => {
        const manifest = await loadManifest(this.env, payload.requestId);
        if (!manifest) return;
        manifest.status = "failed";
        manifest.completedAt = new Date().toISOString();
        manifest.controls.processingAuthorized = false;
        const workflow = workflowOf(manifest);
        workflow.dispatchState = "failed";
        workflow.phase = "failed";
        workflow.progress = 100;
        workflow.outcome = {
          status: "failed",
          headline: "Evidence inventory failed integrity verification",
          summary: `${inventory.missing.length} approved evidence object(s) were missing or had a size mismatch at execution time.`,
          nextAction: "Reconcile quarantine evidence before any new processing authority is considered.",
          confidence: "system_verified",
          evidence: [{ label: "Missing/mismatched objects", value: String(inventory.missing.length) }],
          deliverables: [],
        };
        appendEvent(manifest, { phase: "processing", state: "failed", title: "Evidence inventory verification failed", detail: `${inventory.missing.length} object(s) did not match the approved manifest.` });
        await writeManifest(this.env, manifest);
      });
      return { requestId: payload.requestId, status: "failed" };
    }

    const route = processorRoute(serviceType);
    await step.do("record processor routing checkpoint", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      manifest.status = "action_required";
      const workflow = workflowOf(manifest);
      workflow.dispatchState = "checkpoint";
      workflow.phase = "action_required";
      workflow.progress = 82;
      workflow.headline = "Authorized evidence intake verified";
      workflow.summary = "TMG verified the approved quarantine evidence and resolved the governed service route. The specialized processor remains separately gated.";
      workflow.processorId = route.processorId;
      workflow.processorState = route.state;
      workflow.outcome = {
        status: "action_required",
        headline: "Evidence verified; processor authorization checkpoint",
        summary: `The durable workflow verified ${inventory.files} file(s) totaling ${inventory.bytes} bytes and routed the request to ${route.processorId}.`,
        nextAction: route.nextAction,
        confidence: "system_verified",
        evidence: [
          { label: "Evidence objects verified", value: String(inventory.files) },
          { label: "Verified bytes", value: String(inventory.bytes) },
          { label: "Processor route", value: route.processorId },
          { label: "Processor state", value: route.state },
        ],
        deliverables: [{ label: "Governed evidence inventory", status: "complete" }],
      };
      appendEvent(manifest, { phase: "processing", state: "verified", title: "Evidence inventory verified", detail: `${inventory.files} approved object(s), ${inventory.bytes} bytes.` });
      appendEvent(manifest, { phase: "action_required", state: "checkpoint", title: "Specialized processor checkpoint reached", detail: route.nextAction });
      await writeManifest(this.env, manifest);
    });

    return { requestId: payload.requestId, status: "action_required", processorId: route.processorId };
  }
}

export default {
  async fetch(request: Request, env: ReviewEnv, rawCtx: ExecutionContext): Promise<Response> {
    const ctx = rawCtx as AccessContext;
    const operator = await requireOperator(ctx, env);
    if (!operator) return json({ error: "cloudflare_access_required", message: "Authenticated TMG operator access is required." }, 401);
    if (!sameOriginMutation(request)) return json({ error: "cross_origin_mutation_denied" }, 403);

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(reviewHtml(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/assets/review.css") return text(REVIEW_CSS, "text/css; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/assets/review.js") return text(REVIEW_JS, "text/javascript; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/api/queue") return listQueue(env, operator);

    const detail = url.pathname.match(/^\/api\/requests\/(wr_[^/]+)$/);
    if (request.method === "GET" && detail) {
      const manifest = await loadManifest(env, detail[1]!);
      return manifest ? json(internalManifestView(manifest)) : json({ error: "not_found" }, 404);
    }

    const download = url.pathname.match(/^\/api\/requests\/(wr_[^/]+)\/files\/(file_[^/]+)$/);
    if (request.method === "GET" && download && validFileId(download[2]!)) return evidenceDownload(env, download[1]!, download[2]!);

    const action = url.pathname.match(/^\/api\/requests\/(wr_[^/]+)\/(review|approve|reject|outcome)$/);
    if (request.method === "POST" && action) {
      const requestId = action[1]!;
      switch (action[2]) {
        case "review": return startReview(env, requestId, operator);
        case "approve": return approveAndDispatch(request, env, requestId, operator);
        case "reject": return rejectRequest(request, env, requestId, operator);
        case "outcome": return recordOutcome(request, env, requestId, operator);
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ schema: "tmg.work-review-health.v1", status: "ok", operator: { email: operator.email }, accessAudience: operator.audience });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<ReviewEnv>;
