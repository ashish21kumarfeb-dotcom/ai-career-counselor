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
  verification: { grounded: boolean; safe: boolean; notes: string };
  evaluation?: Evaluation | null;
};

export type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; data: AgentResponse };
