import { describe, expect, it } from "vitest";
import {
  deterministicMarketingSeed,
  exactIncludePathPatterns,
  planMarketingDiscoveryStrategy,
  selectMarketingMapLinks,
} from "../src/marketing-execution-planner";
import type { SourceContextReference } from "../src/production-request";

function source(overrides: Partial<SourceContextReference> = {}): SourceContextReference {
  return {
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
      maxPages: 50,
      maxDiscoveryDepth: 2,
    },
    ...overrides,
  } as SourceContextReference;
}

describe("TMG dynamic marketing execution planner", () => {
  it("uses map-rank-crawl for an unscoped website and bounds page cost", () => {
    const strategy = planMarketingDiscoveryStrategy({
      source: source(),
      goal: "Launch workflow automation to operations leaders",
    });
    expect(strategy.mode).toBe("map_rank_crawl");
    expect(strategy.pageLimit).toBe(8);
    expect(strategy.mapLimit).toBeLessThanOrEqual(200);
    expect(strategy.searchQuery).toContain("workflow");
    expect(strategy.searchQuery).toContain("features");
  });

  it("preserves an explicit requester crawl scope instead of overriding it", () => {
    const scoped = source({
      crawlScope: {
        includePaths: ["^/approved(?:/|$)"],
        excludePaths: ["/admin"],
        allowSubdomains: false,
        maxPages: 50,
        maxDiscoveryDepth: 3,
      },
    });
    const strategy = planMarketingDiscoveryStrategy({ source: scoped, goal: "Campaign" });
    expect(strategy.mode).toBe("bounded_crawl");
    expect(strategy.pageLimit).toBe(12);
  });

  it("uses direct discovery for a single product page", () => {
    const strategy = planMarketingDiscoveryStrategy({
      source: source({ type: "product_page", url: "https://acme.example/product/acme" }),
      goal: "Promote Acme",
    });
    expect(strategy.mode).toBe("direct");
    expect(strategy.pageLimit).toBe(1);
    expect(strategy.mapLimit).toBe(1);
  });

  it("selects diverse conversion-relevant pages and rejects unsafe noise", () => {
    const selected = selectMarketingMapLinks({
      sourceUrl: "https://acme.example/",
      allowSubdomains: false,
      goal: "workflow automation for product teams",
      pageLimit: 5,
      links: [
        { url: "https://acme.example/", title: "Acme" },
        { url: "https://acme.example/features", title: "Workflow automation features" },
        { url: "https://acme.example/pricing", title: "Pricing" },
        { url: "https://acme.example/case-studies/alpha", title: "Product team customer story" },
        { url: "https://acme.example/docs", title: "Developer docs" },
        { url: "https://acme.example/login", title: "Login" },
        { url: "https://acme.example/privacy", title: "Privacy" },
        { url: "https://external.example/features", title: "External features" },
      ],
    });

    expect(selected.map((item) => item.category)).toEqual([
      "root",
      "product",
      "pricing",
      "proof",
      "docs",
    ]);
    expect(selected.some((item) => /login|privacy|external\.example/.test(item.url))).toBe(false);
  });

  it("creates exact path filters and stable deterministic render seeds", () => {
    const patterns = exactIncludePathPatterns([
      "https://acme.example/",
      "https://acme.example/features",
      "https://acme.example/pricing?plan=pro",
    ], "https://acme.example/");
    expect(patterns).toContain("^/$");
    expect(patterns).toContain("^/features$");
    expect(patterns).toContain("^/pricing$");

    const first = deterministicMarketingSeed("request-1:tiktok.organic.v1:hook_first");
    const second = deterministicMarketingSeed("request-1:tiktok.organic.v1:hook_first");
    const different = deterministicMarketingSeed("request-1:web.hero.v1:product_value");
    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first).toBeGreaterThanOrEqual(0);
  });
});