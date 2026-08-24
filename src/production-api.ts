import {
  checklistReferenceSchema,
  checklistTemplate,
  normalizeChecklistReferenceValue,
  productionInputObjectKey,
  productionRequestCreateSchema,
  uploadCompleteSchema,
  uploadStartSchema,
  type ChecklistItemKind,
  type ProductionRequestSnapshot,
} from "./production-request";

const RECOMMENDED_PART_SIZE_BYTES = 16 * 1024 * 1024;

type ProductionRequestsBinding = NonNullable<Env["PRODUCTION_REQUESTS"]>;
type ProductionWorkflowBinding = NonNullable<Env["PRODUCTION_WORKFLOW"]>;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function requireProductionRequests(env: Env): ProductionRequestsBinding {
  if (!env.PRODUCTION_REQUESTS) {
    throw new Error("production request coordinator binding is not configured in this environment");
  }
  return env.PRODUCTION_REQUESTS;
}

function requireProductionWorkflow(env: Env): ProductionWorkflowBinding {
  if (!env.PRODUCTION_WORKFLOW) {
    throw new Error("production workflow binding is not configured in this environment");
  }
  return env.PRODUCTION_WORKFLOW;
}

function requestPath(pathname: string):
  | { kind: "collection" }
  | { kind: "template" }
  | { kind: "request"; requestId: string }
  | { kind: "submit"; requestId: string }
  | { kind: "reference"; requestId: string; itemId: string }
  | { kind: "upload"; requestId: string; itemId: string }
  | null {
  if (pathname === "/v1/production/checklist-template") return { kind: "template" };
  if (pathname === "/v1/production/requests") return { kind: "collection" };
  const requestMatch = pathname.match(/^\/v1\/production\/requests\/([A-Za-z0-9-]+)$/);
  if (requestMatch?.[1]) return { kind: "request", requestId: requestMatch[1] };
  const submitMatch = pathname.match(/^\/v1\/production\/requests\/([A-Za-z0-9-]+)\/submit$/);
  if (submitMatch?.[1]) return { kind: "submit", requestId: submitMatch[1] };
  const itemMatch = pathname.match(
    /^\/v1\/production\/requests\/([A-Za-z0-9-]+)\/items\/([a-z_]+)\/(reference|upload)$/,
  );
  if (!itemMatch?.[1] || !itemMatch[2] || !itemMatch[3]) return null;
  return itemMatch[3] === "reference"
    ? { kind: "reference", requestId: itemMatch[1], itemId: itemMatch[2] }
    : { kind: "upload", requestId: itemMatch[1], itemId: itemMatch[2] };
}

function errorResponse(error: unknown, requestId: string): Response {
  const message = error instanceof Error ? error.message : "unknown_error";
  const clientError = /invalid|required|incomplete|not found|does not|mismatch|immutable|conflict|rejected|submit-ready|distribution|authorization|HTTPS/i.test(message);
  console.error(JSON.stringify({
    level: clientError ? "warn" : "error",
    event: "production_request_api_error",
    requestId,
    message,
  }));
  return json(
    {
      error: clientError ? "production_request_rejected" : "internal_error",
      message: clientError ? message : undefined,
      requestId,
    },
    clientError ? 400 : 500,
  );
}

function allowedMimeType(kind: ChecklistItemKind, mimeType: string): boolean {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const media = normalized.startsWith("video/") || normalized.startsWith("audio/") || normalized.startsWith("image/");
  const textOrDocument = [
    "application/pdf",
    "application/json",
    "application/yaml",
    "application/x-yaml",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
    "text/yaml",
  ].includes(normalized);
  switch (kind) {
    case "source_media":
      return media;
    case "reference_media":
      return media || normalized === "application/pdf";
    case "rights_evidence":
      return normalized.startsWith("image/") || textOrDocument;
    case "project_brief":
    case "delivery_preferences":
      return textOrDocument;
    case "brand_assets":
      return normalized.startsWith("image/") || textOrDocument || normalized === "application/zip";
    case "distribution_targets":
      return false;
  }
}

async function loadRequest(env: Env, productionRequestId: string): Promise<ProductionRequestSnapshot> {
  const coordinator = requireProductionRequests(env).getByName(productionRequestId);
  return coordinator.getSnapshot();
}

async function createProductionRequest(request: Request, env: Env, traceId: string): Promise<Response> {
  const parsed = productionRequestCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "invalid_request", issues: parsed.error.issues, requestId: traceId }, 400);
  }
  const productionRequestId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const coordinator = requireProductionRequests(env).getByName(productionRequestId);
  const snapshot = await coordinator.initialize({
    requestId: productionRequestId,
    tenantId: parsed.data.tenantId,
    title: parsed.data.title,
    ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
    deliverables: parsed.data.deliverables,
    createdAt,
  });
  return json({ productionRequest: snapshot, requestId: traceId }, 201);
}

