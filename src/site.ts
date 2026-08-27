type ServiceFetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type SiteEnv = {
  ASSETS: ServiceFetcher;
  TMG_BACKEND: ServiceFetcher;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asString(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

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

async function buildPublicStatus(env: SiteEnv): Promise<Response> {
  try {
    const upstream = await env.TMG_BACKEND.fetch(
      new Request("https://tmg.internal/v1/ui/bootstrap", {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-tmg-caller": "tolani-media-group-site",
        },
      }),
    );

    if (!upstream.ok) {
      return json(
        {
          schema: "tmg.public-status.v1",
          site: { status: "ok", worker: "tolani-media-group-site" },
          backend: { status: "degraded", worker: "tmg-video-services-production" },
        },
        503,
      );
    }

    const bootstrap = asRecord(await upstream.json());
    const runtime = asRecord(bootstrap.runtime);
    const release = asRecord(bootstrap.release);

    return json({
      schema: "tmg.public-status.v1",
      site: {
        status: "ok",
        worker: "tolani-media-group-site",
      },
      backend: {
        status: "reachable",
        worker: "tmg-video-services-production",
        service: asString(bootstrap.service),
        publicStatusGate: asString(bootstrap.publicStatusGate),
        policyVersion: asString(runtime.policyVersion),
      },
      runtime: {
        publicApiEnabled: asBoolean(runtime.publicApiEnabled),
        mcpEnabled: asBoolean(runtime.mcpEnabled),
        ingestWorkflowEnabled: asBoolean(runtime.ingestWorkflowEnabled),
        externalProviderEgressEnabled: asBoolean(runtime.externalProviderEgressEnabled),
        tenantUsageLedgerEnabled: asBoolean(runtime.tenantUsageLedgerEnabled),
        providerAcceptanceState: asString(runtime.providerAcceptanceState),
      },
      release: {
        status: asString(release.status),
        activationAuthorized: asBoolean(release.activationAuthorized),
        publicApiAuthorized: asBoolean(release.publicApiAuthorized),
        mcpAuthorized: asBoolean(release.mcpAuthorized),
        ingestionAuthorized: asBoolean(release.ingestionAuthorized),
        externalProviderEgressAuthorized: asBoolean(release.externalProviderEgressAuthorized),
        commercialUseAuthorized: asBoolean(release.commercialUseAuthorized),
      },
      synchronizedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "public_site_backend_sync_failed",
        message: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return json(
      {
        schema: "tmg.public-status.v1",
        site: { status: "ok", worker: "tolani-media-group-site" },
        backend: { status: "unavailable", worker: "tmg-video-services-production" },
      },
      503,
    );
  }
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/status.json") {
      return buildPublicStatus(env);
    }

    return env.ASSETS.fetch(request);
  },
};
