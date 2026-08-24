import { describe, expect, it } from "vitest";
import {
  checklistTemplate,
  compileProductionPlan,
  productionInputObjectKey,
  requiredChecklistSatisfied,
  safeUploadFileName,
  type ProductionChecklistItem,
  type ProductionRequestSnapshot,
} from "../src/production-request";

const now = "2026-08-24T18:00:00.000Z";

function checklist(statusForRequired: "pending" | "completed"): ProductionChecklistItem[] {
  return checklistTemplate().map((item) => ({
    itemId: item.kind,
    kind: item.kind,
    label: item.label,
    description: item.description,
    required: item.required,
    acceptsUploads: item.acceptsUploads,
    acceptsReference: item.acceptsReference,
    allowsMultiple: item.allowsMultiple,
    status: item.required ? statusForRequired : "pending",
    artifacts: item.kind === "source_media" && statusForRequired === "completed"
      ? [{
          artifactId: "artifact-1",
          objectKey: "tenants/acme/production-requests/request-1/inputs/source_media/artifact-1/source.mp4",
          fileName: "source.mp4",
          mimeType: "video/mp4",
          bytes: 1024,
          createdAt: now,
        }]
      : [],
    ...(item.kind === "project_brief" && statusForRequired === "completed"
      ? { referenceValue: "Create a launch package." }
      : {}),
    ...(item.kind === "rights_evidence" && statusForRequired === "completed"
      ? { referenceValue: "rights:acme:launch-2026" }
      : {}),
    updatedAt: now,
  }));
}

function snapshot(status: "draft" | "ready", requiredStatus: "pending" | "completed"): ProductionRequestSnapshot {
  return {
    schemaVersion: "tmg.production-request.v1",
    requestId: "request-1",
    tenantId: "acme",
    title: "Launch video package",
    status,
    deliverables: ["clips", "thumbnails", "captions"],
    checklist: checklist(requiredStatus),
    createdAt: now,
    updatedAt: now,
  };
}

describe("checklist production request", () => {
  it("requires brief, source media, and rights evidence before submission", () => {
    const template = checklistTemplate();
    expect(template.filter((item) => item.required).map((item) => item.kind)).toEqual([
      "project_brief",
      "source_media",
      "rights_evidence",
    ]);
    expect(requiredChecklistSatisfied(snapshot("draft", "pending"))).toBe(false);
  });

  it("compiles a rights-aware production plan only from a ready checklist", () => {
    const ready = snapshot("ready", "completed");
    const plan = compileProductionPlan(ready, now);

    expect(plan.deliverables.map((item) => item.skill)).toEqual([
      "smart_clip_extraction",
      "thumbnail_generation",
      "caption_generation",
    ]);
    expect(plan.governance).toEqual({
      rightsEvidenceRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
    });
    expect(plan.sourceInputs.find((item) => item.kind === "source_media")?.artifacts).toHaveLength(1);
  });

  it("rejects production-plan compilation when required checklist items are incomplete", () => {
    expect(() => compileProductionPlan(snapshot("draft", "pending"), now)).toThrow(/incomplete/);
  });

  it("builds tenant-scoped object keys and strips unsafe filename characters", () => {
    expect(safeUploadFileName(" ../../Launch clip (final).mp4 ")).toBe("Launch_clip_final_.mp4_");
    expect(
      productionInputObjectKey({
        tenantId: "acme",
        requestId: "request-1",
        itemId: "source_media",
        artifactId: "artifact-1",
        fileName: "../../Launch clip.mp4",
      }),
    ).toBe("tenants/acme/production-requests/request-1/inputs/source_media/artifact-1/Launch_clip.mp4");
  });
});
