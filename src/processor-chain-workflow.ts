import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  appendEvent,
  loadManifest,
  validRequestId,
  workflowOf,
  writeManifest,
  type ReviewEnv,
} from "./work-review-core";
import {
  buildDerivativeAuthority,
  chainOf,
  evidenceBindingsSha256,
  setChain,
  sourceMediaFile,
  validateDerivativeAuthority,
  validateReceiptSha,
  validateTechnicalAuthority,
  withReceiptSha,
  type DerivativeAuthorityEvent,
  type DerivativeOutput,
  type DerivativeReceipt,
  type ProcessorChainDispatch,
  type RightsVerdictEvent,
  type TechnicalAuthorityEvent,
  type TechnicalInspectionReceipt,
} from "./processor-chain-core";

type TechnicalContainerResult = {
  schema: "tmg.technical-inspection.v1";
  fileId: string;
  probeSucceeded: boolean;
  decodeSucceeded: boolean;
  decodeExitCode: number;
  format: Record<string, unknown>;
  streams: Array<Record<string, unknown>>;
  corruptionSignals: string[];
  toolchain: Record<string, unknown>;
};

type DerivativeContainerResult = {
  schema: "tmg.derivative-execution.v1";
  fileId: string;
  recipeId: string;
  outputs: DerivativeOutput[];
};

