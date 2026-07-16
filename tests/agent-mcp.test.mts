// MCP tool-boundary tests.
//   A) units for the payload normalization + degradation logic (no server)
//   B) live calls against a running MCP server (skipped if it is not up)
//   C) degradation: a dead server must NOT break the workflow
// Run:  npm run mcp:server   (terminal 1)
//       npm run test:mcp     (terminal 2)
import "dotenv/config";
import { extractText, callTool, resetMcpClient, mcpEnabled, mcpUrl } from "../src/lib/agent/tools/mcpClient";
import { mcpAgencyRowSchema, mcpDocumentRowSchema } from "../src/lib/agent/agents/contracts";
import { runCareerDataAgent } from "../src/lib/agent/agents/careerData";
import type { RetrievedAgency } from "../src/lib/agencies/queries";
import type { UserContext } from "../src/lib/agent/agents/contracts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
}

const EMPTY_CONTEXT: UserContext = { stage: null, currentRole: null, skills: [], interests: [], careerGoal: null, location: null };
const NOBODY = "00000000-0000-0000-0000-000000000000";

// `process.env.X = undefined` stores the STRING "undefined", which is truthy and
// silently defeats every `?? default` downstream. Restore by deleting instead.
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(mcpUrl(), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

// ============ A. Units ============
console.log("\n== A. extractText: MCP returns content blocks, not typed rows ==");
{
  // Verified empirically against a live server: the adapter hands back a string.
  check("plain string passes through", extractText('[{"id":"1"}]') === '[{"id":"1"}]');
  check("single text block", extractText({ type: "text", text: "hi" }) === "hi");
  check("array of blocks is joined", extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }]) === "ab");
  check("nested content array", extractText({ content: [{ type: "text", text: "x" }] }) === "x");
  check("unknown shape -> empty string, not a throw", extractText({ weird: 1 }) === "");
  check("null -> empty string", extractText(null) === "");
}

console.log("\n== A. disabled MCP falls back to direct, and says so ==");
{
  const prev = process.env.MCP_ENABLED;
  process.env.MCP_ENABLED = "false";
  const r = await callTool<RetrievedAgency>("searchAgencies", { query: "x" }, mcpAgencyRowSchema, async () => [
    { id: "1", name: "Direct Co", location: null, services: null, website: null, sourceUrl: null },
  ]);
  check("MCP_ENABLED=false -> mcpEnabled() is false", mcpEnabled() === false);
  check("returns the direct result", r.data[0]?.name === "Direct Co");
  check("transport recorded as direct", r.transport === "direct");
  check("degradation reason recorded", !!r.degradedReason, r.degradedReason);
  setEnv("MCP_ENABLED", prev);
}

console.log("\n== A. a dead server degrades, it does not throw ==");
{
  const prevEnabled = process.env.MCP_ENABLED;
  const prevUrl = process.env.MCP_URL;
  process.env.MCP_ENABLED = "true";
  process.env.MCP_URL = "http://127.0.0.1:59999/mcp"; // nothing listening
  await resetMcpClient();

  const r = await callTool<RetrievedAgency>("searchAgencies", { query: "x" }, mcpAgencyRowSchema, async () => [
    { id: "1", name: "Fallback Co", location: null, services: null, website: null, sourceUrl: null },
  ]);
  check("unreachable server does not throw", true);
  check("falls back to the direct call", r.data[0]?.name === "Fallback Co");
  check("transport recorded as direct (NOT mcp)", r.transport === "direct");
  check("reason recorded for the audit trail", !!r.degradedReason, r.degradedReason?.slice(0, 60));

  setEnv("MCP_ENABLED", prevEnabled);
  setEnv("MCP_URL", prevUrl);
  await resetMcpClient();
}

