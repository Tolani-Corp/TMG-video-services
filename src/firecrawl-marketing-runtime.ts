import {
  exactIncludePathPatterns,
  selectMarketingMapLinks,
  type MarketingMapLink,
} from "./marketing-execution-planner";
import type {
  MarketingDiscoverySourcePlan,
} from "./marketing-context";

const FIRECRAWL_API_HOST = "api.firecrawl.dev";
const FIRECRAWL_BASE_URL = `https://${FIRECRAWL_API_HOST}/v2`;
const MAX_MARKDOWN_CHARS = 16_000;
const MAX_LINKS_PER_PAGE = 100;
const MAX_IMAGES_PER_PAGE = 100;

export interface FirecrawlMarketingRuntimeEnv {
  FIRECRAWL_API_KEY?: string;
  TMG_MARKETING_DISCOVERY_ENABLED?: string;
}

export interface FirecrawlMarketingPage {
  sourceUrl: string;
  title?: string;
  description?: string;
  markdown: string;
  links: string[];
  images: string[];
  branding?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface FirecrawlMarketingCrawlSnapshot {
  jobId: string;
  status: "scraping" | "completed" | "failed";
  total: number;
  completed: number;
  creditsUsed: number;
  next?: string;
  pages: FirecrawlMarketingPage[];
}

export interface FirecrawlMarketingStartResult {
  jobId: string;
  discovery: {
    requestedMode: MarketingDiscoverySourcePlan["discovery"]["mode"];
    effectiveMode: "direct" | "map_rank_crawl" | "bounded_crawl";
    mappedLinkCount: number;
    selectedUrlCount: number;
    selectedUrls: string[];
    fallbackUsed: boolean;
  };
}

interface FirecrawlStartResponse {
  success?: boolean;
  id?: string;
}

interface FirecrawlStatusResponse {
  status?: string;
  total?: number;
  completed?: number;
  creditsUsed?: number;
  next?: string | null;
  data?: unknown[];
}

interface FirecrawlMapResponse {
  success?: boolean;
  links?: unknown[];
}

function requireRuntime(env: FirecrawlMarketingRuntimeEnv): string {
  if (env.TMG_MARKETING_DISCOVERY_ENABLED !== "true") {
    throw new Error("marketing discovery runtime is disabled");
  }
  const key = env.FIRECRAWL_API_KEY?.trim();
  if (!key) throw new Error("FIRECRAWL_API_KEY is not configured");
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of value) {
    const item = stringValue(candidate);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

function normalizePage(value: unknown): FirecrawlMarketingPage | null {
  if (!isRecord(value)) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const sourceUrl =
    stringValue(metadata.sourceURL) ??
    stringValue(metadata.url) ??
    stringValue(value.url);
  if (!sourceUrl) return null;

  const title = stringValue(metadata.title);
  const description = stringValue(metadata.description);
  const markdown = stringValue(value.markdown)?.slice(0, MAX_MARKDOWN_CHARS) ?? "";
  const branding = isRecord(value.branding) ? value.branding : undefined;

  return {
    sourceUrl,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    markdown,
    links: stringList(value.links, MAX_LINKS_PER_PAGE),
    images: stringList(value.images, MAX_IMAGES_PER_PAGE),
    ...(branding ? { branding } : {}),
    metadata,
  };
}

function normalizeMapLink(value: unknown): MarketingMapLink | null {
  if (typeof value === "string" && value.trim()) return { url: value.trim() };
  if (!isRecord(value)) return null;
  const url = stringValue(value.url);
  if (!url) return null;
  const title = stringValue(value.title);
  const description = stringValue(value.description);
  return {
    url,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

function assertProviderUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== FIRECRAWL_API_HOST) {
    throw new Error("Firecrawl pagination URL failed provider host validation");
  }
  return parsed.toString();
}

function compactProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]").slice(0, 800);
}

async function providerJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.text()).slice(0, 2_000);
    throw new Error(`Firecrawl ${operation} failed (${response.status}): ${body}`);
  }
  return response.json<T>();
}

async function firecrawlPost<T>(
  apiKey: string,
  path: string,
  body: unknown,
  operation: string,
): Promise<T> {
  const response = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return providerJson<T>(response, operation);
}

export async function mapMarketingSource(
  env: FirecrawlMarketingRuntimeEnv,
  source: MarketingDiscoverySourcePlan,
): Promise<MarketingMapLink[]> {
  const apiKey = requireRuntime(env);
  if (source.discovery.mode !== "map_rank_crawl") return [];

  const response = await firecrawlPost<FirecrawlMapResponse>(apiKey, "/map", {
    url: source.sourceUrl,
    search: source.discovery.searchQuery || undefined,
    sitemap: "include",
    includeSubdomains: source.request.allowSubdomains,
    ignoreQueryParameters: true,
    ignoreCache: true,
    limit: source.discovery.mapLimit,
    timeout: 45_000,
  }, "map");

  return (response.links ?? [])
    .map(normalizeMapLink)
    .filter((link): link is MarketingMapLink => link !== null)
    .slice(0, source.discovery.mapLimit);
}

