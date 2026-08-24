import { describe, expect, it } from "vitest";
import { buildMarketingDiscoveryPlan } from "../src/marketing-context";
import {
  checklistTemplate,
  compileProductionPlan,
  normalizeChecklistReferenceValue,
  type ProductionChecklistItem,
  type ProductionRequestSnapshot,
} from "../src/production-request";

const now = "2026-08-24T18:30:00.000Z";

function completedItem(
  kind: ProductionChecklistItem["kind"],
  referenceValue?: string,
): ProductionChecklistItem {
  const template = checklistTemplate().find((item) => item.kind === kind);
  if (!template) throw new Error(`missing checklist template for ${kind}`);
  return {
    itemId: kind,
    kind,
    label: template.label,
    description: template.description,
    required: template.required,
    acceptsUploads: template.acceptsUploads,
    acceptsReference: template.acceptsReference,
    allowsMultiple: template.allowsMultiple,
    status: "completed",
    ...(referenceValue ? { referenceValue } : {}),
    artifacts: [],
    updatedAt: now,
  };
}

function marketingSnapshot(): ProductionRequestSnapshot {
  const targets = normalizeChecklistReferenceValue("distribution_targets", {
    targets: [
      { platform: "youtube", surface: "shorts", usage: "organic" },
      { platform: "tiktok", surface: "organic", usage: "organic" },
      { platform: "website", surface: "hero_video", usage: "owned_media" },
    ],
  });
  const source = normalizeChecklistReferenceValue("source_media", {
    type: "web_app",
    url: "https://example.com/app",
    authorization: {
      authorizedByRequester: true,
      assetReuseAuthorized: false,
      authenticatedCrawlAuthorized: false,
    },
    crawlScope: {
      includePaths: ["/app", "/features", "/pricing"],
      excludePaths: ["/admin"],
      allowSubdomains: false,
      maxPages: 40,
      maxDiscoveryDepth: 2,
    },
  });

  return {
    schemaVersion: "tmg.production-request.v1",
    requestId: "request-1",
    tenantId: "customer_1",
    title: "Launch campaign",
    status: "ready",
    deliverables: ["campaign_plan", "branded_marketing_videos", "social_copy"],
    checklist: [
      completedItem("project_brief", "Launch the new web app."),
      completedItem("source_media", source),
      completedItem("rights_evidence", "rights://customer-1/site-assets/v1"),
      completedItem("distribution_targets", targets),
      { ...completedItem("brand_assets"), status: "pending" },
      { ...completedItem("reference_media"), status: "pending" },
      { ...completedItem("delivery_preferences"), status: "pending" },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

describe("TMG production intake marketing model", () => {
  it("makes distribution targets a required checklist item", () => {
    const targets = checklistTemplate().find((item) => item.kind === "distribution_targets");
    expect(targets?.required).toBe(true);
    expect(targets?.acceptsReference).toBe(true);
    expect(targets?.acceptsUploads).toBe(false);
  });

  it("compiles a marketing campaign with target-specific deliverables", () => {
    const plan = compileProductionPlan(marketingSnapshot(), now);
    expect(plan.distributionTargets).toHaveLength(3);
    expect(plan.marketingCampaign?.requested).toBe(true);
    expect(plan.marketingCampaign?.contextSources[0]?.url).toBe("https://example.com/app");
    expect(plan.deliverables[1]?.skill).toBe("campaign_video_generation");
    expect(plan.deliverables[1]?.targets).toHaveLength(3);
    expect(plan.governance.publicationAuthority).toBe(false);
    expect(plan.governance.externalDistributionAuthority).toBe(false);
  });

  it("builds a bounded Firecrawl discovery plan that respects robots.txt", () => {
    const plan = compileProductionPlan(marketingSnapshot(), now);
    const discovery = buildMarketingDiscoveryPlan(plan);
    expect(discovery).not.toBeNull();
    expect(discovery?.sources[0]?.provider).toBe("firecrawl_v2");
    expect(discovery?.sources[0]?.request.limit).toBe(40);
    expect(discovery?.sources[0]?.request.allowExternalLinks).toBe(false);
    expect(discovery?.sources[0]?.request.ignoreRobotsTxt).toBe(false);
    expect(discovery?.sources[0]?.assetReuse.authorizedByRequester).toBe(false);
    expect(discovery?.governance.discoveredAssetReuseRequiresRightsEvidence).toBe(true);
  });

  it("rejects insecure website/app context URLs", () => {
    expect(() => normalizeChecklistReferenceValue("source_media", {
      type: "website",
      url: "http://example.com",
      authorization: {
        authorizedByRequester: true,
        assetReuseAuthorized: false,
        authenticatedCrawlAuthorized: false,
      },
    })).toThrow(/HTTPS/);
  });

  it("allows a neutral general-purpose master destination", () => {
    const encoded = normalizeChecklistReferenceValue("distribution_targets", {
      targets: [{ platform: "general_master", surface: "master", usage: "undecided" }],
    });
    expect(JSON.parse(encoded).targets[0].platform).toBe("general_master");
  });
});
