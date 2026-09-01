import { REVIEW_CSS, REVIEW_JS, reviewHtml } from "./work-review-ui";
import {
  VALID_STATUSES,
  appendEvent,
  asRecord,
  bounded,
  loadManifest,
  processorRoute,
  validFileId,
  workflowOf,
  writeManifest,
  type DispatchPayload,
  type ProcessorAuthorizationEvent,
  type ReviewEnv,
  type WorkRequestManifest,
  type WorkRequestStatus,
} from "./work-review-core";
import { buildProcessorAuthorityEnvelope } from "./processor-authority";
import {
  authorizeDerivativeRecipe,
  authorizeTechnicalInspection,
  recordRightsSufficiencyVerdict,
  startProcessorChain,
} from "./processor-chain-review-actions";

type AccessIdentity = { email?: string; name?: string; id?: string };
type AccessContext = ExecutionContext & {
  access?: {
    aud?: string;
    getIdentity(): Promise<AccessIdentity | null>;
  };
};
type Operator = { email: string; name: string | null; audience: string | null };

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
      fileId,
      name,
      size,
      type,
      sha256,
      status,
      uploadedAt: uploadedAt ?? null,
    })),
    review: manifest.review ?? null,
    processorAuthorizations: manifest.processorAuthorizations ?? {},
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
  if (manifest.status !== "received_unreviewed") {
    return json({ error: "invalid_review_transition", status: manifest.status }, 409);
  }
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
  if (manifest.status !== "reviewing") {
    return json({ error: "review_must_be_started_before_approval", status: manifest.status }, 409);
  }
  const body = asRecord(await request.json().catch(() => null));
  const note = bounded(body.note, 1000);
  if (!note || note.length < 10) return json({ error: "review_note_required" }, 400);
  if (!manifest.files.every((file) => file.status === "uploaded")) return json({ error: "evidence_upload_incomplete" }, 409);
  if (!manifest.rights.authorizedToShare || !manifest.rights.humanReviewAcknowledged) {
    return json({ error: "rights_attestation_missing" }, 409);
  }

  const at = new Date().toISOString();
  const reviewId = manifest.review?.reviewId ?? `review_${crypto.randomUUID()}`;
  const instanceId = workflowInstanceId(manifest.requestId, reviewId);
  manifest.status = "approved_for_processing";
  manifest.controls = { processingAuthorized: true, publicationAuthorized: false, externalProviderEgressAuthorized: false };
  manifest.review = { state: "approved", reviewId, reviewerEmail: operator.email, note, at };
  manifest.processorAuthorizations = {};
  const workflow = workflowOf(manifest);
  workflow.instanceId = instanceId;
  workflow.dispatchState = "requested";
  workflow.phase = "authorization";
  workflow.progress = 58;
  workflow.headline = "Processing authority approved";
  workflow.summary = "An authenticated human reviewer approved bounded request processing. Processor-specific authority, publication, and external-provider egress remain separately gated.";
  appendEvent(manifest, { phase: "authorization", state: "approved", title: "Request processing authority granted", detail: note });
  appendEvent(manifest, {
    phase: "authorization",
    state: "dispatch_requested",
    title: "Governed workflow dispatch requested",
    detail: `Workflow instance ${instanceId} reserved for this approved review. No specialized processor authority has been granted.`,
  });
  await writeManifest(env, manifest);

  try {
    const dispatch: DispatchPayload = { requestId: manifest.requestId, reviewId, reviewerEmail: operator.email };
    const instance = await env.WORK_REQUEST_PROCESSOR.create({ id: instanceId, params: dispatch });
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
      appendEvent(latest, {
        phase: "authorization",
        state: "failed",
        title: "Workflow dispatch failed",
        detail: error instanceof Error ? error.message : "unknown workflow create failure",
      });
      await writeManifest(env, latest);
    }
    return json({ error: "workflow_dispatch_failed" }, 502);
  }
}

