import { handleMcp } from "./mcp";
import { vectorSearchBodySchema } from "./schemas";
import { searchVideoMoments, VectorDimensionError } from "./vectorize";

export { IngestionWorkflow } from "./workflow";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function isEnabled(value: string | undefined): boolean {
  return value === "true";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        service: "tmg-video-services",
        status: "ok",
        publicStatusGate: "G0",
        publicApiEnabled: isEnabled(env.TMG_PUBLIC_API_ENABLED),
        mcpEnabled: isEnabled(env.TMG_MCP_ENABLED),
        ingestWorkflowEnabled: isEnabled(env.TMG_INGEST_WORKFLOW_ENABLED),
        ingestionMode: env.TMG_INGESTION_MODE,
        policyVersion: env.TMG_POLICY_VERSION,
        requestId,
      });
    }

    if (url.pathname === "/mcp") {
      if (!isEnabled(env.TMG_MCP_ENABLED)) {
        return json(
          {
            error: "mcp_disabled",
            message: "MCP access is disabled while the service remains at G0.",
            requestId,
          },
          503,
        );
      }
      return handleMcp(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/v1/search/vector") {
      if (!isEnabled(env.TMG_PUBLIC_API_ENABLED)) {
        return json(
          {
            error: "public_api_disabled",
            message: "External API access is disabled while the service remains at G0.",
            requestId,
          },
          503,
        );
      }

      const parsed = vectorSearchBodySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return json(
          {
            error: "invalid_request",
            issues: parsed.error.issues,
            requestId,
          },
          400,
        );
      }

      try {
        const matches = await searchVideoMoments(env, {
          ...parsed.data,
          purpose: "external_api",
        });
        return json({ matches, requestId });
      } catch (error) {
        if (error instanceof VectorDimensionError) {
          return json({ error: "invalid_vector_dimensions", message: error.message, requestId }, 400);
        }

        console.error(
          JSON.stringify({
            level: "error",
            event: "video_search_failed",
            requestId,
            message: error instanceof Error ? error.message : "unknown_error",
          }),
        );
        return json({ error: "internal_error", requestId }, 500);
      }
    }

    return json({ error: "not_found", requestId }, 404);
  },
} satisfies ExportedHandler<Env>;
