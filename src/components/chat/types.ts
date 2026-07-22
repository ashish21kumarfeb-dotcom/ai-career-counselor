// Shared client-side types for the Career Chat workspace. These mirror the
// /api/agent-chat response shape (src/lib/agent/schema.ts) — kept here so the
// chat panel, navigator, and workspace share one contract.

export type ResourceItem = { title: string; type: string; url: string | null };

export type AgencyItem = {
  name: string;
  location: string | null;
  services: string | null;
  website: string | null;
  source: string | null;
};

export type Sourced<T> = { items: T[]; note?: string };

export type Sections = {
  ai_suggestion?: string;
  roadmap?: { items: string[]; suggested: boolean };
  resources?: Sourced<ResourceItem>;
  courses?: Sourced<ResourceItem>;
  skill_focus?: string[];
  agencies?: Sourced<AgencyItem>;
  next_steps?: string[];
};

// A normalized EXTERNAL (Tavily) search result — mirrors externalResultSchema in
// src/lib/agent/agents/contracts.ts. Always sourced: `url` is a real http link.
export type ExternalResult = {
  title: string;
  url: string;
  source: string;
  snippet: string;
  publishedDate: string | null;
  score: number | null;
};

// A structured company entity for the Hiring Companies section — mirrors
// hiringCompanySchema in src/lib/agent/agents/contracts.ts. Extracted from the
// sourced hiring results; `sourceUrl` is always a real retrieved http link.
export type HiringCompany = {
  name: string;
  whyMatched: string | null;
  roles: string[];
  location: string | null;
  website: string | null;
  sourceUrl: string;
  sourceName: string;
};

// The external tool result sets, as returned by /api/agent-chat. The first three are
// raw sourced links; hiringCompanies is the structured entity-discovery result.
export type ExternalSignals = {
  roadmaps: ExternalResult[];
  marketSignals: ExternalResult[];
  industryArticles: ExternalResult[];
  // Optional so a response/snapshot written before this section existed still parses.
  hiringCompanies?: HiringCompany[];
};

// One MCP tool-call record — how each retrieval tool ran this turn.
export type ToolCall = {
  tool: string;
  transport: "mcp" | "direct" | "skipped";
  ok: boolean;
  items: number;
  degradedReason?: string;
};

export type Evaluation = {
  groundedness: number;
  relevance: number;
  personalization: number;
  actionability: number;
  safety: number;
  hallucination_risk: "low" | "medium" | "high";
  notes: string;
  overall: number;
};

export type AgentResponse = {
  intent: string;
  plan: { sections: string[]; reasoning: string };
  sections: Sections;
  // External sourced signals + MCP tool provenance. Optional so a response without
  // them (older shape / external search disabled) still parses.
  external?: ExternalSignals;
  tools?: ToolCall[];
  verification: { grounded: boolean; safe: boolean; notes: string };
  evaluation?: Evaluation | null;
};

// A turn as held by the workspace. Assistant turns come in two shapes:
//   - `data`: a full AgentResponse envelope that drives the Career Navigator
//     panel. Carried both by a LIVE response this session AND by a rehydrated turn
//     restored from its stored render snapshot (conversation_messages.response) —
//     so reopening a thread rebuilds the exact same navigator, not just text.
//   - `content`: the text-only fallback, used only for LEGACY assistant turns
//     written before render snapshots existed (their `response` is null). These
//     restore as a transcript bubble with no navigator, since there is no envelope
//     to rebuild from.
export type Turn =
  | { role: "user"; content: string }
  // `rehydrated` marks an envelope restored from a stored snapshot rather than
  // produced live this session — the chat bubble uses it to say "restored" instead
  // of "updated". Absent (falsy) on live turns.
  | { role: "assistant"; data: AgentResponse; rehydrated?: boolean }
  | { role: "assistant"; content: string };
