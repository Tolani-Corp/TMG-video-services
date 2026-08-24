import {
  planMarketingDiscoveryStrategy,
  type MarketingDiscoveryStrategy,
} from "./marketing-execution-planner";
import type {
  ProductionPlan,
  SourceContextReference,
} from "./production-request";

export const FIRECRAWL_MARKETING_FORMATS = [
  "markdown",
  "links",
  "images",
  "branding",
] as const;

export interface FirecrawlMarketingCrawlRequest {
  url: string;
  includePaths: string[];
  excludePaths: string[];
  maxDiscoveryDepth: number;
  sitemap: "include";
  ignoreQueryParameters: boolean;
  limit: number;
  crawlEntireDomain: false;
  allowExternalLinks: false;
  allowSubdomains: boolean;
  ignoreRobotsTxt: false;
  scrapeOptions: {
    formats: Array<(typeof FIRECRAWL_MARKETING_FORMATS)[number]>;
    onlyMainContent: false;
    removeBase64Images: true;
    blockAds: true;
    storeInCache: false;
  };
  zeroDataRetention: true;
}

export interface MarketingDiscoverySourcePlan {
  sourceType: SourceContextReference["type"];
  sourceUrl: string;
  provider: "firecrawl_v2";
  endpoint: "https://api.firecrawl.dev/v2/crawl";
  discovery: MarketingDiscoveryStrategy;
  request: FirecrawlMarketingCrawlRequest;
  authorization: {
    authorizedByRequester: true;
    authenticatedCrawlAuthorized: boolean;
    credentialRef?: string;
  };
  assetReuse: {
    authorizedByRequester: boolean;
    rightsEvidenceStillRequired: true;
  };
}

export interface MarketingDiscoveryPlan {
  schemaVersion: "tmg.marketing-discovery-plan.v1";
  requestId: string;
  tenantId: string;
  sources: MarketingDiscoverySourcePlan[];
  outputs: {
    campaignContextManifest: true;
    brandContext: true;
    productContext: true;
    candidateAssetInventory: true;
    messagingContext: true;
  };
  governance: {
    respectRobotsTxt: true;
    externalLinkCrawlAllowed: false;
    discoveredAssetReuseRequiresRightsEvidence: true;
    publicationAuthority: false;
    externalDistributionAuthority: false;
  };
}

function projectGoal(plan: ProductionPlan): string {
  return (
    plan.sourceInputs.find((input) => input.kind === "project_brief")?.referenceValue?.trim()
    || plan.title
  );
}

function buildSourcePlan(
  source: SourceContextReference,
  goal: string,
): MarketingDiscoverySourcePlan {
  if (!source.authorization.authorizedByRequester) {
    throw new Error("marketing context source is not authorized by requester");
  }

  const discovery = planMarketingDiscoveryStrategy({ source, goal });
  const maxDiscoveryDepth = discovery.mode === "direct"
    ? 0
    : Math.min(source.crawlScope.maxDiscoveryDepth, 2);

  return {
    sourceType: source.type,
    sourceUrl: source.url,
    provider: "firecrawl_v2",
    endpoint: "https://api.firecrawl.dev/v2/crawl",
    discovery,
    request: {
      url: source.url,
      includePaths: source.crawlScope.includePaths,
      excludePaths: source.crawlScope.excludePaths,
      maxDiscoveryDepth,
      sitemap: "include",
      ignoreQueryParameters: true,
      limit: discovery.pageLimit,
      crawlEntireDomain: false,
      allowExternalLinks: false,
      allowSubdomains: source.crawlScope.allowSubdomains,
      ignoreRobotsTxt: false,
      scrapeOptions: {
        formats: [...FIRECRAWL_MARKETING_FORMATS],
        onlyMainContent: false,
        removeBase64Images: true,
        blockAds: true,
        storeInCache: false,
      },
      zeroDataRetention: true,
    },
    authorization: {
      authorizedByRequester: true,
      authenticatedCrawlAuthorized: source.authorization.authenticatedCrawlAuthorized,
      ...(source.authorization.credentialRef
        ? { credentialRef: source.authorization.credentialRef }
        : {}),
    },
    assetReuse: {
      authorizedByRequester: source.authorization.assetReuseAuthorized,
      rightsEvidenceStillRequired: true,
    },
  };
}

export function buildMarketingDiscoveryPlan(plan: ProductionPlan): MarketingDiscoveryPlan | null {
  if (!plan.marketingCampaign || plan.marketingCampaign.contextSources.length === 0) {
    return null;
  }

  const goal = projectGoal(plan);
  return {
    schemaVersion: "tmg.marketing-discovery-plan.v1",
    requestId: plan.requestId,
    tenantId: plan.tenantId,
    sources: plan.marketingCampaign.contextSources.map((source) => buildSourcePlan(source, goal)),
    outputs: {
      campaignContextManifest: true,
      brandContext: true,
      productContext: true,
      candidateAssetInventory: true,
      messagingContext: true,
    },
    governance: {
      respectRobotsTxt: true,
      externalLinkCrawlAllowed: false,
      discoveredAssetReuseRequiresRightsEvidence: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
    },
  };
}
