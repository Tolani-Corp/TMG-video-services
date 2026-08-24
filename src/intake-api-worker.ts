import { handleIntakeApi } from "./intake-api";

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    if (
      url.pathname === "/v1/console/session" ||
      url.pathname.startsWith("/v1/intake/") ||
      url.pathname === "/v1/intake/requests" ||
      url.pathname === "/v1/intake/jobs"
    ) {
      return handleIntakeApi(request, env, ctx, requestId);
    }

    return json({ error: "not_found", requestId }, 404);
  },
} satisfies ExportedHandler<Env>;
