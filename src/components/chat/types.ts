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

// The three external tool result sets, as returned by /api/agent-chat.
export type ExternalSignals = {
  roadmaps: ExternalResult[];
  marketSignals: ExternalResult[];
  industryArticles: ExternalResult[];
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

export type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; data: AgentResponse };
