import { EnterpriseWorkloadAuthError, verifyEnterpriseWorkloadRequest } from "./enterprise-workload-auth";
import { handleMcp } from "./mcp";
import { vectorSearchBodySchema } from "./schemas";
import { buildUiBootstrap } from "./ui-bootstrap";
import { searchVideoMoments, VectorDimensionError } from "./vectorize";

type EnterpriseEnv = Env & {
  TOLANI_CLERK_JWT_KEY?: string;
  TOLANI_CLERK_ISSUER?: string;
  TOLANI_RUNTIME_ENV?: string;
  TOLANI_INTERNAL_ACCESS_ENABLED?: string;
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

async function requireInternalWorkload(request: Request, env: EnterpriseEnv, requiredScope: string) {
  if (!isEnabled(env.TOLANI_INTERNAL_ACCESS_ENABLED)) {
    return { response: json({ error: "internal_access_disabled" }, 503) } as const;
  }
  if (!env.TOLANI_CLERK_JWT_KEY || !env.TOLANI_CLERK_ISSUER || !env.TOLANI_RUNTIME_ENV) {
    return { response: json({ error: "internal_identity_not_configured" }, 503) } as const;
  }
  try {
    const principal = await verifyEnterpriseWorkloadRequest(request, {
      pemPublicKey: env.TOLANI_CLERK_JWT_KEY,
      expectedIssuer: env.TOLANI_CLERK_ISSUER,
      expectedAudience: `tolani:tmg-video:${env.TOLANI_RUNTIME_ENV}`,
      expectedEnvironment: env.TOLANI_RUNTIME_ENV,
      requiredScopes: [requiredScope],
      maxTtlSeconds: 300,
      clockSkewSeconds: 30,
    });
    return { principal } as const;
  } catch (error) {
    const authError = error instanceof EnterpriseWorkloadAuthError ? error : new EnterpriseWorkloadAuthError("workload_verification_failed", 500);
    const status = authError.status === 500 ? 503 : authError.status;
    return { response: json({ error: authError.code }, status) } as const;
  }
}

export default {
  async fetch(request: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    const env = rawEnv as EnterpriseEnv;
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        service: "tmg-video-services",
        status: "ok",
        publicStatusGate: "G0",
        publicApiEnabled: isEnabled(env.TMG_PUBLIC_API_ENABLED),
        mcpEnabled: isEnabled(env.TMG_MCP_ENABLED),
        internalAccessEnabled: isEnabled(env.TOLANI_INTERNAL_ACCESS_ENABLED),
        policyVersion: env.TMG_POLICY_VERSION,
        requestId,
      });
    }

    if (request.method === "GET" && url.pathname === "/internal/access/probe") {
      const auth = await requireInternalWorkload(request, env, "tolani.service.discover");
      if ("response" in auth) return auth.response;
      return json({
        service: "tmg-video",
        accessClass: "tolani-internal",
        callerServiceId: auth.principal.serviceId,
        interfaces: ["api", "mcp"],
        billingExempt: true,
        requestId,
      });
    }

    if (url.pathname === "/internal/mcp") {
      const auth = await requireInternalWorkload(request, env, "tmg.video.mcp.invoke");
      if ("response" in auth) return auth.response;
      if (!isEnabled(env.TMG_MCP_ENABLED)) {
        return json({ error: "mcp_disabled", requestId }, 503);
      }
      return handleMcp(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/v1/ui/bootstrap") {
      return json({
        ...buildUiBootstrap(env),
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
        const { territory, ...searchRequest } = parsed.data;
        const matches = await searchVideoMoments(env, {
          ...searchRequest,
          purpose: "external_api",
          ...(territory ? { territory } : {}),
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

export { IngestionWorkflow } from "./workflow";
export { RevocationWorkflow } from "./revocation-workflow";
export { TenantUsageLedger } from "./tenant-usage-ledger";
