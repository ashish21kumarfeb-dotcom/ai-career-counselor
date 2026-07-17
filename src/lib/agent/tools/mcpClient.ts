// MCP client: routes the two global retrieval tools through the protocol instead
// of calling the query helpers directly.
//
// The usual LangChain+MCP path is getTools() -> bindTools() -> the LLM picks a
// tool. That is IRRELEVANT here, and deliberately so: in this workflow the LLM
// never selects tools — the execution plan proposes, the deterministic gates
// veto, and only then does a tool run. MCP is the execution boundary, not the
// selection mechanism. So the tools are invoked directly by name and the gates
// are preserved verbatim. (A pleasant side effect: Groq not being a LangChain
// chat provider costs nothing here.)
//
// DEGRADATION, NOT BREAKAGE: if MCP is disabled or the server is unreachable, the
// caller falls back to the direct function call and the trace records that it
// happened. /api/agent-chat must not break because a side process is down — and
// because the transport is recorded per call, we can never accidentally claim
// "runs on MCP" for a run that quietly used the direct path.
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { z } from "zod";

const SERVER_NAME = "careerTools";

export function mcpEnabled(): boolean {
  return process.env.MCP_ENABLED === "true";
}
export function mcpUrl(): string {
  return process.env.MCP_URL ?? "http://127.0.0.1:3333/mcp";
}

export type McpHealth = {
  enabled: boolean;
  url: string;
  reachable: boolean;
  reason?: string;
};

// Liveness probe for the MCP server, deliberately OUTSIDE the LangChain adapter:
// a raw JSON-RPC POST that answers one question — is a server speaking MCP at
// mcpUrl() right now? verify:mcp and dev:all use it to assert "MCP is actually up"
// before a run is allowed to claim its tools ran over the protocol. A JSON-RPC
// error for the bare `ping` still comes from a live endpoint, so anything below
// HTTP 500 counts as reachable; only a transport failure or 5xx is "down".
export async function checkMcpHealth(timeoutMs = 2000): Promise<McpHealth> {
  const enabled = mcpEnabled();
  const url = mcpUrl();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { enabled, url, reachable: res.status < 500, reason: res.status >= 500 ? `HTTP ${res.status}` : undefined };
  } catch (error) {
    return { enabled, url, reachable: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

let client: MultiServerMCPClient | null = null;
let toolCache: Map<string, { invoke: (args: Record<string, unknown>) => Promise<unknown> }> | null = null;
// The URL the cached tools were built against. The tool objects returned by
// getTools() stay bound to the client that produced them, so caching them by name
// alone means a URL change keeps silently serving tools pointed at the OLD server
// — the cache short-circuits before getClient() is ever consulted. Keying the
// cache to its URL makes that impossible.
let cacheUrl: string | null = null;

function getClient(): MultiServerMCPClient {
  client ??= new MultiServerMCPClient({
    [SERVER_NAME]: { transport: "http", url: mcpUrl() },
  });
  return client;
}

// Reset between tests / after a failure, so a dead connection is not cached.
export async function resetMcpClient(): Promise<void> {
  try {
    await client?.close();
  } catch {
    // closing a never-connected client is not interesting
  }
  client = null;
  toolCache = null;
  cacheUrl = null;
}

async function getTool(name: string) {
  const url = mcpUrl();
  if (!toolCache || cacheUrl !== url) {
    if (cacheUrl !== null && cacheUrl !== url) await resetMcpClient();
    cacheUrl = url;
    const tools = await getClient().getTools();
    toolCache = new Map(tools.map((t) => [t.name, t as unknown as { invoke: (a: Record<string, unknown>) => Promise<unknown> }]));
  }
  const tool = toolCache.get(name);
  if (!tool) throw new Error(`MCP server does not expose a tool named "${name}" (has: ${[...toolCache.keys()].join(", ") || "none"})`);
  return tool;
}

// MCP results arrive as content blocks, not typed rows. Normalize whatever the
// adapter hands back — a string, a block, or an array of blocks — into raw text.
// Written defensively on purpose: the exact shape is an adapter implementation
// detail, and guessing wrong here would silently empty every tool result.
export function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(extractText).join("");
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.content)) return extractText(obj.content);
  }
  return "";
}

export type ToolTransport = "mcp" | "direct" | "skipped";
export type ToolCallResult<T> = {
  data: T[];
  transport: ToolTransport;
  degradedReason?: string;
};

// Call a tool over MCP, falling back to `direct` on any failure. `schema`
// re-establishes the type fidelity lost at the protocol boundary: a malformed or
// unparseable payload is a degradation, not something to hand downstream.
export async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
  direct: () => Promise<T[]>
): Promise<ToolCallResult<T>> {
  if (!mcpEnabled()) {
    return { data: await direct(), transport: "direct", degradedReason: "MCP_ENABLED is not true" };
  }

  try {
    const tool = await getTool(name);
    const raw = await tool.invoke(args);
    const text = extractText(raw);
    if (!text.trim()) {
      // An empty payload is ambiguous — it could be "no rows" or a broken
      // response. Treat it as no rows only if it parses as an empty array.
      throw new Error("MCP tool returned an empty payload");
    }
    const parsed = z.array(schema).safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`MCP tool payload failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    return { data: parsed.data, transport: "mcp" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[mcp] ${name} failed; falling back to a direct call:`, reason);
    // A cached client holding a dead connection would fail every subsequent call.
    await resetMcpClient();
    return { data: await direct(), transport: "direct", degradedReason: reason };
  }
}
