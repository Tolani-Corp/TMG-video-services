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
  it("maps, ranks, and executes a bounded governed Firecrawl crawl in declared best-effort mode", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        success: true,
        links: [
          { url: "https://acme.example/", title: "Acme" },
          { url: "https://acme.example/features", title: "Features for product teams" },
          { url: "https://acme.example/pricing", title: "Pricing" },
          { url: "https://acme.example/case-studies/alpha", title: "Customer story" },
          { url: "https://acme.example/privacy", title: "Privacy" },
          { url: "https://outside.example/features", title: "External" },
        ],
      }))
      .mockResolvedValueOnce(Response.json({ success: true, id: "crawl-1" }))
      .mockResolvedValueOnce(Response.json({
        status: "completed",
        total: 3,
        completed: 3,
        creditsUsed: 3,
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
      TMG_FIRECRAWL_ZERO_DATA_RETENTION_MODE: "best_effort",
      FIRECRAWL_API_KEY: "test-key",
    };
    const source = discoveryPlan().sources[0];
    if (!source) throw new Error("source missing");
    const started = await startMarketingCrawl(env, source);
    const snapshot = await getMarketingCrawlSnapshot(env, started.jobId);

    expect(started.jobId).toBe("crawl-1");
    expect(started.discovery.requestedMode).toBe("map_rank_crawl");
    expect(started.discovery.effectiveMode).toBe("map_rank_crawl");
    expect(started.discovery.selectedUrls).toContain("https://acme.example/features");
    expect(started.discovery.selectedUrls).toContain("https://acme.example/pricing");
    expect(started.discovery.selectedUrls).not.toContain("https://acme.example/privacy");
    expect(started.discovery.selectedUrls.some((url) => url.includes("outside.example"))).toBe(false);
    expect(started.discovery.zeroDataRetentionMode).toBe("best_effort");
    expect(started.discovery.zeroDataRetentionApplied).toBe(true);
    expect(started.discovery.zeroDataRetentionDowngradeUsed).toBe(false);
    expect(snapshot.status).toBe("completed");
    expect(snapshot.pages[0]?.branding?.logo).toBe("https://acme.example/logo.svg");
    expect(snapshot.pages[0]?.images).toEqual(["https://acme.example/product.webp"]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v2/map");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v2/crawl");
    const crawlBody = String(fetchMock.mock.calls[1]?.[1]?.body);
    expect(crawlBody).toContain('"branding"');
    expect(crawlBody).toContain('"ignoreRobotsTxt":false');
    expect(crawlBody).toContain('"zeroDataRetention":true');
    expect(crawlBody).toContain("features");
    expect(crawlBody).toContain("pricing");
    expect(crawlBody).not.toContain("privacy");
  });

  it("fails closed by default and avoids Map when strict ZDR is required", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({
        success: false,
        error: "Zero Data Retention (ZDR) is not enabled for your team.",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const source = discoveryPlan().sources[0];
    if (!source) throw new Error("source missing");
    await expect(startMarketingCrawl({
      TMG_MARKETING_DISCOVERY_ENABLED: "true",
      FIRECRAWL_API_KEY: "test-key",
    }, source)).rejects.toThrow(/Zero Data Retention/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v2/crawl");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('"zeroDataRetention":true');
  });

  it("allows only an explicit best-effort ZDR downgrade and records it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, links: [{ url: "https://acme.example/" }] }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          success: false,
          error: "Zero Data Retention (ZDR) is not enabled for your team. Contact support@firecrawl.com to enable this feature.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(Response.json({ success: true, id: "crawl-standard-retention" }));
    vi.stubGlobal("fetch", fetchMock);

    const source = discoveryPlan().sources[0];
    if (!source) throw new Error("source missing");
    const started = await startMarketingCrawl({
      TMG_MARKETING_DISCOVERY_ENABLED: "true",
      TMG_FIRECRAWL_ZERO_DATA_RETENTION_MODE: "best_effort",
      FIRECRAWL_API_KEY: "test-key",
    }, source);

    expect(started.jobId).toBe("crawl-standard-retention");
    expect(started.discovery.zeroDataRetentionApplied).toBe(false);
    expect(started.discovery.zeroDataRetentionDowngradeUsed).toBe(true);
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain('"zeroDataRetention":true');
    expect(String(fetchMock.mock.calls[2]?.[1]?.body)).not.toContain("zeroDataRetention");
  });

  it("compiles context into differentiated preview plans and reviewable social copy", () => {
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
          markdown: "# Move work forward\n## Automate the busywork\n- Workflow automation\n- Team visibility\nGet started",
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
    expect(brief.variants.map((variant) => variant.creativeAngle)).toEqual([
      "hook_first",
      "hook_first",
      "product_value",
    ]);
    expect(brief.variants[0]?.videoPrompt).toMatch(/No invented awards/);
    expect(brief.variants[0]?.generation.phase).toBe("preview");
    expect(brief.variants[0]?.generation.resolution).toBe("720p");
    expect(brief.variants[0]?.generation.safetyFilterEnabled).toBe(true);
    expect(brief.variants[0]?.generation.seed).toBeTypeOf("number");
    expect(brief.variants[2]?.generation.saveAudio).toBe(false);
    expect(brief.contextQuality.generationEligible).toBe(true);
    expect(brief.contextQuality.score).toBeGreaterThanOrEqual(45);
    expect(brief.humanReviewRequired).toBe(true);

    const copy = compileMarketingSocialCopy(brief);
    expect(copy.posts).toHaveLength(3);
    expect(copy.posts.every((post) => post.reviewRequired)).toBe(true);
    expect(copy.publicationAuthority).toBe(false);
  });
});