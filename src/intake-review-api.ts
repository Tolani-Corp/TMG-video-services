import { AccessRequiredError, requireConsoleActor } from "./access-auth";
import { type RightsEvidenceRow, publicRights } from "./intake-store";

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

function enabled(value: string | undefined): boolean {
  return value === "true";
}

function provisioned(value: string | undefined): boolean {
  return String(value || "") === "provisioned";
}

function safeDownloadName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "rights-evidence";
}

export async function handleIntakeReviewApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/v1/intake/rights/review-queue" &&
    !/^\/v1\/intake\/rights\/[^/]+\/evidence-file$/.test(url.pathname)
  ) {
    return null;
  }

  try {
    const actor = await requireConsoleActor(ctx);
    if (!enabled(env.TMG_INTAKE_ENABLED) || !provisioned(env.TMG_CONTROL_DB_BINDING_STATE)) {
      return json({ error: "intake_disabled", requestId }, 503);
    }

    if (request.method === "GET" && url.pathname === "/v1/intake/rights/review-queue") {
      const result = await env.CONTROL_DB.prepare(`
        SELECT * FROM tmg_rights_evidence
        WHERE upload_state='integrity_verified'
          AND review_state='pending'
          AND submitted_by <> ?1
        ORDER BY submitted_at ASC
        LIMIT 100
      `).bind(actor.email).all<RightsEvidenceRow>();
      return json({ rightsEvidence: result.results.map(publicRights), requestId });
    }

    const match = url.pathname.match(/^\/v1\/intake\/rights\/([^/]+)\/evidence-file$/);
    if (request.method === "GET" && match) {
      const evidenceId = decodeURIComponent(match[1]!);
      const evidence = await env.CONTROL_DB.prepare(`
        SELECT * FROM tmg_rights_evidence WHERE evidence_id=?1 LIMIT 1
      `).bind(evidenceId).first<RightsEvidenceRow>();
      if (!evidence) return json({ error: "not_found", requestId }, 404);
      if (evidence.upload_state !== "integrity_verified") {
        return json({ error: "evidence_not_integrity_verified", requestId }, 409);
      }

      const object = await env.MEDIA_BUCKET.get(evidence.evidence_object_key);
      if (!object) return json({ error: "evidence_bytes_missing", requestId }, 404);

      return new Response(object.body, {
        headers: {
          "content-type": evidence.mime_type,
          "content-length": String(object.size),
          "content-disposition": `attachment; filename="${safeDownloadName(evidence.filename)}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-tmg-rights-review": "independent-authenticated-review-only",
        },
      });
    }

    return json({ error: "method_not_allowed", requestId }, 405);
  } catch (error) {
    if (error instanceof AccessRequiredError) {
      return json({ error: "access_required", requestId }, 403);
    }
    console.error(JSON.stringify({
      level: "error",
      event: "intake_review_api_failed",
      requestId,
      message: error instanceof Error ? error.message : "unknown_error",
    }));
    return json({ error: "internal_error", requestId }, 500);
  }
}
