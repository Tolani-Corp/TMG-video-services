import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  appendEvent,
  loadManifest,
  processorRoute,
  validRequestId,
  workflowOf,
  writeManifest,
  type DispatchPayload,
  type ReviewEnv,
} from "./work-review-core";

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
    await step.do("record processor routing checkpoint", async () => {
      const manifest = await loadManifest(this.env, payload.requestId);
      if (!manifest) throw new Error("work_request_not_found");
      manifest.status = "action_required";
      const workflow = workflowOf(manifest);
      workflow.dispatchState = "checkpoint";
      workflow.phase = "action_required";
      workflow.progress = 82;
      workflow.headline = "Authorized evidence intake verified";
      workflow.summary = "TMG verified the approved quarantine evidence and resolved the governed service route. The specialized processor remains separately gated.";
      workflow.processorId = route.processorId;
      workflow.processorState = route.state;
      workflow.outcome = {
        status: "action_required",
        headline: "Evidence verified; processor authorization checkpoint",
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
        state: "checkpoint",
        title: "Specialized processor checkpoint reached",
        detail: route.nextAction,
      });
      await writeManifest(this.env, manifest);
    });

    return { requestId: payload.requestId, status: "action_required", processorId: route.processorId };
  }
}
