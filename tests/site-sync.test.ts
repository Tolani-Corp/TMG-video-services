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

function backendHealth() {
  return {
    ok: true,
    service: "tmg-video-services",
    publicStatusGate: "G0",
    policyVersion: "2026-08-20.v3",
    publicApiEnabled: false,
    mcpEnabled: false,
    internalOnly: "must-not-escape",
  };
}

function makeBucket() {
  const store = new Map<string, { body: Uint8Array; size: number; etag: string }>();
  return {
    store,
    api: {
      get: vi.fn(async (key: string) => {
        const item = store.get(key);
        if (!item) return null;
        return {
          size: item.size,
          etag: item.etag,
          text: async () => new TextDecoder().decode(item.body),
        };
      }),
      head: vi.fn(async (key: string) => {
        const item = store.get(key);
        return item ? { size: item.size, etag: item.etag } : null;
      }),
      put: vi.fn(async (key: string, value: unknown) => {
        let bytes: Uint8Array;
        if (typeof value === "string") bytes = new TextEncoder().encode(value);
        else if (value instanceof ReadableStream) bytes = new Uint8Array(await new Response(value).arrayBuffer());
        else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
        else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
        else bytes = new Uint8Array();
        const item = { body: bytes, size: bytes.byteLength, etag: `etag-${store.size + 1}` };
        store.set(key, item);
        return { size: item.size, etag: item.etag };
      }),
    },
  };
}

function makeEnv(backendFetch = vi.fn(async () => Response.json(backendBootstrap()))) {
  const bucket = makeBucket();
  return {
    bucket,
    env: {
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      TMG_BACKEND: { fetch: backendFetch },
      WORK_REQUESTS: bucket.api,
      WORK_REQUEST_START_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      WORK_REQUEST_UPLOAD_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      TMG_WORK_REQUEST_INTAKE_ENABLED: "true",
    },
  };
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function startEmptyRequest(env: ReturnType<typeof makeEnv>["env"]) {
  const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/work-requests", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.22" },
    body: JSON.stringify({
      requester: { name: "Live View Tester", email: "live@example.com", organization: "Example" },
      request: {
        serviceType: "video-intelligence",
        title: "Live workflow view",
        description: "Exercise the authenticated live processing status contract.",
        desiredOutcome: "Show a safe processing outcome with evidence context.",
        targetDate: "",
      },
      authorizedToShare: true,
      humanReviewAcknowledged: true,
      files: [],
    }),
  }), env);
  expect(response.status).toBe(201);
  return response.json() as Promise<{ requestId: string; uploadToken: string; files: Array<{ fileId: string }> }>;
}

