// Tavily external-provider tests. Fully HERMETIC: no DB, no MCP server, no real
// network — globalThis.fetch is mocked per case. Covers:
//   A. normalization (fields, source host, sourced-only drop, title fallback)
//   B. provider failures throw (disabled, missing key, non-2xx, network, bad JSON)
//   C. the MCP tool handlers emit normalized JSON that re-validates
//   D. degradation: the direct-fallback pattern turns a throw into [] (never fabricates)
// Run:  npm run test:tavily
//
// dotenv first so the transitive db import (via mcp/tools) sees DATABASE_URL. The
// DB is never touched here — fetch is mocked — but its module throws at load time
// without the var. Our own overrides below run after imports; that is fine because
// every Tavily helper reads process.env at CALL time, not import time.
import "dotenv/config";

// Deterministic external-search config, overriding whatever .env carried.
process.env.EXTERNAL_SEARCH_ENABLED = "true";
process.env.TAVILY_API_KEY = "tvly-test-key";
delete process.env.EXTERNAL_SEARCH_MAX_RESULTS;

import {
  tavilySearch,
  searchCareerRoadmaps,
  searchMarketSignals,
  searchIndustryArticles,
  tavilyConfigured,
} from "../src/lib/external/tavily";
import {
  handleSearchCareerRoadmaps,
  handleSearchMarketSignals,
  handleSearchIndustryArticles,
} from "../mcp/tools";
import { externalResultSchema } from "../src/lib/agent/agents/contracts";
import { z } from "zod";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
}

