import {
  type ProcessorAuthorityEnvelope,
  type ProcessorId,
  type ProcessorRoute,
  type ReviewEnv,
  type WorkRequestManifest,
} from "./work-review-core";

export type ProcessorExecutionResult = {
  processorId: ProcessorId;
  status: "completed" | "action_required";
  progress: number;
  headline: string;
  summary: string;
  nextAction: string;
  confidence: "system_verified" | "human_review_required";
  evidence: Array<{ label: string; value: string }>;
  deliverables: Array<{ label: string; status: string }>;
  details: Record<string, unknown>;
};

function sameEvidenceBindings(manifest: WorkRequestManifest, authority: ProcessorAuthorityEnvelope): boolean {
  if (authority.evidenceBindings.length !== manifest.files.length) return false;
  const expected = new Map(manifest.files.map((file) => [file.fileId, `${file.sha256}:${file.size}`]));
  for (const binding of authority.evidenceBindings) {
    if (expected.get(binding.fileId) !== `${binding.sha256}:${binding.size}`) return false;
  }
  return true;
}

function sameActions(authority: ProcessorAuthorityEnvelope, route: ProcessorRoute): boolean {
  if (authority.allowedActions.length !== route.allowedActions.length) return false;
  const expected = new Set(route.allowedActions);
  return authority.allowedActions.every((action) => expected.has(action));
}

export function validateProcessorAuthority(
  manifest: WorkRequestManifest,
  route: ProcessorRoute,
  authority: ProcessorAuthorityEnvelope | undefined,
  eventPayload: Record<string, unknown>,
  nowMs = Date.now(),
): string[] {
  const reasons: string[] = [];
  if (!authority) return ["processor_authority_missing"];
  if (authority.schema !== "tmg.processor-authority.v1") reasons.push("processor_authority_schema_invalid");
  if (authority.state !== "authorized") reasons.push("processor_authority_not_active");
  if (authority.processorId !== route.processorId) reasons.push("processor_authority_processor_mismatch");
  if (authority.requestId !== manifest.requestId) reasons.push("processor_authority_request_mismatch");
  if (authority.serviceType !== manifest.request.serviceType) reasons.push("processor_authority_service_mismatch");
  if (authority.reviewId !== manifest.review?.reviewId) reasons.push("processor_authority_review_mismatch");
  if (authority.workflowInstanceId !== manifest.workflow?.instanceId) reasons.push("processor_authority_workflow_mismatch");
  if (authority.localExecutionOnly !== true) reasons.push("processor_authority_not_local_only");
  if (authority.publicationAuthorized !== false) reasons.push("processor_authority_publication_scope_invalid");
  if (authority.externalProviderEgressAuthorized !== false) reasons.push("processor_authority_provider_scope_invalid");
  if (!sameActions(authority, route)) reasons.push("processor_authority_actions_mismatch");
  if (!sameEvidenceBindings(manifest, authority)) reasons.push("processor_authority_evidence_binding_mismatch");
  if (!Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= nowMs) reasons.push("processor_authority_expired");
  if (eventPayload.authorityId !== authority.authorityId) reasons.push("processor_event_authority_mismatch");
  if (eventPayload.processorId !== authority.processorId) reasons.push("processor_event_processor_mismatch");
  if (eventPayload.reviewId !== authority.reviewId) reasons.push("processor_event_review_mismatch");
  if (manifest.controls.processingAuthorized !== true) reasons.push("processing_authority_not_active");
  if (manifest.controls.publicationAuthorized !== false) reasons.push("publication_authority_must_remain_gated");
  if (manifest.controls.externalProviderEgressAuthorized !== false) reasons.push("external_provider_egress_must_remain_gated");
  return reasons;
}