async function authorizeProcessor(request: Request, env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  if (manifest.status !== "action_required" || manifest.controls.processingAuthorized !== true) {
    return json({ error: "processor_authority_requires_active_checkpoint", status: manifest.status }, 409);
  }
  if (manifest.controls.publicationAuthorized || manifest.controls.externalProviderEgressAuthorized) {
    return json({ error: "processor_authority_exceeds_local_envelope" }, 409);
  }
  if (manifest.review?.state !== "approved") return json({ error: "approved_human_review_required" }, 409);

  const route = processorRoute(manifest.request.serviceType);
  if (!route.authorizable || !route.localOnly || !route.adapter) {
    return json({ error: "processor_not_locally_authorizable", processorId: route.processorId, processorState: route.state }, 409);
  }
  const workflow = workflowOf(manifest);
  if (!workflow.instanceId || workflow.processorId !== route.processorId || workflow.dispatchState !== "waiting_for_processor_authority") {
    return json({ error: "workflow_not_waiting_for_processor_authority", processorId: route.processorId }, 409);
  }
  if (workflow.processorAuthorizationState !== "required") {
    return json({ error: "processor_authority_not_required", state: workflow.processorAuthorizationState ?? "unknown" }, 409);
  }

  const body = asRecord(await request.json().catch(() => null));
  const note = bounded(body.note, 1000);
  if (!note || note.length < 10) return json({ error: "processor_authority_note_required" }, 400);
  const requestedProcessorId = bounded(body.processorId, 80);
  if (requestedProcessorId !== route.processorId) {
    return json({ error: "processor_authority_route_mismatch", expectedProcessorId: route.processorId }, 400);
  }

  const authority = buildProcessorAuthorityEnvelope(manifest, route, operator.email, note);
  manifest.processorAuthorizations = { ...(manifest.processorAuthorizations ?? {}), [route.processorId]: authority };
  workflow.processorAuthorizationState = "authorized_event_pending";
  workflow.processorState = "processor_authorized_waiting_for_workflow";
  appendEvent(manifest, {
    phase: "authorization",
    state: "authorized",
    title: `${route.processorId} authority granted`,
    detail: `Authority ${authority.authorityId} is local-only, bound to ${authority.evidenceBindings.length} evidence object(s), and expires at ${authority.expiresAt}.`,
  });
  await writeManifest(env, manifest);

  const eventPayload: ProcessorAuthorizationEvent = {
    authorityId: authority.authorityId,
    processorId: authority.processorId,
    reviewId: authority.reviewId,
  };

  try {
    const instance = await env.WORK_REQUEST_PROCESSOR.get(authority.workflowInstanceId);
    await instance.sendEvent({ type: "processor-authorized", payload: eventPayload });
  } catch (error) {
    const latest = await loadManifest(env, requestId);
    if (latest) {
      const storedAuthority = latest.processorAuthorizations?.[route.processorId];
      if (storedAuthority?.authorityId === authority.authorityId && storedAuthority.state === "authorized") storedAuthority.state = "revoked";
      const latestWorkflow = workflowOf(latest);
      latestWorkflow.processorAuthorizationState = "event_dispatch_failed";
      latestWorkflow.processorState = "processor_authority_event_failed";
      appendEvent(latest, {
        phase: "authorization",
        state: "failed",
        title: "Processor authority event failed",
        detail: error instanceof Error ? error.message : "unknown workflow event failure",
      });
      await writeManifest(env, latest);
    }
    return json({ error: "processor_authority_event_failed" }, 502);
  }

  return json({
    ...internalManifestView(manifest),
    processorDispatch: {
      processorId: route.processorId,
      authorityId: authority.authorityId,
      workflowInstanceId: authority.workflowInstanceId,
      eventType: "processor-authorized",
      state: "sent",
    },
  });
}

async function recordOutcome(request: Request, env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  if (manifest.status !== "action_required") {
    return json({ error: "outcome_requires_action_required_checkpoint", status: manifest.status }, 409);
  }

  const route = processorRoute(manifest.request.serviceType);
  if (route.authorizable) {
    const result = asRecord(workflowOf(manifest).processorResults?.[route.processorId]);
    if (result.schema !== "tmg.processor-result.v1") {
      return json({ error: "processor_execution_required_before_outcome", processorId: route.processorId }, 409);
    }
  }

  const body = asRecord(await request.json().catch(() => null));
  const status = bounded(body.status, 32);
  if (!status || !["completed", "action_required", "failed"].includes(status)) {
    return json({ error: "invalid_outcome_status" }, 400);
  }
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
  const existingOutcome = asRecord(workflow.outcome);
  workflow.outcome = {
    status,
    headline,
    summary,
    nextAction,
    confidence: confidence ?? "human_reviewed",
    evidence: Array.isArray(existingOutcome.evidence) ? existingOutcome.evidence : [],
    deliverables: Array.isArray(existingOutcome.deliverables) ? existingOutcome.deliverables : [],
    recordedBy: operator.email,
    recordedAt: new Date().toISOString(),
  };
  appendEvent(manifest, {
    phase: String(workflow.phase),
    state: status,
    title: terminal ? "Terminal outcome recorded" : "Operator action checkpoint updated",
    detail: summary,
  });
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

const reviewWorker = {
  async fetch(request: Request, env: ReviewEnv, rawCtx: ExecutionContext): Promise<Response> {
    const ctx = rawCtx as AccessContext;
    const operator = await requireOperator(ctx, env);
    if (!operator) {
      return json({ error: "cloudflare_access_required", message: "Authenticated TMG operator access is required." }, 401);
    }
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
    if (request.method === "GET" && download && validFileId(download[2]!)) {
      return evidenceDownload(env, download[1]!, download[2]!);
    }

    const action = url.pathname.match(/^\/api\/requests\/(wr_[^/]+)\/(review|approve|reject|authorize-processor|chain-start|technical-authorize|rights-verdict|derivative-authorize|outcome)$/);
    if (request.method === "POST" && action) {
      const requestId = action[1]!;
      switch (action[2]) {
        case "review": return startReview(env, requestId, operator);
        case "approve": return approveAndDispatch(request, env, requestId, operator);
        case "reject": return rejectRequest(request, env, requestId, operator);
        case "authorize-processor": return authorizeProcessor(request, env, requestId, operator);
        case "chain-start": return startProcessorChain(env, requestId, operator);
        case "technical-authorize": return authorizeTechnicalInspection(request, env, requestId, operator);
        case "rights-verdict": return recordRightsSufficiencyVerdict(request, env, requestId, operator);
        case "derivative-authorize": return authorizeDerivativeRecipe(request, env, requestId, operator);
        case "outcome": return recordOutcome(request, env, requestId, operator);
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        schema: "tmg.work-review-health.v1",
        status: "ok",
        operator: { email: operator.email },
        accessAudience: operator.audience,
        processorChain: "v1.1",
        publicationExecutionEnabled: env.TMG_PUBLICATION_EXECUTION_ENABLED === "true",
        externalProviderEgressEnabled: env.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED === "true",
      });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<ReviewEnv>;

export default reviewWorker;