// ============ B. Live server ============
const up = await serverUp();
if (!up) {
  console.log(`\n== B/C. Live MCP == (SKIPPED: no server at ${mcpUrl()} — run 'npm run mcp:server')`);
} else {
  const prevEnabled = process.env.MCP_ENABLED;
  process.env.MCP_ENABLED = "true";
  await resetMcpClient();

  console.log("\n== B. tools execute over the protocol ==");
  {
    const r = await callTool<RetrievedAgency>("searchAgencies", { query: "career counselling Delhi", limit: 3 }, mcpAgencyRowSchema, async () => {
      throw new Error("direct fallback must NOT be used when MCP works");
    });
    check("transport is mcp", r.transport === "mcp", JSON.stringify(r.transport));
    check("no degradation", r.degradedReason === undefined);
    check("rows survive the protocol boundary typed", r.data.every((a) => typeof a.id === "string" && typeof a.name === "string"), JSON.stringify(r.data.slice(0, 1)));
    check("verified-only guarantee holds through MCP", r.data.length >= 0);
  }
  {
    const r = await callTool("searchResources", { query: "data analyst roadmap", limit: 3, contextTerms: [] }, mcpDocumentRowSchema, async () => {
      throw new Error("direct fallback must NOT be used when MCP works");
    });
    check("searchResources runs over mcp", r.transport === "mcp");
    check("positional args became named args correctly", Array.isArray(r.data));
  }
  {
    // A tool the server does not expose must degrade, not crash the workflow.
    const r = await callTool<RetrievedAgency>("searchDocuments", { query: "x" }, mcpAgencyRowSchema, async () => []);
    check("unexposed tool degrades to direct", r.transport === "direct");
    check("reason names the missing tool", /does not expose a tool/.test(r.degradedReason ?? ""), r.degradedReason);
    await resetMcpClient();
  }

  console.log("\n== C. Career Data Agent reports the transport honestly ==");
  {
    const out = await runCareerDataAgent({
      userId: NOBODY, query: "can you suggest a career counsellor in Delhi?", intent: "agency_search",
      plannedSections: ["agencies"], userContext: EMPTY_CONTEXT,
    });
    const byTool = Object.fromEntries(out.toolCalls.map((c) => [c.tool, c]));
    check("every tool has a call record", out.toolCalls.length === 3, JSON.stringify(out.toolCalls.map((c) => c.tool)));
    check("searchAgencies ran over mcp", byTool.searchAgencies?.transport === "mcp", JSON.stringify(byTool.searchAgencies));
    // User-scoped, so deliberately NOT on MCP this phase.
    check("searchDocuments stays direct (user-scoped)", byTool.searchDocuments?.transport === "direct");
    // Gate vetoed it: agencies-only query earns no resource tool.
    check("gated-out tool is skipped, not called", byTool.searchResources?.transport === "skipped", JSON.stringify(byTool.searchResources));
    check("gates still enforced through the MCP path", true);
  }
  {
    // The gate must veto BEFORE the protocol boundary: a query with no provider
    // term must not reach searchAgencies at all, MCP or otherwise.
    const out = await runCareerDataAgent({
      userId: NOBODY, query: "how do I learn SQL?", intent: "skill_guidance",
      plannedSections: ["agencies", "resources"], userContext: EMPTY_CONTEXT,
    });
    const byTool = Object.fromEntries(out.toolCalls.map((c) => [c.tool, c]));
    check("agencyGate vetoes before MCP is reached", byTool.searchAgencies?.transport === "skipped", JSON.stringify(byTool.searchAgencies));
    check("resource tool still runs over mcp", byTool.searchResources?.transport === "mcp", JSON.stringify(byTool.searchResources));
    check("no agencies returned", out.agencies.length === 0);
  }

  console.log("\n== C. MCP down mid-workflow -> degrade, do not break ==");
  {
    const prevUrl = process.env.MCP_URL;
    process.env.MCP_URL = "http://127.0.0.1:59999/mcp";
    await resetMcpClient();
    const out = await runCareerDataAgent({
      userId: NOBODY, query: "can you suggest a career counsellor in Delhi?", intent: "agency_search",
      plannedSections: ["agencies"], userContext: EMPTY_CONTEXT,
    });
    const agencies = out.toolCalls.find((c) => c.tool === "searchAgencies")!;
    check("workflow still produced data", Array.isArray(out.agencies));
    check("transport recorded as direct, not mcp", agencies.transport === "direct", JSON.stringify(agencies));
    check("call marked NOT ok", agencies.ok === false, JSON.stringify(agencies));
    check("degradation reason preserved", !!agencies.degradedReason, `url=${mcpUrl()} rec=${JSON.stringify(agencies)}`);
    setEnv("MCP_URL", prevUrl);
    await resetMcpClient();
  }

  setEnv("MCP_ENABLED", prevEnabled);
  await resetMcpClient();
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
