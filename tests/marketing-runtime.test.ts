import { afterEach, describe, expect, it, vi } from "vitest";
import { compileCampaignContextManifest } from "../src/campaign-context";
import {
  getMarketingCrawlSnapshot,
  startMarketingCrawl,
} from "../src/firecrawl-marketing-runtime";
import {
  buildMarketingDiscoveryPlan,
  type MarketingDiscoveryPlan,
} from "../src/marketing-context";
import {
  compileMarketingCreativeBrief,
  compileMarketingSocialCopy,
} from "../src/marketing-creative";
import type { ProductionPlan } from "../src/production-request";

const now = "2026-08-24T19:00:00.000Z";

function productionPlan(): ProductionPlan {
  return {
    schemaVersion: "tmg.production-plan.v1",
    requestId: "request-runtime-1",
    tenantId: "acme",
    title: "Acme launch",
    sourceInputs: [
      {
        itemId: "project_brief",
        kind: "project_brief",
        referenceValue: "Launch Acme to product teams.",
        artifacts: [],
      },
      {
        itemId: "source_media",
        kind: "source_media",
        referenceValue: JSON.stringify({
          type: "website",
          url: "https://acme.example/",
          authorization: {
            authorizedByRequester: true,
            assetReuseAuthorized: false,
            authenticatedCrawlAuthorized: false,
          },
          crawlScope: {
            includePaths: [],
            excludePaths: ["/admin"],
            allowSubdomains: false,
            maxPages: 10,
            maxDiscoveryDepth: 1,
          },
        }),
        artifacts: [],
      },
      {
        itemId: "rights_evidence",
        kind: "rights_evidence",
        referenceValue: "rights://acme/site/v1",
        artifacts: [],
      },
      {
        itemId: "distribution_targets",
        kind: "distribution_targets",
        referenceValue: JSON.stringify({ targets: [] }),
        artifacts: [],
      },
    ],
    distributionTargets: [
      { platform: "tiktok", surface: "organic", usage: "organic" },
      { platform: "youtube", surface: "shorts", usage: "organic" },
      { platform: "website", surface: "hero_video", usage: "owned_media" },
    ],
    deliverables: [
      {
        type: "campaign_plan",
        skill: "marketing_campaign_planning",
        targets: [],
        publicationAuthority: false,
      },
      {
        type: "branded_marketing_videos",
        skill: "campaign_video_generation",
        targets: [],
        publicationAuthority: false,
      },
      {
        type: "social_copy",
        skill: "social_copy_generation",
        targets: [],
        publicationAuthority: false,
      },
    ],
    marketingCampaign: {
      requested: true,
      contextSources: [
        {
          type: "website",
          url: "https://acme.example/",
          authorization: {
            authorizedByRequester: true,
            assetReuseAuthorized: false,
            authenticatedCrawlAuthorized: false,
          },
          crawlScope: {
            includePaths: [],
            excludePaths: ["/admin"],
            allowSubdomains: false,
            maxPages: 10,
            maxDiscoveryDepth: 1,
          },
        },
      ],
      crawlAuthorizationRequired: true,
      discoveredAssetReuseRequiresRightsEvidence: true,
    },
    governance: {
      rightsEvidenceRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
      crawlAuthorizationRequired: true,
      discoveredAssetReuseRequiresRightsEvidence: true,
    },
    compiledAt: now,
  };
}

function discoveryPlan(): MarketingDiscoveryPlan {
  const plan = buildMarketingDiscoveryPlan(productionPlan());
  if (!plan) throw new Error("expected marketing discovery plan");
  return plan;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TMG Marketing Runtime v1", () => {
  it("starts and normalizes a governed Firecrawl crawl", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, id: "crawl-1" }))
      .mockResolvedValueOnce(Response.json({
        status: "completed",
        total: 1,
        completed: 1,
        creditsUsed: 1,
        data: [{
          markdown: "# Acme\nShip product work faster.\n- Workflow automation\nGet started",
          links: ["https://acme.example/features"],
          images: ["https://acme.example/product.webp"],
          branding: {
            colorScheme: "dark",
            logo: "https://acme.example/logo.svg",
            colors: { primary: "#112233", accent: "#44AAEE" },
          },
          metadata: {
            sourceURL: "https://acme.example/",
            title: "Acme",
            description: "Ship product work faster.",
            keywords: "workflow, automation",
          },
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      TMG_MARKETING_DISCOVERY_ENABLED: "true",
      FIRECRAWL_API_KEY: "test-key",
    };
    const source = discoveryPlan().sources[0];
    if (!source) throw new Error("source missing");
    const started = await startMarketingCrawl(env, source);
    const snapshot = await getMarketingCrawlSnapshot(env, started.jobId);

    expect(started.jobId).toBe("crawl-1");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.pages[0]?.branding?.logo).toBe("https://acme.example/logo.svg");
    expect(snapshot.pages[0]?.images).toEqual(["https://acme.example/product.webp"]);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"branding"');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"ignoreRobotsTxt":false');
  });

  it("compiles crawl evidence into context, creative variants, and reviewable social copy", () => {
    const discovery = discoveryPlan();
    const context = compileCampaignContextManifest({
      discoveryPlan: discovery,
      crawls: [{
        jobId: "crawl-1",
        status: "completed",
        total: 1,
        completed: 1,
        creditsUsed: 1,
        pages: [{
          sourceUrl: "https://acme.example/",
          title: "Acme",
          description: "Ship product work faster with governed workflow automation.",
          markdown: "# Move work forward\n- Workflow automation\n- Team visibility\nGet started",
          links: [],
          images: ["https://acme.example/product.webp"],
          branding: {
            colorScheme: "dark",
            logo: "https://acme.example/logo.svg",
            colors: { primary: "#112233", accent: "#44AAEE" },
          },
          metadata: { keywords: "workflow, automation" },
        }],
      }],
      compiledAt: now,
    });

    expect(context.schemaVersion).toBe("tmg.campaign-context.v1");
    expect(context.brand.colors).toContain("#112233");
    expect(context.product.features).toContain("Workflow automation");
    expect(context.candidateAssets.every((asset) => asset.state === "candidate_only")).toBe(true);
    expect(context.governance.publicationAuthority).toBe(false);

    const brief = compileMarketingCreativeBrief({
      plan: productionPlan(),
      context,
      compiledAt: now,
    });
    expect(brief.variants.map((variant) => variant.targetProfile.profileId)).toEqual([
      "tiktok.organic.v1",
      "youtube.short.v1",
      "web.hero.v1",
    ]);
    expect(brief.variants.map((variant) => variant.targetProfile.aspectRatio)).toEqual([
      "9:16",
      "9:16",
      "16:9",
    ]);
    expect(brief.variants[0]?.videoPrompt).toMatch(/No invented awards/);
    expect(brief.humanReviewRequired).toBe(true);

    const copy = compileMarketingSocialCopy(brief);
    expect(copy.posts).toHaveLength(3);
    expect(copy.posts.every((post) => post.reviewRequired)).toBe(true);
    expect(copy.publicationAuthority).toBe(false);
  });
});
