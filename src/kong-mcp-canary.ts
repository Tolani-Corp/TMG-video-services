import { handleMcp } from "./mcp";

type CanaryEnv = Env & {
  TMG_DEPLOYED_SHA?: string;
  TMG_KONG_CANARY_ID?: string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function isEnabled(value: string | undefined): boolean {
  return value === "true";
}

async function isToolCall(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return false;
  const body = await request.clone().json().catch(() => null) as { method?: unknown } | null;
  return body?.method === "tools/call";
}

export default {
  async fetch(request: Request, env: CanaryEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        service: "tmg-video-services",
        canary: "kong-mcp-upstream-v1",
        canaryId: env.TMG_KONG_CANARY_ID,
        status: "ok",
        deployedSha: env.TMG_DEPLOYED_SHA,
        publicApiEnabled: isEnabled(env.TMG_PUBLIC_API_ENABLED),
        mcpEnabled: isEnabled(env.TMG_MCP_ENABLED),
        toolExecutionEnabled: false,
        dataBindingsPresent: false,
        externalProviderEgressEnabled: false,
        productionAuthority: false,
        requestId,
      });
    }

    if (url.pathname !== "/mcp") {
      return json({ error: "not_found", requestId }, 404);
    }

    if (!isEnabled(env.TMG_MCP_ENABLED)) {
      return json({ error: "mcp_disabled", requestId }, 503);
    }

    if (await isToolCall(request)) {
      return json(
        {
          error: "tool_execution_disabled",
          message: "This isolated Kong MCP canary permits discovery only. Tool execution is not authorized.",
          requestId,
        },
        403,
      );
    }

    return handleMcp(request, env, ctx);
  },
} satisfies ExportedHandler<CanaryEnv>;
