import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  appendEvent,
  asRecord,
  loadManifest,
  processorRoute,
  validRequestId,
  workflowOf,
  writeManifest,
  type DispatchPayload,
  type ProcessorAuthorizationEvent,
  type ReviewEnv,
} from "./work-review-core";
import { executeAuthorizedProcessor, validateProcessorAuthority } from "./processor-authority";

export class WorkRequestProcessingWorkflow extends WorkflowEntrypoint<ReviewEnv, DispatchPayload> {
  async run(event: WorkflowEvent<DispatchPayload>, step: WorkflowStep): Promise<{ requestId: string; status: string; processorId?: string }> {
    const payload = event.payload;
    if (!payload || !validRequestId(payload.requestId) || !payload.reviewId || !payload.reviewerEmail) {
      throw new Error("invalid_work_request_dispatch_payload");
    }

    const serviceType = await step.do("validate approved authority and start processing", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      if (manifest.status !== "approved_for_processing" || manifest.controls.processingAuthorized !== true) {
        throw new Error("processing_authority_not_granted");
      }
      if (manifest.controls.publicationAuthorized || manifest.controls.externalProviderEgressAuthorized) {
        throw new Error("work_request_authority_exceeds_dispatch_envelope");
      }
      if (manifest.review?.state !== "approved" || manifest.review.reviewId !== payload.reviewId) {
        throw new Error("review_authority_mismatch");
      }

      manifest.status = "processing";
      const workflow = workflowOf(manifest);
      workflow.dispatchState = "running";
      workflow.phase = "processing";
      workflow.progress = 65;
      workflow.headline = "Governed processing started";
      workflow.summary = "The durable execution controller is validating the approved evidence inventory and selecting a bounded processor route.";
      appendEvent(manifest, {
        phase: "processing",
        state: "active",
        title: "Durable workflow started",
        detail: `Execution ${event.instanceId} began under review ${payload.reviewId}.`,
      });
      await writeManifest(this.env, manifest);
      return manifest.request.serviceType;
    });

