// Tavily external-search client — the ONE external provider for the MVP.
//
// This is the external-world analogue of src/lib/{documents,agencies}/queries.ts:
// a thin, self-contained retrieval helper that the MCP tool handlers import
// verbatim (so the protocol path and the direct fallback can never fork), and that
// the Career Data Agent also imports as its `direct()` fallback for callTool.
//
// SAFETY INVARIANTS baked in here, not left to a prompt:
//   - SOURCED-ONLY: normalize() drops any result without an http(s) url. An
//     unsourced hit is never surfaced — there is no path from Tavily to the answer
//     that skips this filter.
//   - NO PROVIDER ANSWER: include_answer is false. We take Tavily's raw sourced
//     links, never its synthesized prose — our own grounding stays the authority.
//   - NO FABRICATION ON FAILURE: tavilySearch THROWS on any provider failure
//     (disabled, missing key, non-2xx, network, bad JSON). The caller (Career Data
//     Agent) wraps the direct path in .catch(() => []), so a provider outage
//     degrades to [] with the reason recorded in the tool-call trace — it never
//     invents data and never breaks the workflow.
//
// ENV (all read at call time, so tests can set them per-case):
//   EXTERNAL_SEARCH_ENABLED   "true" to allow any external call (kill switch, default off)
//   TAVILY_API_KEY            Tavily API key (secret)
//   EXTERNAL_SEARCH_MAX_RESULTS   default 5, capped at 10
//   EXTERNAL_SEARCH_TIMEOUT_MS    default 4000
import { z } from "zod";
import { externalResultSchema, type ExternalResult } from "../agent/agents/contracts";
import { resolveSearchStrategy } from "./searchStrategy";

const TAVILY_URL = "https://api.tavily.com/search";

// Master kill switch. When false, no external tool ever reaches the network — the
// Career Data Agent gates on this so the tools skip cleanly rather than erroring.
export function externalSearchEnabled(): boolean {
  return process.env.EXTERNAL_SEARCH_ENABLED === "true";
}

// True only when external search is BOTH enabled and actually configured with a
// key. verify:mcp uses this to decide whether it can exercise the external tools
// over the protocol or must skip them with a visible notice.
export function tavilyConfigured(): boolean {
  return externalSearchEnabled() && !!process.env.TAVILY_API_KEY;
}

function maxResults(): number {
  const n = Number(process.env.EXTERNAL_SEARCH_MAX_RESULTS ?? 5);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 10) : 5;
}