async function startMultipartUpload(
  request: Request,
  env: Env,
  productionRequestId: string,
  itemId: string,
  traceId: string,
): Promise<Response> {
  const parsed = uploadStartSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "invalid_request", issues: parsed.error.issues, requestId: traceId }, 400);
  }
  const snapshot = await loadRequest(env, productionRequestId);
  const item = snapshot.checklist.find((candidate) => candidate.itemId === itemId);
  if (!item) return json({ error: "checklist_item_not_found", requestId: traceId }, 404);
  if (!item.acceptsUploads) return json({ error: "checklist_item_does_not_accept_uploads", requestId: traceId }, 400);
  if (!allowedMimeType(item.kind, parsed.data.mimeType)) {
    return json({ error: "unsupported_checklist_mime_type", itemKind: item.kind, requestId: traceId }, 415);
  }

  const artifactId = crypto.randomUUID();
  const objectKey = productionInputObjectKey({
    tenantId: snapshot.tenantId,
    requestId: productionRequestId,
    itemId,
    artifactId,
    fileName: parsed.data.fileName,
  });
  const upload = await env.MEDIA_BUCKET.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: parsed.data.mimeType },
    customMetadata: {
      tenantId: snapshot.tenantId,
      productionRequestId,
      checklistItemId: itemId,
      artifactId,
    },
  });
  const coordinator = requireProductionRequests(env).getByName(productionRequestId);
  try {
    const authorization = await coordinator.registerUploadSession({
      itemId,
      uploadId: upload.uploadId,
      objectKey,
      artifactId,
      fileName: parsed.data.fileName,
      mimeType: parsed.data.mimeType,
      ...(parsed.data.declaredBytes ? { declaredBytes: parsed.data.declaredBytes } : {}),
      createdAt: new Date().toISOString(),
    });
    if (!authorization.allowed) {
      await upload.abort();
      return json({ error: "upload_rejected", reasons: authorization.reasons, requestId: traceId }, 409);
    }
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }

  return json({
    upload: {
      uploadId: upload.uploadId,
      artifactId,
      itemId,
      recommendedPartSizeBytes: RECOMMENDED_PART_SIZE_BYTES,
      minimumPartSizeBytes: 5 * 1024 * 1024,
      maximumParts: 10_000,
    },
    requestId: traceId,
  }, 201);
}

async function uploadMultipartPart(
  request: Request,
  env: Env,
  productionRequestId: string,
  itemId: string,
  url: URL,
  traceId: string,
): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId")?.trim();
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !request.body) {
    return json({ error: "invalid_upload_part", requestId: traceId }, 400);
  }
  const coordinator = requireProductionRequests(env).getByName(productionRequestId);
  const authorization = await coordinator.authorizeUpload(itemId, uploadId);
  if (!authorization.allowed || !authorization.session) {
    return json({ error: "upload_rejected", reasons: authorization.reasons, requestId: traceId }, 409);
  }
  const upload = env.MEDIA_BUCKET.resumeMultipartUpload(authorization.session.objectKey, uploadId);
  const part = await upload.uploadPart(partNumber, request.body);
  return json({ part, requestId: traceId });
}

async function completeMultipartUpload(
  request: Request,
  env: Env,
  productionRequestId: string,
  itemId: string,
  traceId: string,
): Promise<Response> {
  const parsed = uploadCompleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "invalid_request", issues: parsed.error.issues, requestId: traceId }, 400);
  }
  const coordinator = requireProductionRequests(env).getByName(productionRequestId);
  const authorization = await coordinator.authorizeUpload(itemId, parsed.data.uploadId);
  if (!authorization.allowed || !authorization.session) {
    return json({ error: "upload_rejected", reasons: authorization.reasons, requestId: traceId }, 409);
  }
  const session = authorization.session;
  let object = await env.MEDIA_BUCKET.head(session.objectKey);
  if (!object) {
    const upload = env.MEDIA_BUCKET.resumeMultipartUpload(session.objectKey, parsed.data.uploadId);
    object = await upload.complete(parsed.data.parts);
  }
  const snapshot = await coordinator.completeUpload({
    itemId,
    uploadId: parsed.data.uploadId,
    artifactId: session.artifactId,
    objectKey: session.objectKey,
    fileName: session.fileName,
    mimeType: session.mimeType,
    bytes: object.size,
    etag: object.httpEtag,
    completedAt: new Date().toISOString(),
  });
  return json({ productionRequest: snapshot, requestId: traceId });
}