    const inventory = await step.do("verify quarantined evidence inventory", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      const missing: string[] = [];
      let bytes = 0;
      for (const file of manifest.files) {
        const object = await this.env.WORK_REQUESTS.head(file.objectKey);
        if (!object || object.size !== file.size) missing.push(file.fileId);
        else bytes += object.size;
      }
      return { missing, bytes, files: manifest.files.length };
    });

    if (inventory.missing.length) {
      await step.do("record evidence inventory failure", async () => {
        const manifest = await loadManifest(this.env, payload.requestId);
        if (!manifest) return;
        manifest.status = "failed";
        manifest.completedAt = new Date().toISOString();
        manifest.controls.processingAuthorized = false;
        const workflow = workflowOf(manifest);
        workflow.dispatchState = "failed";
        workflow.phase = "failed";
        workflow.progress = 100;
        workflow.outcome = {
          status: "failed",
          headline: "Evidence inventory failed integrity verification",
          summary: `${inventory.missing.length} approved evidence object(s) were missing or had a size mismatch at execution time.`,
          nextAction: "Reconcile quarantine evidence before any new processing authority is considered.",
          confidence: "system_verified",
          evidence: [{ label: "Missing/mismatched objects", value: String(inventory.missing.length) }],
          deliverables: [],
        };
        appendEvent(manifest, {
          phase: "processing",
          state: "failed",
          title: "Evidence inventory verification failed",
          detail: `${inventory.missing.length} object(s) did not match the approved manifest.`,
        });
        await writeManifest(this.env, manifest);
      });
      return { requestId: payload.requestId, status: "failed" };
    }

    const route = processorRoute(serviceType);
    await step.do("record processor authorization checkpoint", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      manifest.status = "action_required";
      const workflow = workflowOf(manifest);
      workflow.dispatchState = route.authorizable ? "waiting_for_processor_authority" : "checkpoint";
      workflow.phase = "action_required";
      workflow.progress = 82;
      workflow.headline = "Authorized evidence intake verified";
      workflow.summary = route.authorizable
        ? `TMG verified the approved quarantine evidence. ${route.processorId} is bound but cannot execute until a processor-specific authority envelope is explicitly granted.`
        : "TMG verified the approved quarantine evidence and resolved the governed service route. The specialized processor remains separately gated.";
      workflow.processorId = route.processorId;
      workflow.processorState = route.state;
      workflow.processorAuthorizationState = route.authorizable ? "required" : "not_available";
      workflow.outcome = {
        status: "action_required",
        headline: route.authorizable ? "Evidence verified; processor authority required" : "Evidence verified; processor authorization checkpoint",
        summary: `The durable workflow verified ${inventory.files} file(s) totaling ${inventory.bytes} bytes and routed the request to ${route.processorId}.`,
        nextAction: route.nextAction,
        confidence: "system_verified",
        evidence: [
          { label: "Evidence objects verified", value: String(inventory.files) },
          { label: "Verified bytes", value: String(inventory.bytes) },
          { label: "Processor route", value: route.processorId },
          { label: "Processor state", value: route.state },
        ],
        deliverables: [{ label: "Governed evidence inventory", status: "complete" }],
      };
      appendEvent(manifest, {
        phase: "processing",
        state: "verified",
        title: "Evidence inventory verified",
        detail: `${inventory.files} approved object(s), ${inventory.bytes} bytes.`,
      });
      appendEvent(manifest, {
        phase: "action_required",
        state: route.authorizable ? "processor_authority_required" : "checkpoint",
        title: route.authorizable ? "Processor-specific authority required" : "Specialized processor checkpoint reached",
        detail: route.nextAction,
      });
      await writeManifest(this.env, manifest);
    });

    if (!route.authorizable) {
      return { requestId: payload.requestId, status: "action_required", processorId: route.processorId };
    }

    let authorizationEvent: ProcessorAuthorizationEvent;
    try {
      authorizationEvent = await step.waitForEvent<ProcessorAuthorizationEvent>(
        "wait for explicit processor authority",
        { type: "processor-authorized", timeout: "7 days" },
      );
    } catch {
      await step.do("record processor authority timeout", async () => {
        const manifest = await loadManifest(this.env, payload.requestId);
        if (!manifest) return;
        manifest.status = "action_required";
        const workflow = workflowOf(manifest);
        workflow.dispatchState = "checkpoint";
        workflow.processorState = "processor_authority_timeout";
        workflow.processorAuthorizationState = "expired_wait";
        workflow.phase = "action_required";
        workflow.progress = 82;
        workflow.headline = "Processor authorization window expired";
        workflow.summary = "The processor did not execute because no valid processor-specific authority event was received during the workflow authorization window.";
        appendEvent(manifest, {
          phase: "action_required",
          state: "authorization_timeout",
          title: "Processor authorization window expired",
          detail: "No processor execution occurred. Re-review and dispatch a new workflow before granting new authority.",
        });
        await writeManifest(this.env, manifest);
      });
      return { requestId: payload.requestId, status: "action_required", processorId: route.processorId };
    }

    const authorityValidation = await step.do("validate processor authority envelope", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      const authority = manifest.processorAuthorizations?.[route.processorId];
      const reasons = validateProcessorAuthority(manifest, route, authority, asRecord(authorizationEvent));
      if (reasons.length) {
        manifest.status = "action_required";
        const workflow = workflowOf(manifest);
        workflow.dispatchState = "checkpoint";
        workflow.processorState = "processor_authority_invalid";
        workflow.processorAuthorizationState = "rejected";
        workflow.phase = "action_required";
        workflow.progress = 82;
        workflow.outcome = {
          status: "action_required",
          headline: "Processor authority rejected",
          summary: "The workflow received a processor event but the manifest-bound authority envelope did not satisfy the exact execution contract.",
          nextAction: "Re-review the request and create a new exact processor authorization. Do not edit or broaden the rejected envelope.",
          confidence: "system_verified",
          evidence: reasons.slice(0, 8).map((reason) => ({ label: "Authority rejection", value: reason })),
          deliverables: [{ label: "Authority validation record", status: "rejected" }],
        };
        appendEvent(manifest, {
          phase: "authorization",
          state: "rejected",
          title: "Processor authority envelope rejected",
          detail: reasons.join(", ").slice(0, 480),
        });
        await writeManifest(this.env, manifest);
        return { allowed: false, authorityId: authority?.authorityId ?? null };
      }

      if (!authority) throw new Error("processor_authority_missing_after_validation");
      authority.state = "consumed";
      authority.consumedAt = new Date().toISOString();
      manifest.status = "processing";
      const workflow = workflowOf(manifest);
      workflow.dispatchState = "running";
      workflow.processorState = "executing_local_adapter";
      workflow.processorAuthorizationState = "consumed";
      workflow.phase = "processing";
      workflow.progress = 86;
      workflow.headline = `${route.processorId} authorized`;
      workflow.summary = "The exact local processor authority envelope was validated against this request, review, workflow instance, and evidence inventory.";
      appendEvent(manifest, {
        phase: "authorization",
        state: "consumed",
        title: "Processor-specific authority validated",
        detail: `${route.processorId} may execute only ${route.allowedActions.join(", ")}; publication and provider egress remain gated.`,
      });
      await writeManifest(this.env, manifest);
      return { allowed: true, authorityId: authority.authorityId };
    });

    if (!authorityValidation.allowed) {
      return { requestId: payload.requestId, status: "action_required", processorId: route.processorId };
    }

    const execution = await step.do("execute authorized local processor adapter", async () => {
      try {
        const manifest = await loadManifest(this.env, payload.requestId);
        if (!manifest) throw new Error("work_request_not_found");
        const result = await executeAuthorizedProcessor(this.env, manifest, route);
        return { ok: true as const, result };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : "unknown_processor_failure" };
      }
    });

    if (!execution.ok) {
      await step.do("record local processor failure", async () => {
        const manifest = await loadManifest(this.env, payload.requestId);
        if (!manifest) return;
        manifest.status = "action_required";
        const workflow = workflowOf(manifest);
        workflow.dispatchState = "checkpoint";
        workflow.processorState = "local_adapter_failed";
        workflow.phase = "action_required";
        workflow.progress = 88;
        workflow.headline = "Authorized local processor needs operator attention";
        workflow.summary = "The processor authority was consumed, but the bounded local adapter did not produce a valid result.";
        workflow.outcome = {
          status: "action_required",
          headline: "Local processor execution failed safely",
          summary: execution.error,
          nextAction: "Inspect the evidence and adapter failure before issuing any new authority. Publication and provider egress remain gated.",
          confidence: "system_verified",
          evidence: [{ label: "Processor", value: route.processorId }],
          deliverables: [{ label: "Local processor result", status: "failed" }],
        };
        appendEvent(manifest, {
          phase: "processing",
          state: "failed_safe",
          title: "Authorized local processor stopped safely",
          detail: execution.error,
        });
        await writeManifest(this.env, manifest);
      });
      return { requestId: payload.requestId, status: "action_required", processorId: route.processorId };
    }

    await step.do("record processor result and return to human checkpoint", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      if (manifest.controls.publicationAuthorized || manifest.controls.externalProviderEgressAuthorized) {
        throw new Error("authority_broadened_during_local_processor_execution");
      }
      const workflow = workflowOf(manifest);
      const results = workflow.processorResults ?? {};
      results[route.processorId] = {
        schema: "tmg.processor-result.v1",
        processorId: route.processorId,
        adapter: route.adapter,
        authorityId: authorityValidation.authorityId,
        executedAt: new Date().toISOString(),
        status: execution.result.status,
        headline: execution.result.headline,
        summary: execution.result.summary,
        confidence: execution.result.confidence,
        details: execution.result.details,
      };
      workflow.processorResults = results;
      manifest.status = "action_required";
      workflow.dispatchState = "checkpoint";
      workflow.processorState = "local_adapter_complete";
      workflow.processorAuthorizationState = "consumed";
      workflow.phase = "action_required";
      workflow.progress = execution.result.progress;
      workflow.headline = execution.result.headline;
      workflow.summary = execution.result.summary;
      workflow.outcome = {
        status: execution.result.status,
        headline: execution.result.headline,
        summary: execution.result.summary,
        nextAction: execution.result.nextAction,
        confidence: execution.result.confidence,
        evidence: execution.result.evidence,
        deliverables: execution.result.deliverables,
      };
      appendEvent(manifest, {
        phase: "processing",
        state: "complete",
        title: `${route.processorId} local adapter completed`,
        detail: execution.result.summary,
      });
      appendEvent(manifest, {
        phase: "action_required",
        state: "checkpoint",
        title: "Processor result returned to human checkpoint",
        detail: execution.result.nextAction,
      });
      await writeManifest(this.env, manifest);
    });

    return { requestId: payload.requestId, status: "action_required", processorId: route.processorId };
  }
}
