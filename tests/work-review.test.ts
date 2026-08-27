import { describe, expect, it, vi } from "vitest";
import reviewWorker from "../src/work-review";

type Stored = { body: Uint8Array; size: number; etag: string };

function fixtureManifest(status = "received_unreviewed") {
  return {
    schema: "tmg.work-request.v1",
    requestId: "wr_20260827_11111111-1111-4111-8111-111111111111",
    status,
    createdAt: "2026-08-27T20:00:00.000Z",
    updatedAt: "2026-08-27T20:05:00.000Z",
    requester: { name: "Client", email: "client@example.com", organization: "Example" },
    request: {
      serviceType: "content-analysis",
      title: "Analyze evidence",
      description: "Review supplied evidence under the stated scope.",
      desiredOutcome: "Produce an evidence-grounded assessment.",
      targetDate: null,
    },
    rights: { authorizedToShare: true, humanReviewAcknowledged: true },
    controls: { processingAuthorized: false, publicationAuthorized: false, externalProviderEgressAuthorized: false },
    tokenHash: "private-token-hash",
    files: [{
      fileId: "file_22222222-2222-4222-8222-222222222222",
      name: "evidence.txt",
      size: 8,
      type: "text/plain",
      sha256: "a".repeat(64),
      status: "uploaded",
      objectKey: "quarantine/private/object",
      uploadedAt: "2026-08-27T20:04:00.000Z",
    }],
  };
}

function makeBucket() {
  const store = new Map<string, Stored>();
  const putText = (key: string, value: string) => {
    const body = new TextEncoder().encode(value);
    store.set(key, { body, size: body.byteLength, etag: `etag-${store.size + 1}` });
  };
  const api = {
    get: vi.fn(async (key: string) => {
      const item = store.get(key);
      if (!item) return null;
      return {
        size: item.size,
        etag: item.etag,
        body: new Blob([Uint8Array.from(item.body)]).stream(),
        text: async () => new TextDecoder().decode(item.body),
      };
    }),
    head: vi.fn(async (key: string) => {
      const item = store.get(key);
      return item ? { size: item.size, etag: item.etag } : null;
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      let body: Uint8Array;
      if (typeof value === "string") body = new TextEncoder().encode(value);
      else if (value instanceof ReadableStream) body = new Uint8Array(await new Response(value).arrayBuffer());
      else if (value instanceof ArrayBuffer) body = new Uint8Array(value);
      else body = new Uint8Array();
      const item = { body, size: body.byteLength, etag: `etag-${store.size + 1}` };
      store.set(key, item);
      return { size: item.size, etag: item.etag };
    }),
    list: vi.fn(async () => ({
      objects: [...store.keys()].filter((key) => key.endsWith("manifest.json")).map((key) => ({ key })),
      truncated: false,
    })),
  };
  return { store, api, putText };
}

function makeContext(authenticated = true) {
  return authenticated ? {
    access: {
      aud: "review-aud",
      getIdentity: vi.fn(async () => ({ email: "operator@tolanicorp.us", name: "TMG Operator" })),
    },
  } : {};
}

function makeEnv() {
  const bucket = makeBucket();
  const manifest = fixtureManifest();
  const key = `requests/${manifest.requestId}/manifest.json`;
  bucket.putText(key, JSON.stringify(manifest));
  bucket.putText(manifest.files[0]!.objectKey, "evidence");
  const workflowCreate = vi.fn(async (options: { id?: string }) => ({ id: options.id ?? "generated" }));
  return {
    bucket,
    workflowCreate,
    env: {
      WORK_REQUESTS: bucket.api,
      WORK_REQUEST_PROCESSOR: { create: workflowCreate },
      TMG_REVIEW_ALLOWED_EMAIL_DOMAINS: "",
    },
    requestId: manifest.requestId,
    key,
  };
}