function timeoutMs(): number {
  const n = Number(process.env.EXTERNAL_SEARCH_TIMEOUT_MS ?? 4000);
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

export type TavilyTopic = "general" | "news";

export interface TavilySearchOptions {
  maxResults?: number;
  topic?: TavilyTopic;
  includeDomains?: string[];
  // News recency window (days). Only meaningful with topic: "news".
  days?: number;
}

// Provenance label: the bare hostname, so a reader (and the audit trail) can see at
// a glance where a result came from without parsing the url.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Turn a raw Tavily body into normalized, SOURCED rows. Defensive about the exact
// shape (a provider is free to add/rename fields); the only hard requirement is a
// usable http(s) url — anything without one is dropped, not guessed.
function normalize(raw: unknown): ExternalResult[] {
  const results = (raw as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: ExternalResult[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url : "";
    // Sourced-only invariant.
    if (!/^https?:\/\//i.test(url)) continue;
    const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : url;
    const snippet = typeof o.content === "string" ? o.content.trim() : "";
    const score = typeof o.score === "number" ? o.score : null;
    const publishedDate =
      typeof o.published_date === "string" && o.published_date.trim() ? o.published_date : null;
    out.push({ title, url, source: hostOf(url), snippet, publishedDate, score });
  }
  return out;
}

// Low-level Tavily call. THROWS on any failure (see file header). Returns
// normalized [] only when Tavily genuinely matched nothing.
export async function tavilySearch(
  query: string,
  opts: TavilySearchOptions = {}
): Promise<ExternalResult[]> {
  if (!externalSearchEnabled()) {
    throw new Error("external search is disabled (EXTERNAL_SEARCH_ENABLED is not 'true')");
  }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");

  const q = query.trim();
  if (!q) return [];

  const body: Record<string, unknown> = {
    query: q,
    max_results: opts.maxResults ?? maxResults(),
    search_depth: "basic",
    include_answer: false,
    include_raw_content: false,
    topic: opts.topic ?? "general",
  };
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  if (opts.topic === "news" && opts.days) body.days = opts.days;

  let res: Response;
  try {
    res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (error) {
    throw new Error(`Tavily request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new Error(`Tavily returned HTTP ${res.status}`);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("Tavily returned a non-JSON body");
  }

  const results = normalize(json);
  // Re-validate the normalized rows so a shape drift is caught here, not downstream.
  const parsed = z.array(externalResultSchema).safeParse(results);
  if (!parsed.success) {
    throw new Error(`Tavily results failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return parsed.data;
}

// Reputable, primary-ish sources for LABOR-MARKET signals. Two roles: (1) the hard
// include_domains filter for the market-signals lane — biasing here reduces the
// risk of surfacing a random blog as if it were a market fact and, combined with
// sourced-only + no-guarantee framing, keeps market signals descriptive of a cited
// source rather than a prediction; (2) the trusted-quality signal in rankByFocus()
// below, so a reputable source is preferred as a tie-breaker in every lane.
// Two bands, because "reputable for labour-market facts" is not one list.
//
// STATISTICAL: official statistics offices, multilaterals, and the pay/openings
// aggregators that publish per-occupation figures. These carry data for EVERY
// occupation a country employs — nurses, electricians, teachers, accountants,
// chefs — not just the ones a consultancy writes about. The original list leaned on
// consulting/tech-industry publishers, which is why a non-tech profession could pass
// the gate, reach the network, and still come back with nothing: the include_domains
// filter had no source that covers it.
const STATISTICAL_DOMAINS = [
  "bls.gov",
  "oecd.org",
  "ilo.org",
  "eurostat.ec.europa.eu",
  "ec.europa.eu",
  "stats.govt.nz",
  "abs.gov.au",
  "ons.gov.uk",
  "statcan.gc.ca",
  "data.gov.in",
  "mospi.gov.in",
  "payscale.com",
  "salary.com",
  "glassdoor.com",
  "indeed.com",
  "levels.fyi",
  "ambitionbox.com",
  "naukri.com",
  "linkedin.com",
];

// ANALYST: industry/consulting coverage. Good for trend and outlook framing, thin
// for per-occupation numbers, so it widens the market lane rather than defining it.
const ANALYST_DOMAINS = ["weforum.org", "mckinsey.com", "gartner.com", "nasscom.in"];

const MARKET_SIGNAL_DOMAINS = [...STATISTICAL_DOMAINS, ...ANALYST_DOMAINS];
const TRUSTED_DOMAINS: ReadonlySet<string> = new Set(MARKET_SIGNAL_DOMAINS);

// --- Query focusing, synonym expansion, and focus-aware re-ranking ------------
// The retrieval-quality core. A raw query like "What is the current job market
// outlook for Backend .NET Developers in 2026? Show hiring trends, demand, and
// industry signals with sources." buries its SUBJECT ("Backend .NET Developers")
// inside generic market-question framing. Sent verbatim, the generic terms
// dominate Tavily's relevance and generic job-market news comes back. These helpers
// isolate the subject, put it FIRST in the provider query, expand it with role
// synonyms for recall, and re-rank the candidate pool by how strongly each result
// actually matches the subject. A genuinely generic query (whose subject IS
// generic) keeps its generic behavior, because there is no specific subject to lead
// with — so general market news still surfaces for general market questions.

// Generic question-framing + English function words. Stripping these isolates the
// subject; each lane re-adds its OWN qualifier deterministically, so nothing
// lane-relevant is lost by removing the framing here.
const FOCUS_STOPWORDS: ReadonlySet<string> = new Set([
  // function words
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "of", "for",
  "to", "in", "on", "at", "by", "with", "about", "and", "or", "as", "from", "into",
  "that", "this", "these", "those", "what", "which", "who", "when", "where", "why",
  "how", "do", "does", "did", "can", "could", "should", "would", "will", "i", "me",
  "my", "we", "our", "you", "your", "it", "its",
  // generic market-question framing (each lane re-adds its own qualifier)
  "job", "jobs", "market", "markets", "outlook", "hiring", "trend", "trends",
  "demand", "industry", "industries", "signal", "signals", "current", "currently",
  "show", "give", "tell", "source", "sources", "sourced", "analysis", "insight",
  "insights", "report", "reports", "growth", "future", "scope", "opportunity",
  "opportunities", "overview", "state", "latest", "recent", "news", "article",
  "articles", "please", "need", "want", "looking", "find", "best", "good", "top",
]);

// Split on whitespace/commas, trim edge punctuation but KEEP internal tech symbols
// (.NET, C#, C++, Node.js) — destroying those would erase the very entity we want.
function tokenize(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    // Trim edge punctuation. A leading dot is kept (".net"); a TRAILING dot is not
    // (it is sentence punctuation — "sources." — never part of a tech token, whose
    // dots are internal like "node.js"). "#"/"+" are kept either side ("c#", "c++").
    .map((t) => t.replace(/^[^\w.#+]+|[^\w#+]+$/g, ""))
    .filter((t) => t.length > 0);
}

// The subject terms: tokens that survive stopword removal. Preserves order so the
// provider query stays topic-first. Lowercased for stable matching/ranking.
function focusTerms(raw: string): string[] {
  return tokenize(raw)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !FOCUS_STOPWORDS.has(t));
}

// Lightweight role-synonym expansion to improve recall for common career roles. A
// rule fires when all of its match words are present in the subject; its synonyms
// then join both the provider query and the re-rank vocabulary. Small and
// hand-curated on purpose — a recall nudge, not an ontology.
const ROLE_SYNONYMS: Array<{ match: string[]; synonyms: string[] }> = [
  { match: [".net"], synonyms: ["c#", "asp.net core", "dotnet", ".net core"] },
  { match: ["dotnet"], synonyms: ["c#", "asp.net core", ".net"] },
  { match: ["backend"], synonyms: ["server-side", "backend engineer"] },
  { match: ["frontend"], synonyms: ["front-end", "ui engineer", "react"] },
  { match: ["full", "stack"], synonyms: ["full-stack developer"] },
  { match: ["data", "scientist"], synonyms: ["machine learning", "data science"] },
  { match: ["data", "analyst"], synonyms: ["analytics", "sql", "business intelligence"] },
  { match: ["devops"], synonyms: ["ci/cd", "kubernetes", "cloud infrastructure"] },
  { match: ["cyber", "security"], synonyms: ["information security", "infosec"] },
  { match: ["cybersecurity"], synonyms: ["information security", "infosec"] },
  { match: ["product", "manager"], synonyms: ["product management"] },
  { match: ["product", "management"], synonyms: ["product manager"] },
  { match: ["cloud"], synonyms: ["aws", "azure", "gcp"] },
  { match: ["ml"], synonyms: ["machine learning", "artificial intelligence"] },
  { match: ["ai"], synonyms: ["artificial intelligence", "machine learning"] },
];

// Synonym terms for a subject, deduped and capped so the query stays focused rather
// than re-diluted by too many expansions.
function synonymsFor(terms: string[]): string[] {
  const present = new Set(terms);
  const out: string[] = [];
  for (const { match, synonyms } of ROLE_SYNONYMS) {
    if (match.every((m) => present.has(m))) {
      for (const s of synonyms) if (!out.includes(s)) out.push(s);
    }
  }
  return out.slice(0, 6);
}

// Build the topic-first provider subject and the vocabulary to re-rank against.
// When there is no subject (a purely generic query), fall back to the raw query so
// generic asks keep their generic behavior.
function focusFor(raw: string): { subject: string; vocab: string[] } {
  const terms = focusTerms(raw);
  if (terms.length === 0) return { subject: raw.trim(), vocab: [] };
  const vocab = [...terms, ...synonymsFor(terms)];
  return { subject: vocab.join(" "), vocab };
}

// Candidate pool: fetch more than we return so the re-rank has room to surface the
// domain-specific hits Tavily did not rank first. Capped at Tavily's basic ceiling.
function candidatePool(limit: number): number {
  return Math.min(10, Math.max(limit * 2, limit));
}

// Re-rank a candidate pool by, in priority order: subject/role relevance (how many
// vocab terms the title+snippet actually mention), then Tavily's own score, then
// trusted-source quality. NEVER drops a sourced result — only reorders — so a sparse
// domain degrades to fewer/less-perfect hits, never to fabricated ones.
function rankByFocus(
  rows: ExternalResult[],
  vocab: string[],
  trusted: ReadonlySet<string>
): ExternalResult[] {
  if (rows.length <= 1) return rows;
  const scored = rows.map((r, i) => {
    const hay = `${r.title} ${r.snippet}`.toLowerCase();
    const hits = vocab.filter((t) => hay.includes(t)).length;
    const relevance = vocab.length ? hits / vocab.length : 0;
    const provider = typeof r.score === "number" ? r.score : 0;
    const quality = trusted.has(r.source) ? 1 : 0;
    // Relevance dominates; provider score and trusted quality only break ties.
    const rank = relevance * 1.0 + provider * 0.3 + quality * 0.15;
    return { r, rank, i };
  });
  scored.sort((a, b) => b.rank - a.rank || a.i - b.i);
  return scored.map((s) => s.r);
}

// --- Per-tool wrappers --------------------------------------------------------
// Each builds a TOPIC-FIRST query (subject + synonyms, then a short lane qualifier),
// resolves the CORPUS from the query's search intent (resolveSearchStrategy — NOT a
// per-lane assumption), fetches a candidate pool, and re-ranks it down to `limit`.
// These are the helpers the MCP handlers call and the Career Data Agent passes as
// direct(). The lane owns its query qualifier and its trusted-domain policy; the
// corpus/recency is chosen by intent, so a new intent auto-selects the right corpus
// without editing any wrapper.

export function searchCareerRoadmaps(query: string, limit = 5): Promise<ExternalResult[]> {
  const { subject, vocab } = focusFor(query);
  const { strategy } = resolveSearchStrategy(query);
  return tavilySearch(`${subject} career roadmap learning path`, {
    topic: strategy.corpus,
    days: strategy.days,
    maxResults: candidatePool(limit),
  }).then((rows) => rankByFocus(rows, vocab, TRUSTED_DOMAINS).slice(0, limit));
}

export async function searchMarketSignals(query: string, limit = 5): Promise<ExternalResult[]> {
  const { subject, vocab } = focusFor(query);
  const { strategy } = resolveSearchStrategy(query);
  // Corpus is intent-driven: an evergreen demand/outlook question -> general (where
  // role-specific hiring content actually lives); a breaking market question
  // (layoffs, hiring freeze) -> news.
  const search = (includeDomains?: string[]) =>
    tavilySearch(`${subject} hiring demand job market outlook`, {
      topic: strategy.corpus,
      days: strategy.days,
      maxResults: candidatePool(limit),
      includeDomains,
    });

  // Trusted-domain-first, then widen. The include_domains filter is a PRECISION
  // control, and precision that returns nothing is indistinguishable from a fact
  // that does not exist — which is exactly the failure mode for professions the
  // trusted list under-covers. So: prefer the trusted corpus, and only when it
  // yields nothing at all, retry the open web. The widened pass is not a weaker
  // safety model — every downstream invariant still applies unchanged (sourced-only
  // normalize(), rankByFocus still ranks trusted sources above the rest, numeric
  // grounding still requires the figure to appear in retrieved text, and
  // verification still strips unbacked claims). A provider failure THROWS from the
  // first call, so an outage still degrades via the caller's catch — it never
  // silently becomes a widened search.
  const trusted = await search(MARKET_SIGNAL_DOMAINS);
  const rows = trusted.length > 0 ? trusted : await search();
  return rankByFocus(rows, vocab, TRUSTED_DOMAINS).slice(0, limit);
}

export function searchIndustryArticles(query: string, limit = 5): Promise<ExternalResult[]> {
  const { subject, vocab } = focusFor(query);
  const { strategy } = resolveSearchStrategy(query);
  return tavilySearch(`${subject} industry analysis`, {
    topic: strategy.corpus,
    days: strategy.days,
    maxResults: candidatePool(limit),
  }).then((rows) => rankByFocus(rows, vocab, TRUSTED_DOMAINS).slice(0, limit));
}
