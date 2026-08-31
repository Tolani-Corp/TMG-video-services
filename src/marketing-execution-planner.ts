import type { SourceContextReference } from "./production-request";

export type MarketingDiscoveryMode = "direct" | "map_rank_crawl" | "bounded_crawl";

export interface MarketingDiscoveryStrategy {
  schemaVersion: "tmg.marketing-discovery-strategy.v1";
  mode: MarketingDiscoveryMode;
  goal: string;
  searchQuery: string;
  mapLimit: number;
  pageLimit: number;
  prioritySignals: string[];
  fallback: "bounded_crawl";
}

export interface MarketingMapLink {
  url: string;
  title?: string;
  description?: string;
}

export interface RankedMarketingMapLink extends MarketingMapLink {
  score: number;
  category: "root" | "product" | "pricing" | "proof" | "docs" | "content" | "other";
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into",
  "is", "it", "of", "on", "or", "our", "that", "the", "their", "this", "to", "with",
  "your", "create", "campaign", "marketing", "video", "videos", "launch", "produce",
]);

const PRIORITY_SIGNALS = [
  "product",
  "features",
  "solutions",
  "use cases",
  "pricing",
  "customers",
  "case studies",
  "integrations",
  "how it works",
  "demo",
  "about",
] as const;

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 500);
}

function objectiveTokens(goal: string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const token of goal.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
    if (STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    output.push(token);
    if (output.length >= 8) break;
  }
  return output;
}

export function planMarketingDiscoveryStrategy(input: {
  source: SourceContextReference;
  goal: string;
}): MarketingDiscoveryStrategy {
  const goal = compact(input.goal) || "Understand the product, brand, differentiators, and conversion path.";
  const pageCap = Math.max(1, input.source.crawlScope.maxPages);
  const hasExplicitPathScope = input.source.crawlScope.includePaths.length > 0;

  let mode: MarketingDiscoveryMode = "map_rank_crawl";
  let pageLimit = Math.min(pageCap, 8);
  if (input.source.type === "product_page") {
    mode = "direct";
    pageLimit = 1;
  } else if (hasExplicitPathScope) {
    mode = "bounded_crawl";
    pageLimit = Math.min(pageCap, 12);
  } else if (input.source.type === "docs_site") {
    pageLimit = Math.min(pageCap, 12);
  } else if (input.source.type === "mobile_app") {
    pageLimit = Math.min(pageCap, 6);
  }

  const tokens = objectiveTokens(goal);
  const searchQuery = compact(
    [...tokens, "product", "features", "pricing", "use cases", "benefits"].join(" "),
  );

  return {
    schemaVersion: "tmg.marketing-discovery-strategy.v1",
    mode,
    goal,
    searchQuery,
    mapLimit: mode === "direct" ? 1 : Math.min(200, Math.max(24, pageLimit * 8)),
    pageLimit,
    prioritySignals: [...PRIORITY_SIGNALS],
    fallback: "bounded_crawl",
  };
}

function allowedHost(source: URL, candidate: URL, allowSubdomains: boolean): boolean {
  if (candidate.protocol !== "https:") return false;
  if (candidate.hostname === source.hostname) return true;
  return allowSubdomains && candidate.hostname.endsWith(`.${source.hostname}`);
}

function categoryFor(pathname: string): RankedMarketingMapLink["category"] {
  const path = pathname.toLowerCase();
  if (path === "/" || path === "") return "root";
  if (/\/(product|features?|solutions?|use-cases?|platform|services?)(?:\/|$)/.test(path)) return "product";
  if (/\/(pricing|plans?)(?:\/|$)/.test(path)) return "pricing";
  if (/\/(customers?|case-stud(?:y|ies)|testimonials?|stories)(?:\/|$)/.test(path)) return "proof";
  if (/\/(docs?|developers?|api|guides?|help)(?:\/|$)/.test(path)) return "docs";
  if (/\/(blog|news|changelog|releases?)(?:\/|$)/.test(path)) return "content";
  return "other";
}

function scoreLink(link: MarketingMapLink, source: URL, goalTokens: string[]): RankedMarketingMapLink | null {
  let parsed: URL;
  try {
    parsed = new URL(link.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  const category = categoryFor(parsed.pathname);
  let score = 0;
  if (parsed.hostname === source.hostname) score += 25;
  if (parsed.pathname === "/" || parsed.pathname === "") score += 35;
  if (category === "product") score += 40;
  if (category === "pricing") score += 34;
  if (category === "proof") score += 30;
  if (category === "docs") score += 16;
  if (category === "content") score += 10;

  const haystack = `${parsed.pathname} ${link.title ?? ""} ${link.description ?? ""}`.toLowerCase();
  for (const signal of PRIORITY_SIGNALS) {
    if (haystack.includes(signal.replace(/\s+/g, "-")) || haystack.includes(signal)) score += 7;
  }
  for (const token of goalTokens) {
    if (haystack.includes(token)) score += 5;
  }
  if (/\/(login|signin|signup|register|account|admin|privacy|terms|legal|careers?|jobs?|support)(?:\/|$)/i.test(parsed.pathname)) {
    score -= 80;
  }
  if (/\.(pdf|xml|json|txt|zip|png|jpe?g|gif|svg|webp|mp4|mov|webm)$/i.test(parsed.pathname)) {
    score -= 60;
  }

  return { ...link, score, category };
}

export function selectMarketingMapLinks(input: {
  sourceUrl: string;
  allowSubdomains: boolean;
  goal: string;
  pageLimit: number;
  links: MarketingMapLink[];
}): RankedMarketingMapLink[] {
  const source = new URL(input.sourceUrl);
  const goalTokens = objectiveTokens(input.goal);
  const seen = new Set<string>();
  const ranked = input.links
    .flatMap((link) => {
      let parsed: URL;
      try {
        parsed = new URL(link.url);
      } catch {
        return [];
      }
      if (!allowedHost(source, parsed, input.allowSubdomains)) return [];
      parsed.hash = "";
      parsed.search = "";
      const canonical = parsed.toString();
      if (seen.has(canonical)) return [];
      seen.add(canonical);
      const scored = scoreLink({ ...link, url: canonical }, source, goalTokens);
      return scored ? [scored] : [];
    })
    .filter((link) => link.score > -20)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

  const limit = Math.max(1, Math.min(25, input.pageLimit));
  const selected: RankedMarketingMapLink[] = [];
  const selectedUrls = new Set<string>();
  const categoryOrder: RankedMarketingMapLink["category"][] = [
    "root", "product", "pricing", "proof", "docs", "content",
  ];
  for (const category of categoryOrder) {
    const candidate = ranked.find((link) => link.category === category && !selectedUrls.has(link.url));
    if (!candidate) continue;
    selected.push(candidate);
    selectedUrls.add(candidate.url);
    if (selected.length >= limit) return selected;
  }
  for (const candidate of ranked) {
    if (selectedUrls.has(candidate.url)) continue;
    selected.push(candidate);
    selectedUrls.add(candidate.url);
    if (selected.length >= limit) break;
  }

  if (selected.length === 0) {
    return [{ url: source.toString(), score: 1, category: "root" }];
  }
  return selected;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function exactIncludePathPatterns(urls: string[], sourceUrl: string): string[] {
  const source = new URL(sourceUrl);
  const patterns = new Set<string>();
  for (const value of urls) {
    const parsed = new URL(value);
    if (parsed.hostname !== source.hostname) continue;
    const path = parsed.pathname || "/";
    patterns.add(`^${regexEscape(path)}$`);
    if (patterns.size >= 25) break;
  }
  return [...patterns];
}

export function deterministicMarketingSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash | 0);
}
