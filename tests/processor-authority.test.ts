import { describe, expect, it, vi } from "vitest";
import { buildProcessorAuthorityEnvelope, executeAuthorizedProcessor, validateProcessorAuthority } from "../src/processor-authority";
import { processorRoute, type WorkRequestManifest } from "../src/work-review-core";

function manifest(serviceType: string, fileType = "text/plain", fileBytes = new TextEncoder().encode("evidence")): WorkRequestManifest {
  return {
    schema: "tmg.work-request.v1",
    requestId: "wr_20260827_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "action_required",
    createdAt: "2026-08-27T20:00:00.000Z",
    updatedAt: "2026-08-27T20:05:00.000Z",
    requester: { name: "Client", email: "client@example.com", organization: "Example" },
    request: { serviceType, title: "Request", description: "Description", desiredOutcome: "Outcome", targetDate: null },
    rights: { authorizedToShare: true, humanReviewAcknowledged: true },
    controls: { processingAuthorized: true, publicationAuthorized: false, externalProviderEgressAuthorized: false },
    tokenHash: "private",
    files: [{
      fileId: "file_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: fileType.startsWith("video/") ? "sample.mp4" : "evidence.txt",
      size: fileBytes.byteLength,
      type: fileType,
      sha256: "a".repeat(64),
      status: "uploaded",
      objectKey: "quarantine/sample",
      uploadedAt: "2026-08-27T20:04:00.000Z",
    }],
    review: {
      state: "approved",
      reviewId: "review_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      reviewerEmail: "operator@tolanicorp.us",
      note: "Approved request processing.",
      at: "2026-08-27T20:06:00.000Z",
    },
    workflow: {
      instanceId: "work_exact_instance",
      processorId: serviceType === "rights-provenance" ? "rights-provenance" : "media-inspection",
      processorState: "processor_authorization_required",
      processorAuthorizationState: "required",
      progress: 82,
      events: [],
    },
  };
}

function bucketWith(bytes: Uint8Array) {
  return {
    get: vi.fn(async (_key: string, options?: { range?: { offset?: number; length?: number } }) => {
      const offset = options?.range?.offset ?? 0;
      const length = options?.range?.length ?? bytes.byteLength;
      const slice = bytes.slice(offset, offset + length);
      return {
        size: bytes.byteLength,
        arrayBuffer: async () => Uint8Array.from(slice).buffer,
      };
    }),
  };
}

describe("processor-specific authority", () => {
  it("binds rights/provenance authority to the exact workflow, actions, and evidence inventory", () => {
    const request = manifest("rights-provenance");
    const route = processorRoute(request.request.serviceType);
    const authority = buildProcessorAuthorityEnvelope(request, route, "operator@tolanicorp.us", "Authorize exact structural provenance checks.", 60_000);
    const reasons = validateProcessorAuthority(request, route, authority, {
      authorityId: authority.authorityId,
      processorId: authority.processorId,
      reviewId: authority.reviewId,
    }, Date.parse(authority.grantedAt) + 1);

    expect(reasons).toEqual([]);
    expect(authority.localExecutionOnly).toBe(true);
    expect(authority.publicationAuthorized).toBe(false);
    expect(authority.externalProviderEgressAuthorized).toBe(false);
    expect(authority.evidenceBindings).toEqual([{
      fileId: request.files[0]!.fileId,
      sha256: request.files[0]!.sha256,
      size: request.files[0]!.size,
    }]);
  });

  it("rejects evidence drift after authority is granted", () => {
    const request = manifest("rights-provenance");
    const route = processorRoute(request.request.serviceType);
    const authority = buildProcessorAuthorityEnvelope(request, route, "operator@tolanicorp.us", "Authorize exact structural provenance checks.", 60_000);
    request.files[0]!.sha256 = "b".repeat(64);
    const reasons = validateProcessorAuthority(request, route, authority, {
      authorityId: authority.authorityId,
      processorId: authority.processorId,
      reviewId: authority.reviewId,
    }, Date.parse(authority.grantedAt) + 1);
    expect(reasons).toContain("processor_authority_evidence_binding_mismatch");
  });

  it("executes structural rights/provenance verification without claiming legal sufficiency", async () => {
    const request = manifest("rights-provenance");
    const result = await executeAuthorizedProcessor({ WORK_REQUESTS: bucketWith(new TextEncoder().encode("evidence")) } as never, request, processorRoute("rights-provenance"));
    expect(result.progress).toBeGreaterThan(82);
    expect(result.processorId).toBe("rights-provenance");
    expect(result.summary).toContain("not a legal sufficiency determination");
    expect(result.evidence).toContainEqual({ label: "Legal sufficiency", value: "not determined by automated adapter" });
  });

  it("inspects only a bounded media header and recognizes an MP4 signature", async () => {
    const bytes = new Uint8Array(80);
    bytes.set([0x00, 0x00, 0x00, 0x18], 0);
    bytes.set(new TextEncoder().encode("ftyp"), 4);
    bytes.set(new TextEncoder().encode("isom"), 8);
    const request = manifest("media-processing", "video/mp4", bytes);
    const bucket = bucketWith(bytes);
    const result = await executeAuthorizedProcessor({ WORK_REQUESTS: bucket } as never, request, processorRoute("media-processing"));

    expect(result.progress).toBe(94);
    expect(result.processorId).toBe("media-inspection");
    expect(result.evidence).toContainEqual({ label: "Signature mismatches", value: "0" });
    expect(bucket.get).toHaveBeenCalledWith("quarantine/sample", { range: { offset: 0, length: 64 } });
  });

  it("does not route content analysis into the local processor authorization path", () => {
    const route = processorRoute("content-analysis");
    expect(route.authorizable).toBe(false);
    expect(route.state).toBe("provider_egress_gated");
    expect(route.adapter).toBeNull();
  });
});
