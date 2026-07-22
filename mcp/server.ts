// The MCP server: a SEPARATE PROCESS in this repo, not a Next.js route handler.
//
// Why not a route handler: the bundled Next 16 docs warn that on lambda hosts
// route handlers "cannot share data between requests" and "long-running handlers
// may be terminated due to timeouts", and only proxy has waitUntil(). An MCP
// endpoint is exactly the long-lived, stateful-ish thing that guidance is about.
// (Next's own guides/mcp.md is next-devtools-mcp — a dev-only server for CODING
// agents at /_next/mcp. It is unrelated: Next ships nothing for authoring your
// own MCP server.)
//
// Why Streamable HTTP and not stdio: MultiServerMCPClient is stateless by design
// — LangChain's docs say each tool invocation creates a fresh ClientSession, runs
// the tool, then cleans up. Over stdio that is a Node subprocess spawned PER TOOL
// CALL. Worse, the Next dev server re-evaluates modules on hot reload, orphaning
// stdio children on every edit. One HTTP URL sidesteps both.
//
// Run:  npm run mcp:server     (terminal 1)
//       npm run dev            (terminal 2)
//
// The same URL can be handed to Claude Desktop or any MCP client — which is the
// point: it proves this is a protocol boundary, not a function call in a costume.
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  TOOL_DESCRIPTIONS,
  handleSearchAgencies,
  handleSearchResources,
  handleSearchCareerRoadmaps,
  handleSearchMarketSignals,
  handleSearchIndustryArticles,
  handleSearchHiringCompanies,
  searchAgenciesInput,
  searchResourcesInput,
  searchCareerRoadmapsInput,
  searchMarketSignalsInput,
  searchIndustryArticlesInput,
  searchHiringCompaniesInput,
} from "./tools";

const PORT = Number(process.env.MCP_PORT ?? 3333);
// Bind loopback only. The MCP transport spec: "When running locally, servers
// SHOULD bind only to localhost (127.0.0.1) rather than all network interfaces."
const HOST =
  process.env.NODE_ENV === "production"
    ? "0.0.0.0"
    : "127.0.0.1";

const PATH = "/mcp";

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "career-workflow-tools", version: "0.1.0" },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    "searchAgencies",
    { title: "Search verified agencies", description: TOOL_DESCRIPTIONS.searchAgencies, inputSchema: searchAgenciesInput },
    handleSearchAgencies
  );
  server.registerTool(
    "searchResources",
    { title: "Search curated resources", description: TOOL_DESCRIPTIONS.searchResources, inputSchema: searchResourcesInput },
    handleSearchResources
  );
  server.registerTool(
    "searchCareerRoadmaps",
    { title: "Search career roadmaps (external)", description: TOOL_DESCRIPTIONS.searchCareerRoadmaps, inputSchema: searchCareerRoadmapsInput },
    handleSearchCareerRoadmaps
  );
  server.registerTool(
    "searchMarketSignals",
    { title: "Search market signals (external)", description: TOOL_DESCRIPTIONS.searchMarketSignals, inputSchema: searchMarketSignalsInput },
    handleSearchMarketSignals
  );
  server.registerTool(
    "searchIndustryArticles",
    { title: "Search industry articles (external)", description: TOOL_DESCRIPTIONS.searchIndustryArticles, inputSchema: searchIndustryArticlesInput },
    handleSearchIndustryArticles
  );
  server.registerTool(
    "searchHiringCompanies",
    { title: "Search companies hiring now (external)", description: TOOL_DESCRIPTIONS.searchHiringCompanies, inputSchema: searchHiringCompaniesInput },
    handleSearchHiringCompanies
  );

  return server;
}

// Read a JSON body off a node:http request. The SDK's own example uses express
// for this; parsing it here avoids adding a web framework for one endpoint.
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url?.startsWith(PATH)) {
    res.writeHead(404).end("Not found");
    return;
  }

  // Stateless: a fresh server + transport per request, so any instance can answer
  // any request and there is no session state to leak between callers.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // The spec REQUIRES servers to validate the Origin header against DNS
    // rebinding. The SDK implements it; enabling it beats hand-rolling the check.
    enableDnsRebindingProtection: true,
    allowedHosts: process.env.NODE_ENV === "production"
  ? undefined
  : [`${HOST}:${PORT}`, `localhost:${PORT}`]
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    const body = await readJsonBody(req);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("[mcp] request failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
}

const http = createServer((req, res) => {
  void handle(req, res);
});

http.listen(PORT, HOST, () => {
  console.log(`[mcp] career-workflow-tools listening on http://${HOST}:${PORT}${PATH}`);
  console.log(
    `[mcp] tools: searchAgencies, searchResources, searchCareerRoadmaps, searchMarketSignals, searchIndustryArticles, searchHiringCompanies`
  );
  console.log(
    `[mcp] external tools require EXTERNAL_SEARCH_ENABLED=true and TAVILY_API_KEY (else they throw and the caller degrades)`
  );
  console.log(`[mcp] point the app at it with MCP_ENABLED=true MCP_URL=http://${HOST}:${PORT}${PATH}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[mcp] ${signal} — shutting down.`);
    http.close(() => process.exit(0));
  });
}