async function containerJson(env: ReviewEnv, instanceName: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const stub = env.MEDIA_EXECUTOR.getByName(instanceName);
  const response = await stub.fetch(new Request(`http://media-executor${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  }));
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`media_executor_${response.status}:${String(payload.error ?? "unknown_error")}`);
  return payload;
}

function setCustomerState(manifest: Awaited<ReturnType<typeof loadManifest>> & object, input: {
  progress: number;
  headline: string;
  summary: string;
  processorState: string;
  dispatchState?: string;
}): void {
  const workflow = workflowOf(manifest as never);
  workflow.phase = "action_required";
  workflow.progress = input.progress;
  workflow.headline = input.headline;
  workflow.summary = input.summary;
  workflow.processorState = input.processorState;
  workflow.dispatchState = input.dispatchState ?? "checkpoint";
}

export class ProcessorChainWorkflow extends WorkflowEntrypoint<ReviewEnv, ProcessorChainDispatch> {
  async run(event: WorkflowEvent<ProcessorChainDispatch>, step: WorkflowStep): Promise<{ requestId: string; status: string; chainId: string }> {
    const payload = event.payload;
    if (!payload || !validRequestId(payload.requestId) || !payload.reviewId || !payload.chainId || !payload.chainInstanceId) {
      throw new Error("invalid_processor_chain_payload");
    }
    if (event.instanceId !== payload.chainInstanceId) throw new Error("processor_chain_instance_binding_mismatch");

    const sourceJson = await step.do("validate processor chain prerequisites", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      if (manifest.status !== "action_required" || manifest.controls.processingAuthorized !== true) throw new Error("processor_chain_requires_active_processing_checkpoint");
      if (manifest.controls.publicationAuthorized || manifest.controls.externalProviderEgressAuthorized) throw new Error("processor_chain_initial_scope_too_broad");
      if (manifest.review?.state !== "approved" || manifest.review.reviewId !== payload.reviewId) throw new Error("processor_chain_review_mismatch");
      const initialReceipt = workflowOf(manifest).processorResults?.["media-inspection"];
      if (!initialReceipt || initialReceipt.schema !== "tmg.processor-result.v1") throw new Error("media_inspection_receipt_required");
      const chain = chainOf(manifest);
      if (!chain || chain.chainId !== payload.chainId || chain.instanceId !== payload.chainInstanceId || chain.state !== "requested") throw new Error("processor_chain_manifest_binding_mismatch");
      const source = sourceMediaFile(manifest);
      if (!source) throw new Error("processor_chain_media_source_required");

      chain.state = "waiting_technical_authority";
      setChain(manifest, chain);
      setCustomerState(manifest, {
        progress: 95,
        headline: "Deep technical inspection requires authority",
        summary: "The preliminary media signature inspection passed into Processor Chain v1.1. Full ffprobe metadata inspection and FFmpeg decode are waiting on exact processor authority.",
        processorState: "technical_authority_required",
        dispatchState: "waiting_for_technical_authority",
      });
      appendEvent(manifest, {
        phase: "authorization",
        state: "required",
        title: "Deep technical-inspection authority required",
        detail: "No codec decode or FFmpeg execution has occurred in Processor Chain v1.1 yet.",
      });
      await writeManifest(this.env, manifest);
      return JSON.stringify({ fileId: source.fileId, objectKey: source.objectKey, name: source.name, mime: source.type, sha256: source.sha256, size: source.size });
    });
    const source = JSON.parse(sourceJson) as { fileId: string; objectKey: string; name: string; mime: string; sha256: string; size: number };

    const technicalEvent = (await step.waitForEvent<TechnicalAuthorityEvent>(
      "wait for technical inspection authority",
      { type: "technical-authorized", timeout: "7 days" },
    )).payload;

    const technicalAllowed = await step.do("validate technical inspection authority", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      const chain = chainOf(manifest);
      if (!chain) throw new Error("processor_chain_missing");
      const authority = chain.technicalAuthority;
      const reasons = await validateTechnicalAuthority(manifest, chain, authority, technicalEvent);
      if (reasons.length || !authority) {
        chain.state = "failed";
        setChain(manifest, chain);
        setCustomerState(manifest, {
          progress: 95,
          headline: "Technical inspection authority rejected",
          summary: reasons.join(", ") || "Technical authority was missing.",
          processorState: "technical_authority_rejected",
        });
        appendEvent(manifest, { phase: "authorization", state: "rejected", title: "Technical inspection authority rejected", detail: reasons.join(", ") });
        await writeManifest(this.env, manifest);
        return false;
      }
      authority.state = "consumed";
      authority.consumedAt = new Date().toISOString();
      chain.state = "technical_processing";
      setChain(manifest, chain);
      const workflow = workflowOf(manifest);
      workflow.phase = "processing";
      workflow.progress = 96;
      workflow.processorId = "technical-inspection";
      workflow.processorState = "ffmpeg_decode_running";
      workflow.dispatchState = "running";
      workflow.headline = "Deep local media inspection running";
      workflow.summary = "The internet-disabled media container is running ffprobe and FFmpeg decode against the exact authorized R2 evidence object.";
      appendEvent(manifest, { phase: "processing", state: "active", title: "FFmpeg technical inspection started", detail: `Authority ${authority.authorityId} consumed for ${source.fileId}.` });
      await writeManifest(this.env, manifest);
      return true;
    });
    if (!technicalAllowed) return { requestId: payload.requestId, status: "action_required", chainId: payload.chainId };

    const technicalResultJson = await step.do("run ffprobe and full FFmpeg decode", async () => {
      const result = await containerJson(this.env, payload.requestId, "/technical-inspection", {
        inputKey: source.objectKey,
        fileId: source.fileId,
        name: source.name,
        mime: source.mime,
      });
      return JSON.stringify(result);
    });
    const technicalResult = JSON.parse(technicalResultJson) as TechnicalContainerResult;

    const technicalReceiptJson = await step.do("record immutable technical inspection receipt", async () => {
      if (technicalResult.schema !== "tmg.technical-inspection.v1" || technicalResult.fileId !== source.fileId) throw new Error("technical_inspection_result_contract_invalid");
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest || !manifest.review?.reviewId) throw new Error("work_request_or_review_missing");
      const chain = chainOf(manifest);
      if (!chain) throw new Error("processor_chain_missing");
      const receiptBase = {
        schema: "tmg.technical-inspection-receipt.v1" as const,
        receiptId: `tir_${crypto.randomUUID()}`,
        processorId: "technical-inspection" as const,
        requestId: manifest.requestId,
        reviewId: manifest.review.reviewId,
        chainInstanceId: chain.instanceId,
        fileId: source.fileId,
        sourceSha256: source.sha256,
        sourceSize: source.size,
        executedAt: new Date().toISOString(),
        probeSucceeded: technicalResult.probeSucceeded === true,
        decodeSucceeded: technicalResult.decodeSucceeded === true,
        decodeExitCode: Number(technicalResult.decodeExitCode),
        format: technicalResult.format ?? {},
        streams: Array.isArray(technicalResult.streams) ? technicalResult.streams : [],
        corruptionSignals: Array.isArray(technicalResult.corruptionSignals) ? technicalResult.corruptionSignals.slice(0, 24) : [],
        toolchain: technicalResult.toolchain ?? {},
      };
      const receipt = await withReceiptSha<TechnicalInspectionReceipt>(receiptBase as Omit<TechnicalInspectionReceipt, "receiptSha256">);
      chain.technicalReceipt = receipt;
      if (!receipt.probeSucceeded || !receipt.decodeSucceeded) {
        chain.state = "failed";
        setChain(manifest, chain);
        setCustomerState(manifest, {
          progress: 96,
          headline: "Deep technical inspection found blocking media errors",
          summary: `ffprobe success=${receipt.probeSucceeded}; full decode success=${receipt.decodeSucceeded}. Derivative processing remains blocked.`,
          processorState: "technical_inspection_failed",
        });
        appendEvent(manifest, { phase: "processing", state: "failed_safe", title: "Technical media inspection blocked the chain", detail: receipt.corruptionSignals.join(" | ").slice(0, 480) });
      } else {
        chain.state = "waiting_rights_verdict";
        setChain(manifest, chain);
        setCustomerState(manifest, {
          progress: 97,
          headline: "Technical inspection passed; human rights verdict required",
          summary: "Container/stream metadata and full FFmpeg decode completed successfully. A human reviewer must now determine rights sufficiency and permitted-use scope.",
          processorState: "rights_sufficiency_required",
          dispatchState: "waiting_for_rights_verdict",
        });
        appendEvent(manifest, { phase: "processing", state: "complete", title: "Deep technical inspection completed", detail: `${receipt.streams.length} stream(s); decode completed without a blocking corruption signal.` });
        appendEvent(manifest, { phase: "human_review", state: "required", title: "Human rights sufficiency verdict required", detail: "Derivative execution cannot be authorized until the verdict is sufficient and its permitted-use scope covers the requested recipe." });
      }
      await writeManifest(this.env, manifest);
      return JSON.stringify(receipt);
    });
    const technicalReceipt = JSON.parse(technicalReceiptJson) as TechnicalInspectionReceipt;
    if (!technicalReceipt.probeSucceeded || !technicalReceipt.decodeSucceeded) return { requestId: payload.requestId, status: "action_required", chainId: payload.chainId };

    const rightsEvent = (await step.waitForEvent<RightsVerdictEvent>(
      "wait for human rights sufficiency verdict",
      { type: "rights-verdict-recorded", timeout: "7 days" },
    )).payload;

    const rightsAllowed = await step.do("validate human rights sufficiency receipt", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      const chain = chainOf(manifest);
      if (!chain?.rightsVerdict || !chain.technicalReceipt) throw new Error("rights_verdict_missing");
      const verdict = chain.rightsVerdict;
      const reasons: string[] = [];
      if (rightsEvent.verdictId !== verdict.verdictId || rightsEvent.requestId !== manifest.requestId || rightsEvent.reviewId !== manifest.review?.reviewId) reasons.push("rights_verdict_event_mismatch");
      if (!(await validateReceiptSha(verdict as unknown as Record<string, unknown>))) reasons.push("rights_verdict_receipt_hash_invalid");
      if (verdict.technicalReceiptSha256 !== chain.technicalReceipt.receiptSha256) reasons.push("rights_verdict_technical_receipt_mismatch");
      if (verdict.evidenceBindingsSha256 !== await evidenceBindingsSha256(manifest.files)) reasons.push("rights_verdict_evidence_drift");
      if (verdict.chainInstanceId !== chain.instanceId || verdict.reviewId !== manifest.review?.reviewId) reasons.push("rights_verdict_binding_mismatch");
      if (verdict.expiresAt && Date.parse(verdict.expiresAt) <= Date.now()) reasons.push("rights_verdict_expired");
      if (verdict.state !== "sufficient") reasons.push(`rights_verdict_${verdict.state}`);

      if (reasons.length) {
        chain.state = "rights_blocked";
        setChain(manifest, chain);
        setCustomerState(manifest, {
          progress: 97,
          headline: "Rights sufficiency blocks derivative processing",
          summary: reasons.join(", "),
          processorState: "rights_blocked",
        });
        appendEvent(manifest, { phase: "human_review", state: "blocked", title: "Rights sufficiency did not authorize derivative processing", detail: verdict.note });
        await writeManifest(this.env, manifest);
        return false;
      }

      chain.state = "waiting_derivative_authority";
      setChain(manifest, chain);
      setCustomerState(manifest, {
        progress: 98,
        headline: "Rights sufficient; derivative recipe authority required",
        summary: "The human rights verdict is cryptographically bound to the technical receipt and evidence inventory. A specific derivative recipe must now be selected and separately authorized.",
        processorState: "derivative_authority_required",
        dispatchState: "waiting_for_derivative_authority",
      });
      appendEvent(manifest, { phase: "authorization", state: "required", title: "Derivative recipe authority required", detail: `Permitted uses: ${verdict.permittedUses.join(", ") || "none"}.` });
      await writeManifest(this.env, manifest);
      return true;
    });
    if (!rightsAllowed) return { requestId: payload.requestId, status: "action_required", chainId: payload.chainId };

    const derivativeEvent = (await step.waitForEvent<DerivativeAuthorityEvent>(
      "wait for derivative recipe authority",
      { type: "derivative-authorized", timeout: "7 days" },
    )).payload;

    const derivativeAllowed = await step.do("validate derivative recipe authority", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      const chain = chainOf(manifest);
      if (!chain) throw new Error("processor_chain_missing");
      const authority = chain.derivativeAuthority;
      const reasons = await validateDerivativeAuthority(manifest, chain, authority, derivativeEvent);
      if (reasons.length || !authority) {
        chain.state = "failed";
        setChain(manifest, chain);
        setCustomerState(manifest, {
          progress: 98,
          headline: "Derivative recipe authority rejected",
          summary: reasons.join(", ") || "Derivative authority missing.",
          processorState: "derivative_authority_rejected",
        });
        appendEvent(manifest, { phase: "authorization", state: "rejected", title: "Derivative recipe authority rejected", detail: reasons.join(", ") });
        await writeManifest(this.env, manifest);
        return false;
      }
      authority.state = "consumed";
      authority.consumedAt = new Date().toISOString();
      chain.state = "derivative_processing";
      setChain(manifest, chain);
      const workflow = workflowOf(manifest);
      workflow.phase = "processing";
      workflow.progress = 99;
      workflow.processorId = "derivative";
      workflow.processorState = "ffmpeg_derivative_running";
      workflow.dispatchState = "running";
      workflow.headline = `${authority.recipeId} derivative execution running`;
      workflow.summary = "The internet-disabled FFmpeg container is executing only the exact recipe permitted by the rights verdict and derivative authority receipt.";
      appendEvent(manifest, { phase: "processing", state: "active", title: "Authorized derivative recipe started", detail: `${authority.recipeId}; publication=false; provider egress=false.` });
      await writeManifest(this.env, manifest);
      return true;
    });
    if (!derivativeAllowed) return { requestId: payload.requestId, status: "action_required", chainId: payload.chainId };

    const derivativeResultJson = await step.do("execute authorized FFmpeg derivative recipe", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      const chain = manifest ? chainOf(manifest) : null;
      if (!manifest || !chain?.derivativeAuthority) throw new Error("derivative_authority_missing_before_execution");
      const authority = chain.derivativeAuthority;
      const result = await containerJson(this.env, payload.requestId, "/derivative", {
        inputKey: source.objectKey,
        fileId: source.fileId,
        recipeId: authority.recipeId,
        outputPrefix: authority.outputPrefix,
      });
      return JSON.stringify(result);
    });
    const derivativeResult = JSON.parse(derivativeResultJson) as DerivativeContainerResult;

    await step.do("verify derivatives and record immutable derivative receipt", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest || !manifest.review?.reviewId) throw new Error("work_request_or_review_missing");
      const chain = chainOf(manifest);
      if (!chain?.technicalReceipt || !chain.rightsVerdict || !chain.derivativeAuthority) throw new Error("derivative_upstream_receipts_missing");
      const authority = chain.derivativeAuthority;
      if (derivativeResult.schema !== "tmg.derivative-execution.v1" || derivativeResult.fileId !== source.fileId || derivativeResult.recipeId !== authority.recipeId) throw new Error("derivative_result_contract_invalid");
      if (!Array.isArray(derivativeResult.outputs) || !derivativeResult.outputs.length) throw new Error("derivative_outputs_missing");

      for (const output of derivativeResult.outputs) {
        if (!output.key.startsWith(`${authority.outputPrefix}/`) || !/^[a-f0-9]{64}$/i.test(output.sha256) || !Number.isFinite(output.size) || output.size <= 0) throw new Error("derivative_output_binding_invalid");
        const object = await this.env.DERIVATIVES.head(output.key);
        if (!object || object.size !== output.size || object.customMetadata?.sha256?.toLowerCase() !== output.sha256.toLowerCase()) throw new Error(`derivative_output_integrity_failed:${output.key}`);
      }

      const receiptBase = {
        schema: "tmg.derivative-receipt.v1" as const,
        receiptId: `dr_${crypto.randomUUID()}`,
        requestId: manifest.requestId,
        reviewId: manifest.review.reviewId,
        chainInstanceId: chain.instanceId,
        recipeId: authority.recipeId,
        authorityId: authority.authorityId,
        sourceFileId: source.fileId,
        sourceSha256: source.sha256,
        technicalReceiptSha256: chain.technicalReceipt.receiptSha256,
        rightsVerdictSha256: chain.rightsVerdict.receiptSha256,
        outputs: derivativeResult.outputs,
        executedAt: new Date().toISOString(),
      };
      const receipt = await withReceiptSha<DerivativeReceipt>(receiptBase as Omit<DerivativeReceipt, "receiptSha256">);
      chain.derivativeReceipt = receipt;
      chain.state = "derivative_complete";
      setChain(manifest, chain);
      manifest.status = "action_required";
      const workflow = workflowOf(manifest);
      workflow.phase = "action_required";
      workflow.progress = 99;
      workflow.processorId = "derivative";
      workflow.processorState = "derivative_complete_private";
      workflow.dispatchState = "checkpoint";
      workflow.headline = "Authorized private derivative recipe completed";
      workflow.summary = `${receipt.outputs.length} derivative object(s) were created in private R2 and integrity-bound to the technical inspection and human rights verdict. Nothing was published and no external provider was contacted.`;
      workflow.outcome = {
        status: "action_required",
        headline: "Processor Chain v1.1 completed private derivative generation",
        summary: workflow.summary,
        nextAction: "Review the private derivative receipt. Publication and external-provider use require separate authority and remain disabled by production policy.",
        confidence: "system_verified",
        evidence: [
          { label: "Technical receipt", value: chain.technicalReceipt.receiptSha256 },
          { label: "Rights verdict", value: chain.rightsVerdict.receiptSha256 },
          { label: "Derivative receipt", value: receipt.receiptSha256 },
          { label: "Recipe", value: receipt.recipeId },
          { label: "Private outputs", value: String(receipt.outputs.length) },
        ],
        deliverables: receipt.outputs.map((output) => ({ label: output.key.split("/").pop() ?? "derivative", status: "private_complete" })),
      };
      appendEvent(manifest, { phase: "processing", state: "complete", title: "FFmpeg derivative recipe completed", detail: `${receipt.outputs.length} private object(s) created with R2 SHA-256 verification.` });
      appendEvent(manifest, { phase: "action_required", state: "checkpoint", title: "Publication and provider egress remain separately gated", detail: "No public release or external provider call occurred." });
      await writeManifest(this.env, manifest);
    });

    return { requestId: payload.requestId, status: "action_required", chainId: payload.chainId };
  }
}