export function buildProcessorAuthorityEnvelope(
  manifest: WorkRequestManifest,
  route: ProcessorRoute,
  operatorEmail: string,
  note: string,
  ttlMs = 60 * 60 * 1000,
): ProcessorAuthorityEnvelope {
  if (!manifest.review?.reviewId || !manifest.workflow?.instanceId) throw new Error("processor_authority_requires_bound_review_and_workflow");
  const grantedAt = new Date().toISOString();
  return {
    schema: "tmg.processor-authority.v1",
    authorityId: `pa_${crypto.randomUUID()}`,
    processorId: route.processorId,
    state: "authorized",
    requestId: manifest.requestId,
    serviceType: manifest.request.serviceType,
    reviewId: manifest.review.reviewId,
    workflowInstanceId: manifest.workflow.instanceId,
    grantedBy: operatorEmail,
    grantedAt,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    localExecutionOnly: true,
    publicationAuthorized: false,
    externalProviderEgressAuthorized: false,
    allowedActions: [...route.allowedActions],
    evidenceBindings: manifest.files.map((file) => ({
      fileId: file.fileId,
      sha256: file.sha256,
      size: file.size,
    })),
    note,
  };
}

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder("ascii").decode(bytes.slice(start, end));
}

function detectFormat(bytes: Uint8Array): { format: string; mime: string | null; detail: string } {
  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return { format: "jpeg", mime: "image/jpeg", detail: "JPEG SOI signature" };
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { format: "png", mime: "image/png", detail: "PNG signature" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { format: "webp", mime: "image/webp", detail: "RIFF/WEBP signature" };
  if (ascii(bytes, 0, 5) === "%PDF-") return { format: "pdf", mime: "application/pdf", detail: "PDF header" };
  if (bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { format: "zip-container", mime: null, detail: "ZIP container signature" };
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    return brand === "qt  "
      ? { format: "quicktime", mime: "video/quicktime", detail: `ISO BMFF ftyp brand ${brand.trim() || "qt"}` }
      : { format: "iso-bmff", mime: "video/mp4", detail: `ISO BMFF ftyp brand ${brand.trim() || "unknown"}` };
  }
  return { format: "unknown", mime: null, detail: "No recognized bounded signature in first 64 bytes" };
}

function mediaMime(type: string): boolean {
  return type.startsWith("image/") || type.startsWith("video/");
}

function mimeCompatible(claimed: string, detected: string | null, format: string): boolean | null {
  if (!detected) {
    if (claimed === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && format === "zip-container") return true;
    return null;
  }
  if (claimed === detected) return true;
  if (claimed === "video/quicktime" && detected === "video/mp4") return true;
  if (claimed === "video/mp4" && detected === "video/quicktime") return true;
  return false;
}

async function inspectMedia(env: Pick<ReviewEnv, "WORK_REQUESTS">, manifest: WorkRequestManifest): Promise<ProcessorExecutionResult> {
  const mediaFiles = manifest.files.filter((file) => mediaMime(file.type));
  const observations: Array<Record<string, unknown>> = [];
  let mismatches = 0;
  let unknown = 0;

  for (const file of mediaFiles) {
    const length = Math.min(file.size, 64);
    const object = await env.WORK_REQUESTS.get(file.objectKey, { range: { offset: 0, length } });
    if (!object) {
      mismatches += 1;
      observations.push({ fileId: file.fileId, name: file.name, claimedMime: file.type, status: "missing" });
      continue;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const detected = detectFormat(bytes);
    const compatible = mimeCompatible(file.type, detected.mime, detected.format);
    if (compatible === false) mismatches += 1;
    if (compatible === null) unknown += 1;
    observations.push({
      fileId: file.fileId,
      name: file.name,
      claimedMime: file.type,
      detectedFormat: detected.format,
      detectedMime: detected.mime,
      signatureStatus: compatible === true ? "verified" : compatible === false ? "mismatch" : "unresolved",
      detail: detected.detail,
      inspectedBytes: bytes.byteLength,
    });
  }

  if (mediaFiles.length === 0) {
    return {
      processorId: "media-inspection",
      status: "action_required",
      progress: 90,
      headline: "Local media inspection needs media evidence",
      summary: "The authorized local adapter found no image or video object in the approved evidence envelope.",
      nextAction: "Attach an approved image/video object or route the request to a different governed processor.",
      confidence: "system_verified",
      evidence: [{ label: "Media objects inspected", value: "0" }],
      deliverables: [{ label: "Local media inspection record", status: "needs_evidence" }],
      details: { observations },
    };
  }

  const issueCount = mismatches + unknown;
  return {
    processorId: "media-inspection",
    status: "action_required",
    progress: issueCount ? 92 : 94,
    headline: issueCount ? "Local media inspection completed with review findings" : "Local media inspection completed",
    summary: issueCount
      ? `The local adapter inspected ${mediaFiles.length} media object(s); ${mismatches} signature mismatch(es) and ${unknown} unresolved signature(s) require human review.`
      : `The local adapter inspected ${mediaFiles.length} media object(s) and found no bounded MIME/signature conflicts. No codec execution, publication, or provider egress occurred.`,
    nextAction: issueCount
      ? "Resolve media-format findings before authorizing any downstream processor or derivative recipe."
      : "Select and separately authorize the next governed media processor or record the inspection outcome.",
    confidence: "system_verified",
    evidence: [
      { label: "Media objects inspected", value: String(mediaFiles.length) },
      { label: "Signature mismatches", value: String(mismatches) },
      { label: "Unresolved signatures", value: String(unknown) },
      { label: "Execution boundary", value: "local-only; first 64 bytes; no codec/provider egress" },
    ],
    deliverables: [{ label: "Local media inspection record", status: "complete" }],
    details: { observations },
  };
}

function assessRightsProvenance(manifest: WorkRequestManifest): ProcessorExecutionResult {
  const uploaded = manifest.files.filter((file) => file.status === "uploaded");
  const allShaBound = uploaded.length === manifest.files.length && uploaded.every((file) => /^[a-f0-9]{64}$/i.test(file.sha256));
  const humanReviewApproved = manifest.review?.state === "approved";
  const attestationsPresent = manifest.rights.authorizedToShare === true && manifest.rights.humanReviewAcknowledged === true;
  const structurallyComplete = uploaded.length > 0 && allShaBound && humanReviewApproved && attestationsPresent;

  return {
    processorId: "rights-provenance",
    status: "action_required",
    progress: structurallyComplete ? 94 : 90,
    headline: structurallyComplete ? "Rights/provenance evidence package structurally verified" : "Rights/provenance evidence package needs review",
    summary: structurallyComplete
      ? `The authorized local adapter verified ${uploaded.length} evidence object(s), exact SHA-bound manifest references, requester sharing attestation, and an approved human review record. This is a structural provenance check, not a legal sufficiency determination.`
      : "The local adapter could not establish a structurally complete rights/provenance evidence package under the granted processor envelope.",
    nextAction: structurallyComplete
      ? "A human rights reviewer must determine legal/contractual sufficiency and permitted-use scope before any downstream publication or external use."
      : "Reconcile missing attestations, review authority, or evidence bindings before a human rights sufficiency decision.",
    confidence: structurallyComplete ? "system_verified" : "human_review_required",
    evidence: [
      { label: "Evidence objects", value: String(uploaded.length) },
      { label: "SHA-bound evidence", value: allShaBound ? "yes" : "no" },
      { label: "Sharing attestation", value: attestationsPresent ? "present" : "missing" },
      { label: "Human scope review", value: humanReviewApproved ? "approved" : "not approved" },
      { label: "Legal sufficiency", value: "not determined by automated adapter" },
    ],
    deliverables: [{ label: "Rights/provenance structural verification record", status: structurallyComplete ? "complete" : "needs_review" }],
    details: {
      structurallyComplete,
      evidenceBindings: uploaded.map((file) => ({ fileId: file.fileId, sha256: file.sha256, size: file.size })),
    },
  };
}

export async function executeAuthorizedProcessor(
  env: Pick<ReviewEnv, "WORK_REQUESTS">,
  manifest: WorkRequestManifest,
  route: ProcessorRoute,
): Promise<ProcessorExecutionResult> {
  if (route.processorId === "rights-provenance") return assessRightsProvenance(manifest);
  if (route.processorId === "media-inspection") return inspectMedia(env, manifest);
  throw new Error(`processor_adapter_not_bound:${route.processorId}`);
}
