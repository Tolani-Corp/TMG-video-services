import { describe, expect, it } from "vitest";
import {
  buildDerivativeAuthority,
  buildRightsVerdict,
  buildTechnicalAuthority,
  setChain,
  validateDerivativeAuthority,
  validateReceiptSha,
  validateTechnicalAuthority,
  withReceiptSha,
  type ProcessorChainRecord,
  type TechnicalInspectionReceipt,
} from "../src/processor-chain-core";
import { callAuthorizedExternalProvider, publishAuthorizedDerivatives } from "../src/governed-output-gates";
import type { WorkRequestManifest } from "../src/work-review-core";

function manifestFixture(): WorkRequestManifest {
  return {
    schema: "tmg.work-request.v1",
    requestId: "wr_20260827_11111111-1111-4111-8111-111111111111",
    status: "action_required",
    createdAt: "2026-08-27T20:00:00.000Z",
    updatedAt: "2026-08-27T20:00:00.000Z",
    requester: { name: "Client", email: "client@example.com", organization: "Example" },
    request: {
      serviceType: "media-processing",
      title: "Create private review derivatives",
      description: "Inspect and create review-only derivatives.",
      desiredOutcome: "Private review pack.",
      targetDate: null,
    },
    rights: { authorizedToShare: true, humanReviewAcknowledged: true },
    controls: { processingAuthorized: true, publicationAuthorized: false, externalProviderEgressAuthorized: false },
    tokenHash: "private",
    files: [{
      fileId: "file_22222222-2222-4222-8222-222222222222",
      name: "source.mp4",
      size: 1234,
      type: "video/mp4",
      sha256: "a".repeat(64),
      status: "uploaded",
      objectKey: "quarantine/private/source",
    }],
    review: {
      state: "approved",
      reviewId: "review_33333333-3333-4333-8333-333333333333",
      reviewerEmail: "operator@tolanicorp.us",
      note: "Approved for bounded processing.",
      at: "2026-08-27T20:10:00.000Z",
    },
    workflow: {
      instanceId: "work-original",
      processorResults: {
        "media-inspection": { schema: "tmg.processor-result.v1", status: "action_required" },
      },
      events: [],
    },
  };
}

async function chainFixture(manifest: WorkRequestManifest): Promise<ProcessorChainRecord> {
  const chain: ProcessorChainRecord = {
    schema: "tmg.processor-chain.v1.1",
    chainId: "pc_44444444-4444-4444-8444-444444444444",
    instanceId: "chain_instance_1",
    state: "waiting_technical_authority",
    sourceFileId: manifest.files[0]!.fileId,
    startedBy: "operator@tolanicorp.us",
    startedAt: "2026-08-27T20:20:00.000Z",
  };
  setChain(manifest, chain);
  return chain;
}

async function attachTechnicalReceipt(manifest: WorkRequestManifest, chain: ProcessorChainRecord) {
  const source = manifest.files[0]!;
  const receipt = await withReceiptSha<TechnicalInspectionReceipt>({
    schema: "tmg.technical-inspection-receipt.v1",
    receiptId: "tir_1",
    processorId: "technical-inspection",
    requestId: manifest.requestId,
    reviewId: manifest.review!.reviewId,
    chainInstanceId: chain.instanceId,
    fileId: source.fileId,
    sourceSha256: source.sha256,
    sourceSize: source.size,
    executedAt: "2026-08-27T20:30:00.000Z",
    probeSucceeded: true,
    decodeSucceeded: true,
    decodeExitCode: 0,
    format: { durationSeconds: 1 },
    streams: [{ type: "video", codec: "h264", width: 320, height: 180 }],
    corruptionSignals: [],
    toolchain: { ffmpeg: "ffmpeg test", ffprobe: "ffprobe test" },
  } as Omit<TechnicalInspectionReceipt, "receiptSha256">);
  chain.technicalReceipt = receipt;
  chain.state = "waiting_rights_verdict";
  setChain(manifest, chain);
  return receipt;
}