export async function startMarketingCrawl(
  env: FirecrawlMarketingRuntimeEnv,
  source: MarketingDiscoverySourcePlan,
): Promise<FirecrawlMarketingStartResult> {
  const apiKey = requireRuntime(env);
  if (source.authorization.authenticatedCrawlAuthorized) {
    throw new Error("authenticated crawl credential resolver is not implemented");
  }

  let request = { ...source.request };
  let mappedLinkCount = 0;
  let selectedUrls: string[] = [];
  let fallbackUsed = false;
  let effectiveMode: FirecrawlMarketingStartResult["discovery"]["effectiveMode"] = source.discovery.mode;

  if (source.discovery.mode === "direct") {
    request = {
      ...request,
      limit: 1,
      maxDiscoveryDepth: 0,
    };
  } else if (source.discovery.mode === "map_rank_crawl" && request.includePaths.length === 0) {
    try {
      const mapped = await mapMarketingSource(env, source);
      mappedLinkCount = mapped.length;
      const selected = selectMarketingMapLinks({
        sourceUrl: source.sourceUrl,
        allowSubdomains: request.allowSubdomains,
        goal: source.discovery.goal,
        pageLimit: source.discovery.pageLimit,
        links: mapped,
      });
      selectedUrls = selected.map((link) => link.url);
      const includePaths = exactIncludePathPatterns(selectedUrls, source.sourceUrl);
      if (includePaths.length > 0) {
        request = {
          ...request,
          includePaths,
          limit: Math.min(request.limit, includePaths.length),
          maxDiscoveryDepth: Math.min(request.maxDiscoveryDepth, 1),
        };
      } else {
        fallbackUsed = true;
        effectiveMode = "bounded_crawl";
      }
    } catch (error) {
      fallbackUsed = true;
      effectiveMode = "bounded_crawl";
      console.warn(JSON.stringify({
        level: "warn",
        event: "marketing_map_rank_fallback",
        sourceUrl: source.sourceUrl,
        error: compactProviderError(error),
      }));
    }
  }

  const parsed = await firecrawlPost<FirecrawlStartResponse>(
    apiKey,
    "/crawl",
    request,
    "crawl start",
  );
  if (parsed.success !== true || !parsed.id) {
    throw new Error("Firecrawl crawl start did not return a job id");
  }

  console.log(JSON.stringify({
    level: "info",
    event: "marketing_discovery_started",
    jobId: parsed.id,
    sourceUrl: source.sourceUrl,
    requestedMode: source.discovery.mode,
    effectiveMode,
    mappedLinkCount,
    selectedUrlCount: selectedUrls.length,
    fallbackUsed,
  }));

  return {
    jobId: parsed.id,
    discovery: {
      requestedMode: source.discovery.mode,
      effectiveMode,
      mappedLinkCount,
      selectedUrlCount: selectedUrls.length,
      selectedUrls,
      fallbackUsed,
    },
  };
}

async function getStatusPage(
  apiKey: string,
  url: string,
): Promise<FirecrawlStatusResponse> {
  const response = await fetch(assertProviderUrl(url), {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return providerJson<FirecrawlStatusResponse>(response, "crawl status");
}

export async function getMarketingCrawlSnapshot(
  env: FirecrawlMarketingRuntimeEnv,
  jobId: string,
): Promise<FirecrawlMarketingCrawlSnapshot> {
  const apiKey = requireRuntime(env);
  const firstUrl = `${FIRECRAWL_BASE_URL}/crawl/${encodeURIComponent(jobId)}`;
  const first = await getStatusPage(apiKey, firstUrl);
  const status = first.status;
  if (status !== "scraping" && status !== "completed" && status !== "failed") {
    throw new Error(`Firecrawl returned unsupported crawl status: ${String(status)}`);
  }

  const pages = (first.data ?? [])
    .map(normalizePage)
    .filter((page): page is FirecrawlMarketingPage => page !== null);

  let next = stringValue(first.next ?? undefined);
  let paginationPages = 0;
  while (status === "completed" && next && paginationPages < 25) {
    const page = await getStatusPage(apiKey, next);
    pages.push(
      ...(page.data ?? [])
        .map(normalizePage)
        .filter((item): item is FirecrawlMarketingPage => item !== null),
    );
    next = stringValue(page.next ?? undefined);
    paginationPages += 1;
  }
  if (next) {
    throw new Error("Firecrawl crawl result exceeded bounded pagination limit");
  }

  return {
    jobId,
    status,
    total: Number(first.total ?? 0),
    completed: Number(first.completed ?? 0),
    creditsUsed: Number(first.creditsUsed ?? 0),
    pages,
  };
}
