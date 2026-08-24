import { handleMcp } from "./mcp";
import { handleProductionApi } from "./production-api";
import { vectorSearchBodySchema } from "./schemas";
import { buildUiBootstrap } from "./ui-bootstrap";
import { searchVideoMoments, VectorDimensionError } from "./vectorize";

interface MarketingAcceptanceFixtureEnv extends Env {
  TMG_MARKETING_ACCEPTANCE_FIXTURE_ENABLED?: string;
}

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

function marketingAcceptanceFixture(pathname: string): Response | null {
  if (pathname === "/__acceptance/marketing-fixture/logo.svg") {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 96" role="img" aria-label="TMG Launchpad"><rect width="320" height="96" rx="20" fill="#111827"/><path d="M32 26h58v12H69v36H53V38H32z" fill="#22d3ee"/><text x="108" y="61" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#f8fafc">Launchpad</text></svg>`,
      {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "no-store",
          "x-robots-tag": "noindex",
        },
      },
    );
  }

  const pages: Record<string, { title: string; heading: string; body: string; bullets: string[]; cta: string }> = {
    "/__acceptance/marketing-fixture": {
      title: "TMG Launchpad — Governed media production",
      heading: "Turn product context into campaign-ready media",
      body: "TMG Launchpad is a synthetic acceptance product for validating governed campaign discovery and media production.",
      bullets: ["Checklist-driven campaign intake", "Target-aware video variants", "Human review before publication"],
      cta: "Get started",
    },
    "/__acceptance/marketing-fixture/features": {
      title: "TMG Launchpad Features",
      heading: "One brief, multiple campaign formats",
      body: "Create campaign context, creative briefs, social copy, and review-ready video variants from authorized product sources.",
      bullets: ["YouTube Shorts variants", "TikTok vertical variants", "Website hero variants"],
      cta: "Learn more",
    },
    "/__acceptance/marketing-fixture/pricing": {
      title: "TMG Launchpad Acceptance Plan",
      heading: "Synthetic development plan",
      body: "This fixture has no commercial offer and exists only for isolated development acceptance.",
      bullets: ["No live customer billing", "No publication authority", "No external distribution authority"],
      cta: "Request a demo",
    },
  };
  const page = pages[pathname];
  if (!page) return null;

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page.title}</title><meta name="description" content="${page.body}"><meta name="keywords" content="video marketing, campaign production, governed media"><style>:root{--brand-primary:#111827;--brand-accent:#22d3ee;--brand-surface:#f8fafc}body{font-family:Inter,Arial,sans-serif;background:var(--brand-primary);color:var(--brand-surface);margin:0}main{max-width:920px;margin:auto;padding:72px 28px}h1{font-size:clamp(2rem,6vw,4.5rem);line-height:1.02}a{color:var(--brand-accent)}.eyebrow{color:var(--brand-accent);font-weight:700}.card{margin-top:32px;padding:28px;border:1px solid #334155;border-radius:20px}</style></head><body><main><img src="/__acceptance/marketing-fixture/logo.svg" alt="TMG Launchpad logo" width="320" height="96"><p class="eyebrow">TMG MARKETING RUNTIME ACCEPTANCE</p><h1>${page.heading}</h1><p>${page.body}</p><div class="card"><ul>${page.bullets.map((item) => `<li>${item}</li>`).join("")}</ul><a href="/__acceptance/marketing-fixture/features">Features</a> · <a href="/__acceptance/marketing-fixture/pricing">Acceptance plan</a><p><strong>${page.cta}</strong></p></div></main></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      },
    },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const fixtureEnv = env as MarketingAcceptanceFixtureEnv;

    if (
      request.method === "GET" &&
      isEnabled(fixtureEnv.TMG_MARKETING_ACCEPTANCE_FIXTURE_ENABLED) &&
      url.pathname.startsWith("/__acceptance/marketing-fixture")
    ) {
      const response = marketingAcceptanceFixture(url.pathname);
      return response ?? json({ error: "fixture_not_found", requestId }, 404);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        service: "tmg-video-services",
        status: "ok",
        publicStatusGate: "G0",
        publicApiEnabled: isEnabled(env.TMG_PUBLIC_API_ENABLED),
        mcpEnabled: isEnabled(env.TMG_MCP_ENABLED),
        productionRequestApiEnabled: isEnabled(env.TMG_PRODUCTION_REQUEST_API_ENABLED),
        marketingDiscoveryEnabled: isEnabled(env.TMG_MARKETING_DISCOVERY_ENABLED),
        marketingVideoGenerationEnabled: isEnabled(env.TMG_MARKETING_VIDEO_GENERATION_ENABLED),
        imageRuntimeEnabled: isEnabled(env.TMG_IMAGE_RUNTIME_ENABLED),
        imageBindingConfigured: Boolean(env.IMAGES),
        policyVersion: env.TMG_POLICY_VERSION,
        requestId,
      });
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

    if (url.pathname.startsWith("/v1/production/")) {
      if (!isEnabled(env.TMG_PRODUCTION_REQUEST_API_ENABLED)) {
        return json(
          {
            error: "production_request_api_disabled",
            message: "Checklist production intake is implemented but remains disabled while TMG is at G0.",
            requestId,
          },
          503,
        );
      }
      return handleProductionApi(request, env, requestId);
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
export { ImageProcessingWorkflow } from "./image-workflow";
export { ProductionWorkflow } from "./production-workflow";
export { RevocationWorkflow } from "./revocation-workflow";
export { ProductionRequestCoordinator } from "./production-request-coordinator";
export { TenantUsageLedger } from "./tenant-usage-ledger";
