import type { MarketingDiscoveryPlan } from "./marketing-context";
import type { FirecrawlMarketingCrawlSnapshot, FirecrawlMarketingPage } from "./firecrawl-marketing-runtime";

export type CandidateAssetType = "logo" | "image" | "video";
export type CandidateAssetState =
  | "candidate_only"
  | "requester_reuse_authorized_pending_rights_validation";

export interface CampaignCandidateAsset {
  url: string;
  sourceUrl: string;
  type: CandidateAssetType;
  state: CandidateAssetState;
  requesterReuseAuthorized: boolean;
}

export interface CampaignContextManifest {
  schemaVersion: "tmg.campaign-context.v1";
  requestId: string;
  tenantId: string;
  brand: {
    name?: string;
    logoUrl?: string;
    colorScheme?: string;
    colors: string[];
    fonts: string[];
  };
  product: {
    name?: string;
    description?: string;
    features: string[];
    pricingMentions: string[];
  };
  messaging: {
    headlines: string[];
    valuePropositions: string[];
    callsToAction: string[];
    keywords: string[];
  };
  candidateAssets: CampaignCandidateAsset[];
  sources: Array<{
    sourceUrl: string;
    crawlJobId: string;
    pagesCaptured: number;
    requesterReuseAuthorized: boolean;
  }>;
  provenance: {
    provider: "firecrawl_v2";
    crawlJobIds: string[];
    pageCount: number;
    compiledAt: string;
  };
  governance: {
    crawlAuthorized: true;
    discoveredAssetReuseRequiresRightsEvidence: true;
    publicationAuthority: false;
    externalDistributionAuthority: false;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unique(values: Array<string | undefined>, limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = value.trim().replace(/\s+/g, " ");
    if (!normalized || normalized.length > 500 || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function markdownLines(page: FirecrawlMarketingPage): string[] {
  return page.markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function headings(page: FirecrawlMarketingPage): string[] {
  return markdownLines(page)
    .filter((line) => /^#{1,4}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,4}\s+/, "").trim());
}

function bulletFeatures(page: FirecrawlMarketingPage): string[] {
  return markdownLines(page)
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length >= 8 && line.length <= 220);
}

function pricingMentions(page: FirecrawlMarketingPage): string[] {
  return markdownLines(page).filter((line) =>
    /(?:\$|€|£)\s?\d|\bpricing\b|\bper month\b|\/month\b|\/mo\b/i.test(line),
  );
}

function callsToAction(page: FirecrawlMarketingPage): string[] {
  return markdownLines(page).filter((line) =>
    /\b(get started|start free|try free|sign up|book a demo|request a demo|learn more|contact us|download|join now|subscribe|buy now|shop now)\b/i.test(line),
  );
}

function keywords(page: FirecrawlMarketingPage): string[] {
  const raw = readString(page.metadata.keywords);
  return raw ? raw.split(",").map((value) => value.trim()) : [];
}

function collectBranding(pages: FirecrawlMarketingPage[]): {
  name?: string;
  logoUrl?: string;
  colorScheme?: string;
  colors: string[];
  fonts: string[];
} {
  const branding = pages.map((page) => page.branding).find(isRecord);
  const firstPage = pages[0];
  if (!branding) {
    return {
      ...(firstPage?.title ? { name: firstPage.title } : {}),
      colors: [],
      fonts: [],
    };
  }

  const colorsObject = isRecord(branding.colors) ? branding.colors : {};
  const colors = unique(
    Object.values(colorsObject).flatMap((value) => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
      if (isRecord(value)) return Object.values(value).filter((item): item is string => typeof item === "string");
      return [];
    }),
    16,
  );

  const typography = isRecord(branding.typography) ? branding.typography : {};
  const fontValues = [
    branding.fonts,
    typography.fontFamilies,
    typography.fontFamily,
    typography.primaryFont,
    typography.secondaryFont,
  ];
  const fonts = unique(
    fontValues.flatMap((value) => {
      if (typeof value === "string") return [value];
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    }),
    12,
  );
  const name = readString(branding.name) ?? firstPage?.title;
  const logoUrl = readString(branding.logo);
  const colorScheme = readString(branding.colorScheme);

  return {
    ...(name ? { name } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    ...(colorScheme ? { colorScheme } : {}),
    colors,
    fonts,
  };
}

function classifyAsset(url: string): CandidateAssetType {
  const lower = url.toLowerCase();
  if (/logo|favicon/.test(lower)) return "logo";
  if (/\.(mp4|webm|mov|m4v)(?:[?#]|$)/.test(lower)) return "video";
  return "image";
}

function assetUrls(page: FirecrawlMarketingPage): string[] {
  return unique(
    [
      ...page.images,
      ...page.links.filter((url) => /\.(png|jpe?g|webp|gif|svg|mp4|webm|mov|m4v)(?:[?#]|$)/i.test(url)),
      readString(page.branding?.logo),
    ],
    150,
  );
}

export function compileCampaignContextManifest(input: {
  discoveryPlan: MarketingDiscoveryPlan;
  crawls: FirecrawlMarketingCrawlSnapshot[];
  compiledAt?: string;
}): CampaignContextManifest {
  if (input.discoveryPlan.sources.length !== input.crawls.length) {
    throw new Error("campaign context crawl/source cardinality mismatch");
  }
  if (input.crawls.some((crawl) => crawl.status !== "completed")) {
    throw new Error("campaign context requires completed crawl snapshots");
  }

  const pages = input.crawls.flatMap((crawl) => crawl.pages);
  if (pages.length === 0) throw new Error("campaign context requires at least one crawled page");
  const brand = collectBranding(pages);
  const titles = unique(pages.map((page) => page.title), 20);
  const descriptions = unique(pages.map((page) => page.description), 20);
  const pageHeadings = unique(pages.flatMap(headings), 60);

  const candidateAssets: CampaignCandidateAsset[] = [];
  const seenAssets = new Set<string>();
  input.crawls.forEach((crawl, index) => {
    const sourcePlan = input.discoveryPlan.sources[index];
    if (!sourcePlan) throw new Error("campaign context source plan missing");
    for (const page of crawl.pages) {
      for (const url of assetUrls(page)) {
        if (seenAssets.has(url)) continue;
        seenAssets.add(url);
        candidateAssets.push({
          url,
          sourceUrl: page.sourceUrl,
          type: classifyAsset(url),
          state: sourcePlan.assetReuse.authorizedByRequester
            ? "requester_reuse_authorized_pending_rights_validation"
            : "candidate_only",
          requesterReuseAuthorized: sourcePlan.assetReuse.authorizedByRequester,
        });
        if (candidateAssets.length >= 300) break;
      }
      if (candidateAssets.length >= 300) break;
    }
  });

  return {
    schemaVersion: "tmg.campaign-context.v1",
    requestId: input.discoveryPlan.requestId,
    tenantId: input.discoveryPlan.tenantId,
    brand,
    product: {
      ...(titles[0] ? { name: titles[0] } : {}),
      ...(descriptions[0] ? { description: descriptions[0] } : {}),
      features: unique([...pages.flatMap(bulletFeatures), ...pageHeadings], 40),
      pricingMentions: unique(pages.flatMap(pricingMentions), 20),
    },
    messaging: {
      headlines: pageHeadings.slice(0, 30),
      valuePropositions: unique([...descriptions, ...pageHeadings], 30),
      callsToAction: unique(pages.flatMap(callsToAction), 20),
      keywords: unique(pages.flatMap(keywords), 40),
    },
    candidateAssets,
    sources: input.crawls.map((crawl, index) => {
      const source = input.discoveryPlan.sources[index];
      if (!source) throw new Error("campaign context source plan missing");
      return {
        sourceUrl: source.sourceUrl,
        crawlJobId: crawl.jobId,
        pagesCaptured: crawl.pages.length,
        requesterReuseAuthorized: source.assetReuse.authorizedByRequester,
      };
    }),
    provenance: {
      provider: "firecrawl_v2",
      crawlJobIds: input.crawls.map((crawl) => crawl.jobId),
      pageCount: pages.length,
      compiledAt: input.compiledAt ?? new Date().toISOString(),
    },
    governance: {
      crawlAuthorized: true,
      discoveredAssetReuseRequiresRightsEvidence: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
    },
  };
}
