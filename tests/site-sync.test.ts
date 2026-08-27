import { describe, expect, it, vi } from "vitest";
import siteWorker from "../src/site";

function backendBootstrap() {
  return {
    schema: "tmg.ui-bootstrap.v1",
    service: "tmg-video-services",
    publicStatusGate: "G0",
    runtime: {
      publicApiEnabled: false,
      mcpEnabled: false,
      ingestWorkflowEnabled: false,
      externalProviderEgressEnabled: false,
      tenantUsageLedgerEnabled: false,
      providerAcceptanceState: "unverified",
      policyVersion: "2026-08-20.v3",
      secretShouldNeverEscape: "do-not-publish",
    },
    release: {
      status: "s0_s1_implemented_unactivated",
      activationAuthorized: false,
      publicApiAuthorized: false,
      mcpAuthorized: false,
      ingestionAuthorized: false,
      externalProviderEgressAuthorized: false,
      commercialUseAuthorized: false,
    },
    requestId: "internal-request-id",
  };
}

describe("Tolani Media Group public-site Worker sync", () => {
  it("sanitizes backend bootstrap data for same-origin browser status", async () => {
    const backendFetch = vi.fn(async () => Response.json(backendBootstrap()));
    const assetFetch = vi.fn(async () => new Response("asset"));

    const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/status.json"), {
      ASSETS: { fetch: assetFetch },
      TMG_BACKEND: { fetch: backendFetch },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(backendFetch).toHaveBeenCalledTimes(1);

    const status = await response.json() as Record<string, unknown>;
    expect(status).toMatchObject({
      schema: "tmg.public-status.v1",
      site: { status: "ok", worker: "tolani-media-group-site" },
      backend: {
        status: "reachable",
        worker: "tmg-video-services-production",
        service: "tmg-video-services",
        publicStatusGate: "G0",
        policyVersion: "2026-08-20.v3",
      },
      runtime: {
        publicApiEnabled: false,
        mcpEnabled: false,
        ingestWorkflowEnabled: false,
        externalProviderEgressEnabled: false,
      },
      release: {
        activationAuthorized: false,
        publicApiAuthorized: false,
        commercialUseAuthorized: false,
      },
    });

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("do-not-publish");
    expect(serialized).not.toContain("internal-request-id");
  });

  it("fails closed when the private backend binding is unavailable", async () => {
    const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/status.json"), {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      TMG_BACKEND: { fetch: vi.fn(async () => { throw new Error("backend unavailable"); }) },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      schema: "tmg.public-status.v1",
      site: { status: "ok", worker: "tolani-media-group-site" },
      backend: { status: "unavailable", worker: "tmg-video-services-production" },
    });
  });

  it("delegates non-status requests to static assets", async () => {
    const assetFetch = vi.fn(async () => new Response("home", { status: 200 }));
    const backendFetch = vi.fn(async () => Response.json(backendBootstrap()));

    const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/"), {
      ASSETS: { fetch: assetFetch },
      TMG_BACKEND: { fetch: backendFetch },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("home");
    expect(assetFetch).toHaveBeenCalledTimes(1);
    expect(backendFetch).not.toHaveBeenCalled();
  });
});
