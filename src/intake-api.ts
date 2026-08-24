import { AccessRequiredError, requireConsoleActor, type ConsoleActor } from "./access-auth";
import {
  createJobSchema,
  createRequestSchema,
  registerAssetSchema,
  registerRightsEvidenceSchema,
  verifyRightsEvidenceSchema,
} from "./intake-schemas";
import {
  IntakeConflictError,
  IntakeForbiddenError,
  IntakeNotFoundError,
  IntakeStore,
  publicAsset,
  publicRights,
} from "./intake-store";
import { ZodError, type ZodType } from "zod";

const JSON_BODY_LIMIT_BYTES = 64 * 1024;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function isEnabled(value: string | undefined): boolean {
  return value === "true";
}

function requireIntakeEnabled(env: Env): void {
  if (!isEnabled(env.TMG_INTAKE_ENABLED)) {
    throw new IntakeForbiddenError("authenticated intake is disabled at the current product gate");
  }
  if (env.TMG_CONTROL_DB_BINDING_STATE !== "provisioned") {
    throw new IntakeForbiddenError("authenticated intake control database is not provisioned");
  }
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > JSON_BODY_LIMIT_BYTES) {
      await reader.cancel("control-plane JSON body limit exceeded");
      throw new IntakeConflictError("JSON request body exceeds the 64 KiB control-plane limit");
    }
    chunks.push(result.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new IntakeConflictError("content-type must be application/json");
  }
  const rawLength = request.headers.get("content-length");
  if (rawLength) {
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > JSON_BODY_LIMIT_BYTES) {
      throw new IntakeConflictError("JSON request body exceeds the 64 KiB control-plane limit");
    }
  }
  const body = await readBoundedBody(request);
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch (error) {
    if (error instanceof ZodError) throw error;
    throw new IntakeConflictError("request body is not valid JSON");
  }
}

function requireUploadHeaders(
  request: Request,
  expected: { expected_bytes: number; expected_sha256: string; mime_type: string },
): string {
  const rawLength = request.headers.get("content-length");
  if (!rawLength) throw new IntakeConflictError("content-length is required for integrity-bound upload");
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length !== expected.expected_bytes) {
    throw new IntakeConflictError("content-length does not match registered bytes");
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType !== expected.mime_type.toLowerCase()) {
    throw new IntakeConflictError("content-type does not match registered media type");
  }

  const declaredSha = request.headers.get("x-tmg-content-sha256")?.trim().toLowerCase() ?? "";
  if (declaredSha !== expected.expected_sha256.toLowerCase()) {
    throw new IntakeConflictError("x-tmg-content-sha256 does not match registered SHA-256");
  }
  if (!request.body) throw new IntakeConflictError("upload body is required");
  return declaredSha;
}

async function putIntegrityBoundObject(
  bucket: R2Bucket,
  key: string,
  request: Request,
  expected: { expected_bytes: number; expected_sha256: string; mime_type: string },
  metadata: Record<string, string>,
) {
  const declaredSha = requireUploadHeaders(request, expected);
  const stored = await bucket.put(key, request.body, {
    sha256: declaredSha,
    httpMetadata: { contentType: expected.mime_type },
    customMetadata: metadata,
  });
  if (stored.size !== expected.expected_bytes) {
    await bucket.delete(key);
    throw new IntakeConflictError("stored object byte count did not match registered bytes");
  }
  return { version: stored.version, etag: stored.etag };
}

function matches(url: URL, expression: RegExp): RegExpMatchArray | null {
  return url.pathname.match(expression);
}

async function requireActor(ctx: ExecutionContext): Promise<ConsoleActor> {
  return requireConsoleActor(ctx);
}

