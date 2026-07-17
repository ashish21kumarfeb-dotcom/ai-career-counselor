// verify:mcp — PROOF that the workflow's tools run over the real MCP protocol,
// not the silent direct fallback. This is the gate that keeps a demo from
// claiming "runs on MCP" while quietly reading the DB.
//
// Fails (exit 1) if the MCP server is unreachable OR if a tool call comes back on
// the `direct` transport. The direct fallback passed to callTool below is a
// TRAP: if it ever runs, MCP did not carry the call and we must fail loudly.
//
// Run:  npm run mcp:server   (terminal 1)
//       npm run verify:mcp   (terminal 2)
import "dotenv/config";
import { callTool, checkMcpHealth, resetMcpClient } from "../src/lib/agent/tools/mcpClient";
import {
  externalResultSchema,
  mcpAgencyRowSchema,
  mcpDocumentRowSchema,
} from "../src/lib/agent/agents/contracts";
import { tavilyConfigured } from "../src/lib/external/tavily";

// verify:mcp is meaningless with MCP disabled — it exists precisely to confirm the
// protocol path, so force it on for this process regardless of the ambient env.
process.env.MCP_ENABLED = "true";

function fail(msg: string): never {
  console.error(`\nFAIL  ${msg}`);
  process.exit(1);
}

const health = await checkMcpHealth();
console.log(`[verify:mcp] enabled=${health.enabled} url=${health.url} reachable=${health.reachable}`);
if (!health.reachable) {
  fail(
    `no MCP server reachable at ${health.url} — start it with 'npm run mcp:server' (or 'npm run dev:all').` +
      (health.reason ? ` reason: ${health.reason}` : "")
  );
}

await resetMcpClient();

// The direct fallback must NEVER run here. Returning [] (rather than throwing)
// lets callTool report transport:"direct" so we can name the failure precisely.
const trap = (tool: string) => async (): Promise<never[]> => {
  console.error(`[verify:mcp] ${tool} attempted the DIRECT path — MCP was not used`);
  return [];
};

const a = await callTool("searchAgencies", { query: "career counselling Delhi", limit: 3 }, mcpAgencyRowSchema, trap("searchAgencies"));
if (a.transport !== "mcp") {
  fail(`searchAgencies ran over '${a.transport}', not MCP${a.degradedReason ? ` — ${a.degradedReason}` : ""}`);
}
console.log(`OK    searchAgencies over MCP (${a.data.length} row(s))`);

const r = await callTool("searchResources", { query: "data analyst roadmap", limit: 3, contextTerms: [] }, mcpDocumentRowSchema, trap("searchResources"));
if (r.transport !== "mcp") {
  fail(`searchResources ran over '${r.transport}', not MCP${r.degradedReason ? ` — ${r.degradedReason}` : ""}`);
}
console.log(`OK    searchResources over MCP (${r.data.length} row(s))`);

// The three EXTERNAL tools need a live Tavily key to run for real. When one is
// configured we PROVE they run over the protocol; when it is absent we SKIP them
// with a visible notice rather than either failing CI or silently claiming they
// passed. Force the kill switch on so the skip reason is only ever "no key".
process.env.EXTERNAL_SEARCH_ENABLED = "true";
const EXTERNAL_TOOLS = [
  { name: "searchCareerRoadmaps", query: "data analyst" },
  { name: "searchMarketSignals", query: "data analyst" },
  { name: "searchIndustryArticles", query: "data analyst" },
] as const;

if (!tavilyConfigured()) {
  console.log(
    "\nSKIP  external tools (searchCareerRoadmaps, searchMarketSignals, searchIndustryArticles):"
  );
  console.log("      set TAVILY_API_KEY (and EXTERNAL_SEARCH_ENABLED=true) to verify them over MCP.");
} else {
  for (const t of EXTERNAL_TOOLS) {
    await resetMcpClient();
    const e = await callTool(t.name, { query: t.query, limit: 3 }, externalResultSchema, trap(t.name));
    if (e.transport !== "mcp") {
      fail(`${t.name} ran over '${e.transport}', not MCP${e.degradedReason ? ` — ${e.degradedReason}` : ""}`);
    }
    // Sourced-only invariant holds across the protocol boundary.
    if (!e.data.every((row) => /^https?:\/\//i.test(row.url))) {
      fail(`${t.name} returned a result without an http url — sourced-only invariant broken`);
    }
    console.log(`OK    ${t.name} over MCP (${e.data.length} sourced row(s))`);
  }
}

await resetMcpClient();
console.log("\nPASS  MCP is actually in the loop — the tools ran over the protocol.");
process.exit(0);