function mutation(path: string, body: unknown = {}) {
  return new Request(`https://review.tolanimediagroup.com${path}`, {
    method: "POST",
    headers: {
      origin: "https://review.tolanimediagroup.com",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("TMG work request review console", () => {
  it("fails closed without Cloudflare Access identity", async () => {
    const { env } = makeEnv();
    const response = await reviewWorker.fetch(
      new Request("https://review.tolanimediagroup.com/"),
      env as never,
      makeContext(false) as never,
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "cloudflare_access_required" });
  });

  it("returns an authenticated queue without leaking token hashes or R2 object keys", async () => {
    const { env } = makeEnv();
    const response = await reviewWorker.fetch(
      new Request("https://review.tolanimediagroup.com/api/queue"),
      env as never,
      makeContext() as never,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("operator@tolanicorp.us");
    expect(body).toContain("Analyze evidence");
    expect(body).not.toContain("private-token-hash");
    expect(body).not.toContain("quarantine/private/object");
  });

  it("requires a human review transition before granting processing authority", async () => {
    const { env, workflowCreate, requestId, bucket, key } = makeEnv();
    const premature = await reviewWorker.fetch(
      mutation(`/api/requests/${requestId}/approve`, { note: "Approved after evidence review." }),
      env as never,
      makeContext() as never,
    );
    expect(premature.status).toBe(409);
    expect(workflowCreate).not.toHaveBeenCalled();

    const review = await reviewWorker.fetch(
      mutation(`/api/requests/${requestId}/review`),
      env as never,
      makeContext() as never,
    );
    expect(review.status).toBe(200);

    const approved = await reviewWorker.fetch(
      mutation(`/api/requests/${requestId}/approve`, { note: "Rights and requested scope reviewed; bounded processing is approved." }),
      env as never,
      makeContext() as never,
    );
    expect(approved.status).toBe(200);
    expect(workflowCreate).toHaveBeenCalledTimes(1);

    const manifest = JSON.parse(new TextDecoder().decode(bucket.store.get(key)!.body));
    expect(manifest.status).toBe("approved_for_processing");
    expect(manifest.controls).toEqual({
      processingAuthorized: true,
      publicationAuthorized: false,
      externalProviderEgressAuthorized: false,
    });
    expect(manifest.review).toMatchObject({ state: "approved", reviewerEmail: "operator@tolanicorp.us" });
    expect(manifest.workflow.instanceId).toMatch(/^work_/);
  });

  it("denies cross-origin mutations even for an authenticated operator", async () => {
    const { env, requestId } = makeEnv();
    const response = await reviewWorker.fetch(
      new Request(`https://review.tolanimediagroup.com/api/requests/${requestId}/review`, {
        method: "POST",
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" },
        body: "{}",
      }),
      env as never,
      makeContext() as never,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "cross_origin_mutation_denied" });
  });

  it("rejects scope without granting any processing or publication authority", async () => {
    const { env, requestId, bucket, key } = makeEnv();
    const response = await reviewWorker.fetch(
      mutation(`/api/requests/${requestId}/reject`, { note: "Rights evidence is insufficient for the requested processing scope." }),
      env as never,
      makeContext() as never,
    );
    expect(response.status).toBe(200);
    const manifest = JSON.parse(new TextDecoder().decode(bucket.store.get(key)!.body));
    expect(manifest.status).toBe("rejected");
    expect(manifest.controls.processingAuthorized).toBe(false);
    expect(manifest.controls.publicationAuthorized).toBe(false);
    expect(manifest.controls.externalProviderEgressAuthorized).toBe(false);
    expect(manifest.workflow.outcome.status).toBe("rejected");
  });

  it("allows a terminal outcome only after the workflow reaches an action-required checkpoint", async () => {
    const { env, requestId, bucket, key } = makeEnv();
    const denied = await reviewWorker.fetch(
      mutation(`/api/requests/${requestId}/outcome`, { status: "completed", headline: "Done", summary: "Completed." }),
      env as never,
      makeContext() as never,
    );
    expect(denied.status).toBe(409);

    const manifest = fixtureManifest("action_required");
    manifest.controls.processingAuthorized = true;
    (manifest as typeof manifest & { workflow: Record<string, unknown> }).workflow = {
      progress: 82,
      events: [],
      outcome: { evidence: [{ label: "Evidence objects verified", value: "1" }], deliverables: [] },
    };
    bucket.putText(key, JSON.stringify(manifest));

    const completed = await reviewWorker.fetch(
      mutation(`/api/requests/${requestId}/outcome`, {
        status: "completed",
        headline: "Assessment complete",
        summary: "The reviewed evidence supports the recorded assessment.",
        nextAction: "Deliver the approved assessment to the requester.",
        confidence: "human_reviewed",
      }),
      env as never,
      makeContext() as never,
    );
    expect(completed.status).toBe(200);
    const stored = JSON.parse(new TextDecoder().decode(bucket.store.get(key)!.body));
    expect(stored.status).toBe("completed");
    expect(stored.controls.processingAuthorized).toBe(false);
    expect(stored.controls.publicationAuthorized).toBe(false);
    expect(stored.workflow.outcome.recordedBy).toBe("operator@tolanicorp.us");
  });
});