export async function handleIntakeApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const actor = await requireActor(ctx);

    if (request.method === "GET" && url.pathname === "/v1/console/session") {
      return json({
        authenticated: true,
        actor,
        publicStatusGate: "G0",
        intake: {
          enabled: isEnabled(env.TMG_INTAKE_ENABLED) && env.TMG_CONTROL_DB_BINDING_STATE === "provisioned",
          consoleHost: env.TMG_CONSOLE_HOST,
          rightsFirst: true,
          independentRightsReviewRequired: true,
          processingAuthority: false,
          publicationAuthority: false,
          commercialAuthority: false,
        },
        requestId,
      });
    }

    requireIntakeEnabled(env);
    const store = new IntakeStore(env.CONTROL_DB);
    const now = new Date().toISOString();

    if (request.method === "GET" && url.pathname === "/v1/intake/requests") {
      return json({ requests: await store.listRequestsForOwner(actor.email), requestId });
    }

    if (request.method === "POST" && url.pathname === "/v1/intake/requests") {
      const input = await parseJson(request, createRequestSchema);
      const bundle = await store.createRequest(actor, input, now);
      return json({ ...bundle, requestId }, 201);
    }

    const requestMatch = matches(url, /^\/v1\/intake\/requests\/([^/]+)$/);
    if (request.method === "GET" && requestMatch) {
      const bundle = await store.getRequestBundleForOwner(decodeURIComponent(requestMatch[1]!), actor.email);
      return json({ ...bundle, requestId });
    }

    const assetRegistrationMatch = matches(url, /^\/v1\/intake\/requests\/([^/]+)\/assets$/);
    if (request.method === "POST" && assetRegistrationMatch) {
      const input = await parseJson(request, registerAssetSchema);
      const asset = await store.registerAsset(actor, decodeURIComponent(assetRegistrationMatch[1]!), input, now);
      return json({ asset: publicAsset(asset), requestId }, 201);
    }

    const rightsRegistrationMatch = matches(url, /^\/v1\/intake\/assets\/([^/]+)\/rights$/);
    if (request.method === "POST" && rightsRegistrationMatch) {
      const input = await parseJson(request, registerRightsEvidenceSchema);
      const evidence = await store.registerRightsEvidence(actor, decodeURIComponent(rightsRegistrationMatch[1]!), input, now);
      return json({ rightsEvidence: publicRights(evidence), requestId }, 201);
    }

    const rightsUploadMatch = matches(url, /^\/v1\/intake\/rights\/([^/]+)\/evidence$/);
    if (request.method === "PUT" && rightsUploadMatch) {
      const evidenceId = decodeURIComponent(rightsUploadMatch[1]!);
      const evidence = await store.requireRightsEvidenceOwner(evidenceId, actor.email);
      if (evidence.upload_state !== "metadata_registered") {
        throw new IntakeConflictError("rights evidence upload already finalized");
      }
      const stored = await putIntegrityBoundObject(
        env.MEDIA_BUCKET,
        evidence.evidence_object_key,
        request,
        evidence,
        {
          classification: "tmg-rights-evidence",
          evidenceId,
          requestId: evidence.request_id,
          assetId: evidence.asset_id,
          publicStatusGate: "G0",
        },
      );
      const updated = await store.markRightsEvidenceUploaded(evidenceId, actor, stored.version, stored.etag, now);
      return json({ rightsEvidence: publicRights(updated), requestId }, 201);
    }

    const rightsReviewMatch = matches(url, /^\/v1\/intake\/rights\/([^/]+)\/review$/);
    if (request.method === "POST" && rightsReviewMatch) {
      const input = await parseJson(request, verifyRightsEvidenceSchema);
      const evidenceId = decodeURIComponent(rightsReviewMatch[1]!);
      const registeredEvidence = await store.getRightsEvidence(evidenceId);
      if (input.decision === "verify" && registeredEvidence.grants_internal_processing !== 1) {
        throw new IntakeConflictError("rights evidence does not claim internal processing authority and cannot satisfy the v1 processing-rights gate");
      }
      const evidence = await store.reviewRightsEvidence(
        evidenceId,
        actor,
        input.decision,
        input.rationale,
        now,
      );
      return json({ rightsEvidence: publicRights(evidence), requestId });
    }

    const assetUploadMatch = matches(url, /^\/v1\/intake\/assets\/([^/]+)\/quarantine$/);
    if (request.method === "PUT" && assetUploadMatch) {
      const assetId = decodeURIComponent(assetUploadMatch[1]!);
      const asset = await store.getAssetForOwner(assetId, actor.email);
      if (asset.rights_state !== "verified") {
        throw new IntakeForbiddenError("rights must be independently verified before source bytes can enter quarantine");
      }
      if (asset.upload_state !== "metadata_registered") {
        throw new IntakeConflictError("asset upload already finalized");
      }
      const stored = await putIntegrityBoundObject(
        env.MEDIA_BUCKET,
        asset.quarantine_object_key,
        request,
        asset,
        {
          classification: "tmg-private-quarantine-source",
          assetId,
          requestId: asset.request_id,
          rightsState: "verified",
          processable: "false",
          publicStatusGate: "G0",
        },
      );
      const updated = await store.markAssetUploaded(assetId, actor, stored.version, stored.etag, now);
      return json({ asset: publicAsset(updated), processingAuthority: false, requestId }, 201);
    }

    const createJobMatch = matches(url, /^\/v1\/intake\/requests\/([^/]+)\/jobs$/);
    if (request.method === "POST" && createJobMatch) {
      await parseJson(request, createJobSchema);
      const job = await store.createBlockedJob(actor, decodeURIComponent(createJobMatch[1]!), now);
      return json({ job, workflowDispatched: false, processingAuthority: false, requestId }, 201);
    }

    if (request.method === "GET" && url.pathname === "/v1/intake/jobs") {
      return json({ jobs: await store.listJobsForOwner(actor.email), requestId });
    }

    return json({ error: "not_found", requestId }, 404);
  } catch (error) {
    if (error instanceof AccessRequiredError) {
      return json({ error: "access_required", message: error.message, requestId }, 403);
    }
    if (error instanceof ZodError) {
      return json({ error: "invalid_request", issues: error.issues, requestId }, 400);
    }
    if (error instanceof IntakeNotFoundError) {
      return json({ error: "not_found", message: error.message, requestId }, 404);
    }
    if (error instanceof IntakeConflictError) {
      return json({ error: "conflict", message: error.message, requestId }, 409);
    }
    if (error instanceof IntakeForbiddenError) {
      const disabled = error.message.includes("disabled") || error.message.includes("not provisioned");
      return json({ error: disabled ? "intake_disabled" : "forbidden", message: error.message, requestId }, disabled ? 503 : 403);
    }

    console.error(JSON.stringify({
      level: "error",
      event: "intake_api_failed",
      requestId,
      message: error instanceof Error ? error.message : "unknown_error",
    }));
    return json({ error: "internal_error", requestId }, 500);
  }
}