const realFetch = globalThis.fetch;
function mockFetchJson(payload: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}
function mockFetchRaw(text: string, status = 200): void {
  globalThis.fetch = (async () => new Response(text, { status })) as typeof fetch;
}
function mockFetchReject(err: unknown): void {
  globalThis.fetch = (async () => { throw err; }) as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

async function threw(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

const rowsArray = z.array(externalResultSchema);

// ============ A. Normalization ============
console.log("\n== A. normalization: sourced-only, host derivation, field mapping ==");
{
  mockFetchJson({
    results: [
      { title: "Data Analyst Roadmap", url: "https://roadmap.sh/data-analyst", content: "Step-by-step path.", score: 0.91, published_date: "2025-03-01" },
      { title: "WWW stripped", url: "https://www.example.com/guide", content: "hello" },
      { title: "No URL — must be dropped", content: "orphan snippet" },
      { title: "", url: "https://ex.org/untitled", content: "" },
      { title: "ftp not http — dropped", url: "ftp://ex.org/file" },
    ],
  });
  const rows = await tavilySearch("data analyst");
  restoreFetch();

  check("drops results without an http url (5 in -> 3 out)", rows.length === 3, JSON.stringify(rows.map((r) => r.url)));
  const first = rows[0];
  check("title mapped", first?.title === "Data Analyst Roadmap");
  check("url mapped", first?.url === "https://roadmap.sh/data-analyst");
  check("source is the bare host", first?.source === "roadmap.sh", first?.source);
  check("snippet from content", first?.snippet === "Step-by-step path.");
  check("score carried as number", first?.score === 0.91);
  check("publishedDate carried", first?.publishedDate === "2025-03-01");
  check("source strips www.", rows[1]?.source === "example.com", rows[1]?.source);
  check("empty title falls back to url", rows[2]?.title === "https://ex.org/untitled", rows[2]?.title);
  check("missing score -> null", rows[1]?.score === null);
  check("missing publishedDate -> null", rows[1]?.publishedDate === null);
  check("every returned row is http-sourced", rows.every((r) => /^https?:\/\//.test(r.url)));
  check("output validates against externalResultSchema", rowsArray.safeParse(rows).success);
}

console.log("\n== A. empty/absent results -> [] (not an error) ==");
{
  mockFetchJson({ results: [] });
  const empty = await tavilySearch("x");
  check("empty results -> []", Array.isArray(empty) && empty.length === 0);
  restoreFetch();

  mockFetchJson({ query: "x" }); // no results key at all
  const missing = await tavilySearch("x");
  check("missing results key -> []", Array.isArray(missing) && missing.length === 0);
  restoreFetch();

  const blank = await tavilySearch("   "); // blank query short-circuits, never calls fetch
  check("blank query -> [] without a network call", Array.isArray(blank) && blank.length === 0);
}

console.log("\n== A. max_results is honored from env ==");
{
  let sentBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
    sentBody = init.body ? JSON.parse(init.body) : {};
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  process.env.EXTERNAL_SEARCH_MAX_RESULTS = "3";
  await tavilySearch("x");
  check("EXTERNAL_SEARCH_MAX_RESULTS drives max_results", sentBody.max_results === 3, JSON.stringify(sentBody.max_results));
  check("include_answer is false (no provider synthesis)", sentBody.include_answer === false);
  delete process.env.EXTERNAL_SEARCH_MAX_RESULTS;
  restoreFetch();
}

// ============ B. Failures throw ============
console.log("\n== B. provider failures THROW (never a silent success) ==");
{
  mockFetchJson({}, 500);
  check("HTTP 500 throws", await threw(() => tavilySearch("x")));
  restoreFetch();

  mockFetchReject(new Error("ECONNRESET"));
  check("network error throws", await threw(() => tavilySearch("x")));
  restoreFetch();

  mockFetchRaw("<html>not json</html>", 200);
  check("non-JSON body throws", await threw(() => tavilySearch("x")));
  restoreFetch();

  const prevKey = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  mockFetchJson({ results: [] });
  check("missing TAVILY_API_KEY throws", await threw(() => tavilySearch("x")));
  process.env.TAVILY_API_KEY = prevKey;
  restoreFetch();

  process.env.EXTERNAL_SEARCH_ENABLED = "false";
  check("tavilyConfigured() false when disabled", tavilyConfigured() === false);
  check("disabled search throws (kill switch)", await threw(() => tavilySearch("x")));
  process.env.EXTERNAL_SEARCH_ENABLED = "true";
  check("tavilyConfigured() true when enabled + keyed", tavilyConfigured() === true);
}

// ============ C. MCP handlers ============
console.log("\n== C. MCP handlers emit normalized, re-validatable JSON ==");
{
  mockFetchJson({
    results: [{ title: "T", url: "https://x.io/a", content: "c", score: 0.5, published_date: "2025-01-01" }],
  });
  for (const [name, handler] of [
    ["searchCareerRoadmaps", handleSearchCareerRoadmaps],
    ["searchMarketSignals", handleSearchMarketSignals],
    ["searchIndustryArticles", handleSearchIndustryArticles],
  ] as const) {
    const out = await handler({ query: "data analyst", limit: 3 });
    const text = out.content[0]?.text ?? "";
    let parsedOk = false;
    try { parsedOk = rowsArray.safeParse(JSON.parse(text)).success; } catch { parsedOk = false; }
    check(`${name} returns a text content block`, out.content[0]?.type === "text");
    check(`${name} payload re-validates as external rows`, parsedOk, text.slice(0, 120));
  }
  restoreFetch();
}

// ============ D. Degradation ============
console.log("\n== D. direct-fallback pattern: a provider throw degrades to [] ==");
{
  mockFetchReject(new Error("provider down"));
  // The Career Data Agent wraps each direct() in .catch(() => []); mirror that here.
  const safeRoadmaps = await searchCareerRoadmaps("x", 3).catch(() => [] as unknown[]);
  const safeMarket = await searchMarketSignals("x", 3).catch(() => [] as unknown[]);
  const safeArticles = await searchIndustryArticles("x", 3).catch(() => [] as unknown[]);
  check("searchCareerRoadmaps throw -> [] via catch", Array.isArray(safeRoadmaps) && safeRoadmaps.length === 0);
  check("searchMarketSignals throw -> [] via catch", Array.isArray(safeMarket) && safeMarket.length === 0);
  check("searchIndustryArticles throw -> [] via catch", Array.isArray(safeArticles) && safeArticles.length === 0);
  check("unwrapped helper still throws (reason not swallowed at the source)", await threw(() => searchCareerRoadmaps("x", 3)));
  restoreFetch();
}

restoreFetch();
console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