describe("Processor Chain v1.1 authority model", () => {
  it("binds full FFmpeg technical authority to the exact chain and evidence inventory", async () => {
    const manifest = manifestFixture();
    const chain = await chainFixture(manifest);
    const authority = buildTechnicalAuthority(manifest, chain, "operator@tolanicorp.us", "Authorize full local ffprobe and decode inspection.", 60_000);
    chain.technicalAuthority = authority;
    const reasons = await validateTechnicalAuthority(manifest, chain, authority, {
      authorityId: authority.authorityId,
      requestId: manifest.requestId,
      reviewId: manifest.review!.reviewId,
    }, Date.parse(authority.grantedAt) + 1);
    expect(reasons).toEqual([]);
    expect(authority.localExecutionOnly).toBe(true);
    expect(authority.publicationAuthorized).toBe(false);
    expect(authority.externalProviderEgressAuthorized).toBe(false);
    expect(authority.allowedActions).toContain("decode_media");

    manifest.files[0]!.sha256 = "b".repeat(64);
    const drifted = await validateTechnicalAuthority(manifest, chain, authority, {
      authorityId: authority.authorityId,
      requestId: manifest.requestId,
      reviewId: manifest.review!.reviewId,
    }, Date.parse(authority.grantedAt) + 1);
    expect(drifted).toContain("technical_authority_evidence_mismatch");
  });

  it("creates an immutable human rights sufficiency receipt bound to technical evidence", async () => {
    const manifest = manifestFixture();
    const chain = await chainFixture(manifest);
    const technical = await attachTechnicalReceipt(manifest, chain);
    const verdict = await buildRightsVerdict(manifest, chain, {
      state: "sufficient",
      permittedUses: ["frame_extraction", "transcode", "derivative_generation"],
      permittedTerritories: ["US"],
      expiresAt: "2026-09-27T00:00:00.000Z",
      note: "Reviewed supplied evidence; private derivative generation is permitted within the stated scope.",
    }, "rights-reviewer@tolanicorp.us");
    chain.rightsVerdict = verdict;
    expect(verdict.technicalReceiptSha256).toBe(technical.receiptSha256);
    expect(await validateReceiptSha(verdict as unknown as Record<string, unknown>)).toBe(true);

    verdict.note = "tampered";
    expect(await validateReceiptSha(verdict as unknown as Record<string, unknown>)).toBe(false);
  });

  it("requires valid technical and rights receipts before derivative recipe authority", async () => {
    const manifest = manifestFixture();
    const chain = await chainFixture(manifest);
    await attachTechnicalReceipt(manifest, chain);
    chain.rightsVerdict = await buildRightsVerdict(manifest, chain, {
      state: "sufficient",
      permittedUses: ["frame_extraction", "transcode", "derivative_generation"],
      permittedTerritories: ["US"],
      expiresAt: null,
      note: "Private preview derivative scope approved after evidence review.",
    }, "rights-reviewer@tolanicorp.us");
    chain.state = "waiting_derivative_authority";
    const authority = await buildDerivativeAuthority(manifest, chain, "preview-pack-v1", "operator@tolanicorp.us", "Authorize the exact private preview-pack recipe.", 60_000);
    chain.derivativeAuthority = authority;
    const reasons = await validateDerivativeAuthority(manifest, chain, authority, {
      authorityId: authority.authorityId,
      requestId: manifest.requestId,
      reviewId: manifest.review!.reviewId,
    }, Date.parse(authority.grantedAt) + 1);
    expect(reasons).toEqual([]);
    expect(authority.allowedActions).toContain("run_ffmpeg");
    expect(authority.allowedActions).toContain("extract_frames");
    expect(authority.allowedActions).toContain("transcode");
    expect(authority.publicationAuthorized).toBe(false);
    expect(authority.externalProviderEgressAuthorized).toBe(false);
  });

  it("keeps publication and external provider execution globally fail-closed", async () => {
    const manifest = manifestFixture();
    await expect(publishAuthorizedDerivatives({ TMG_PUBLICATION_EXECUTION_ENABLED: "false" } as never, manifest, {} as never))
      .rejects.toThrow("publication_execution_globally_disabled");
    await expect(callAuthorizedExternalProvider({ TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false" } as never, manifest, {} as never, new Uint8Array()))
      .rejects.toThrow("external_provider_egress_globally_disabled");
  });
});