describe("Tolani Media Group public-site Worker sync", () => {
  it("sanitizes backend bootstrap data for same-origin browser status", async () => {
    const backendFetch = vi.fn(async () => Response.json(backendBootstrap()));
    const { env } = makeEnv(backendFetch);
    const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/status.json"), env);

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
        syncContract: "ui-bootstrap-v1",
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

  it("falls back to the deployed health contract without inventing unavailable runtime fields", async () => {
    const backendFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/v1/ui/bootstrap") return new Response("not found", { status: 404 });
      if (url.pathname === "/health") return Response.json(backendHealth());
      return new Response("unexpected", { status: 500 });
    });
    const { env } = makeEnv(backendFetch);
    const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/status.json"), env);

    expect(response.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledTimes(2);
    await expect(response.json()).resolves.toMatchObject({
      schema: "tmg.public-status.v1",
      backend: { status: "reachable", worker: "tmg-video-services-production", syncContract: "health-v1", publicStatusGate: "G0" },
      runtime: { publicApiEnabled: false, mcpEnabled: false, ingestWorkflowEnabled: null, externalProviderEgressEnabled: null },
      release: null,
    });
  });

  it("fails closed when the private backend binding is unavailable", async () => {
    const { env } = makeEnv(vi.fn(async () => { throw new Error("backend unavailable"); }));
    const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/status.json"), env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      schema: "tmg.public-status.v1",
      site: { status: "ok", worker: "tolani-media-group-site" },
      backend: { status: "unavailable", worker: "tmg-video-services-production" },
    });
  });

  it("advertises only the bounded quarantine intake contract", async () => {
    const { env } = makeEnv();
    const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/work-requests/config"), env);
    await expect(response.json()).resolves.toMatchObject({
      schema: "tmg.work-request-intake-config.v1",
      enabled: true,
      maxFiles: 5,
      maxFileBytes: 52_428_800,
      maxTotalBytes: 157_286_400,
      posture: "private_quarantine_human_review",
      processingAuthorized: false,
      publicationAuthorized: false,
    });
  });

  it("creates, checksum-binds, uploads, and completes a quarantined work request without granting processing authority", async () => {
    const { env, bucket } = makeEnv();
    const fixture = new TextEncoder().encode("harmless TMG work request fixture\n");
    const fixtureSha = await sha256Hex(fixture);
    const startResponse = await siteWorker.fetch(new Request("https://tolanimediagroup.com/work-requests", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
      body: JSON.stringify({
        requester: { name: "Test Requester", email: "requester@example.com", organization: "Example" },
        request: {
          serviceType: "content-analysis",
          title: "Fixture review",
          description: "Review the attached harmless test fixture.",
          desiredOutcome: "Return a governed assessment.",
          targetDate: "",
        },
        authorizedToShare: true,
        humanReviewAcknowledged: true,
        files: [{ name: "fixture.txt", size: fixture.byteLength, type: "text/plain", sha256: fixtureSha }],
      }),
    }), env);

    expect(startResponse.status).toBe(201);
    const start = await startResponse.json() as { requestId: string; uploadToken: string; files: Array<{ fileId: string }> };
    expect(start.uploadToken).toBeTruthy();
    expect(bucket.store.has(`requests/${start.requestId}/manifest.json`)).toBe(true);
    const storedManifest = new TextDecoder().decode(bucket.store.get(`requests/${start.requestId}/manifest.json`)?.body);
    expect(storedManifest).not.toContain(start.uploadToken);
    expect(storedManifest).toContain('"processingAuthorized": false');

    const firstFile = start.files[0];
    expect(firstFile).toBeDefined();
    const fileId = firstFile!.fileId;
    const uploadResponse = await siteWorker.fetch(new Request(`https://tolanimediagroup.com/work-requests/${start.requestId}/files/${fileId}`, {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        "content-length": String(fixture.byteLength),
        "x-work-request-token": start.uploadToken,
      },
      body: fixture,
    }), env);
    expect(uploadResponse.status).toBe(200);
    await expect(uploadResponse.json()).resolves.toMatchObject({ status: "uploaded_quarantine", sha256: fixtureSha });
    expect(bucket.store.has(`quarantine/${start.requestId}/files/${fileId}`)).toBe(true);

    const completeResponse = await siteWorker.fetch(new Request(`https://tolanimediagroup.com/work-requests/${start.requestId}/complete`, {
      method: "POST",
      headers: { "x-work-request-token": start.uploadToken },
    }), env);
    expect(completeResponse.status).toBe(200);
    await expect(completeResponse.json()).resolves.toMatchObject({
      schema: "tmg.work-request-receipt.v1",
      status: "received_unreviewed",
      nextStep: "human_review",
      controls: { processingAuthorized: false, publicationAuthorized: false, externalProviderEgressAuthorized: false },
    });
  });

  it("returns an authenticated sanitized live processing view and reflects recorded workflow outcome context", async () => {
    const { env, bucket } = makeEnv();
    const start = await startEmptyRequest(env);
    const completeResponse = await siteWorker.fetch(new Request(`https://tolanimediagroup.com/work-requests/${start.requestId}/complete`, {
      method: "POST",
      headers: { "x-work-request-token": start.uploadToken },
    }), env);
    expect(completeResponse.status).toBe(200);

    const waitingResponse = await siteWorker.fetch(new Request(`https://tolanimediagroup.com/work-requests/${start.requestId}/status`, {
      headers: { "x-work-request-token": start.uploadToken },
    }), env);
    expect(waitingResponse.status).toBe(200);
    await expect(waitingResponse.json()).resolves.toMatchObject({
      schema: "tmg.work-request-processing-status.v1",
      requestId: start.requestId,
      status: "received_unreviewed",
      lifecycle: {
        phase: "human_review",
        state: "waiting",
        progress: 35,
        headline: "Awaiting human review",
      },
      context: {
        files: { total: 0, uploaded: 0 },
        controls: { processingAuthorized: false, publicationAuthorized: false, externalProviderEgressAuthorized: false },
      },
    });

    const denied = await siteWorker.fetch(new Request(`https://tolanimediagroup.com/work-requests/${start.requestId}/status`, {
      headers: { "x-work-request-token": "wrong-token" },
    }), env);
    expect(denied.status).toBe(404);

    const key = `requests/${start.requestId}/manifest.json`;
    const stored = bucket.store.get(key);
    expect(stored).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(stored!.body));
    manifest.status = "processing";
    manifest.controls.processingAuthorized = true;
    manifest.workflow = {
      phase: "scene_analysis",
      progress: 73,
      headline: "Analyzing approved media segments",
      summary: "Three governed analysis steps have completed and the current evidence pass is active.",
      secretShouldNeverEscape: "private-workflow-control",
      events: [
        { id: "evt-1", at: "2026-08-27T21:30:00.000Z", phase: "processing", state: "complete", title: "Source integrity verified", detail: "Checksum and source envelope matched the approved request." },
        { id: "evt-2", at: "2026-08-27T21:31:00.000Z", phase: "scene_analysis", state: "active", title: "Scene analysis running", detail: "Authorized analysis is processing the bounded source set." },
      ],
      outcome: {
        status: "provisional",
        headline: "Preliminary signal detected",
        summary: "The workflow has identified candidate moments for human review.",
        confidence: "moderate",
        nextAction: "Wait for the evidence pass to complete before reviewing deliverables.",
        evidence: [{ label: "Segments evaluated", value: "12" }],
        deliverables: [{ label: "Review package", status: "building" }],
        internalPath: "r2://must-not-escape",
      },
    };
    const encoded = new TextEncoder().encode(JSON.stringify(manifest));
    bucket.store.set(key, { body: encoded, size: encoded.byteLength, etag: stored!.etag });

    const processingResponse = await siteWorker.fetch(new Request(`https://tolanimediagroup.com/work-requests/${start.requestId}/status`, {
      headers: { "x-work-request-token": start.uploadToken },
    }), env);
    expect(processingResponse.status).toBe(200);
    const processing = await processingResponse.json() as Record<string, unknown>;
    expect(processing).toMatchObject({
      status: "processing",
      lifecycle: {
        phase: "scene_analysis",
        state: "active",
        progress: 73,
        headline: "Analyzing approved media segments",
      },
      context: {
        controls: { processingAuthorized: true, publicationAuthorized: false, externalProviderEgressAuthorized: false },
      },
      events: [
        { id: "evt-1", title: "Source integrity verified", state: "complete" },
        { id: "evt-2", title: "Scene analysis running", state: "active" },
      ],
      outcome: {
        status: "provisional",
        headline: "Preliminary signal detected",
        confidence: "moderate",
        evidence: [{ label: "Segments evaluated", value: "12" }],
        deliverables: [{ label: "Review package", status: "building" }],
      },
    });
    const serialized = JSON.stringify(processing);
    expect(serialized).not.toContain("private-workflow-control");
    expect(serialized).not.toContain("r2://must-not-escape");
    expect(serialized).not.toContain("live@example.com");
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain(start.uploadToken);
  });

  it("rejects work requests without rights and human-review attestations", async () => {
    const { env } = makeEnv();
    const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/work-requests", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({
        requester: { name: "Test", email: "test@example.com" },
        request: { serviceType: "custom", title: "Request", description: "Description", desiredOutcome: "Outcome" },
        authorizedToShare: false,
        humanReviewAcknowledged: false,
        files: [],
      }),
    }), env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "required_attestations_missing" });
  });

  it("delegates non-dynamic requests to static assets", async () => {
    const backendFetch = vi.fn(async () => Response.json(backendBootstrap()));
    const { env } = makeEnv(backendFetch);
    const assetFetch = vi.fn(async () => new Response("home", { status: 200 }));
    env.ASSETS.fetch = assetFetch;
    const response = await siteWorker.fetch(new Request("https://tolanimediagroup.com/"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("home");
    expect(assetFetch).toHaveBeenCalledTimes(1);
    expect(backendFetch).not.toHaveBeenCalled();
  });
});