async function abortMultipartUpload(
  env: Env,
  productionRequestId: string,
  itemId: string,
  url: URL,
  traceId: string,
): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId")?.trim();
  if (!uploadId) return json({ error: "upload_id_required", requestId: traceId }, 400);
  const coordinator = requireProductionRequests(env).getByName(productionRequestId);
  const authorization = await coordinator.authorizeUpload(itemId, uploadId);
  if (!authorization.allowed || !authorization.session) {
    return json({ error: "upload_rejected", reasons: authorization.reasons, requestId: traceId }, 409);
  }
  const upload = env.MEDIA_BUCKET.resumeMultipartUpload(authorization.session.objectKey, uploadId);
  await upload.abort().catch(() => undefined);
  const snapshot = await coordinator.abortUpload(itemId, uploadId, new Date().toISOString());
  return json({ productionRequest: snapshot, requestId: traceId });
}

async function submitProductionRequest(
  env: Env,
  productionRequestId: string,
  traceId: string,
): Promise<Response> {
  const requests = requireProductionRequests(env);
  const workflow = requireProductionWorkflow(env);
  const coordinator = requests.getByName(productionRequestId);
  const submittedAt = new Date().toISOString();
  const submission = await coordinator.submit(submittedAt);
  const workflowInstanceId = `production-${productionRequestId}`;
  let workflowCreated = false;
  try {
    await workflow.create({
      id: workflowInstanceId,
      params: submission.plan,
    });
    workflowCreated = true;
  } catch (error) {
    try {
      const existing = await workflow.get(workflowInstanceId);
      await existing.status();
      workflowCreated = true;
    } catch {
      throw error;
    }
  }
  if (!workflowCreated) throw new Error("production workflow was not created");
  const snapshot = await coordinator.bindWorkflowInstance(workflowInstanceId, new Date().toISOString());
  return json({
    productionRequest: snapshot,
    productionPlan: submission.plan,
    workflowInstanceId,
    requestId: traceId,
  }, 202);
}

export async function handleProductionApi(
  request: Request,
  env: Env,
  traceId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const path = requestPath(url.pathname);
  if (!path) return json({ error: "not_found", requestId: traceId }, 404);

  try {
    if (path.kind === "template" && request.method === "GET") {
      return json({
        schemaVersion: "tmg.production-checklist.v1",
        checklist: checklistTemplate(),
        requestId: traceId,
      });
    }
    if (path.kind === "collection" && request.method === "POST") {
      return await createProductionRequest(request, env, traceId);
    }
    if (path.kind === "request" && request.method === "GET") {
      const snapshot = await loadRequest(env, path.requestId);
      return json({ productionRequest: snapshot, requestId: traceId });
    }
    if (path.kind === "reference" && request.method === "POST") {
      const parsed = checklistReferenceSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return json({ error: "invalid_request", issues: parsed.error.issues, requestId: traceId }, 400);
      }
      const requestSnapshot = await loadRequest(env, path.requestId);
      const item = requestSnapshot.checklist.find((candidate) => candidate.itemId === path.itemId);
      if (!item) return json({ error: "checklist_item_not_found", requestId: traceId }, 404);
      const normalizedValue = normalizeChecklistReferenceValue(item.kind, parsed.data.value);
      const coordinator = requireProductionRequests(env).getByName(path.requestId);
      const snapshot = await coordinator.setReference(path.itemId, normalizedValue, new Date().toISOString());
      return json({ productionRequest: snapshot, requestId: traceId });
    }
    if (path.kind === "upload") {
      if (request.method === "POST" && url.searchParams.get("action") === "create") {
        return await startMultipartUpload(request, env, path.requestId, path.itemId, traceId);
      }
      if (request.method === "PUT" && url.searchParams.get("action") === "part") {
        return await uploadMultipartPart(request, env, path.requestId, path.itemId, url, traceId);
      }
      if (request.method === "POST" && url.searchParams.get("action") === "complete") {
        return await completeMultipartUpload(request, env, path.requestId, path.itemId, traceId);
      }
      if (request.method === "DELETE" && url.searchParams.get("action") === "abort") {
        return await abortMultipartUpload(env, path.requestId, path.itemId, url, traceId);
      }
      return json({ error: "invalid_upload_action", requestId: traceId }, 400);
    }
    if (path.kind === "submit" && request.method === "POST") {
      return await submitProductionRequest(env, path.requestId, traceId);
    }
    return json({ error: "method_not_allowed", requestId: traceId }, 405);
  } catch (error) {
    return errorResponse(error, traceId);
  }
}
