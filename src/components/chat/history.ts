// Builds the conversation history the client sends to /api/agent-chat so the
// server can resolve follow-up references. The assistant's turn is flattened from
// the WHOLE response the user saw (not just ai_suggestion) — roadmap, skills, next
// steps, and the titles of resources/courses/agencies — so a follow-up like
// "and the roadmap for that?" has the full context to resolve against.

import type { AgentResponse, Turn } from "./types";

export type HistoryTurn = { role: "user" | "assistant"; content: string };

// How many recent turns to send, and the size cap on a flattened assistant turn.
const MAX_TURNS = 6;
const MAX_ASSISTANT_CHARS = 1500;

// Flatten an assistant response into one readable, labeled text block.
export function summarizeAssistantTurn(data: AgentResponse): string {
  const s = data.sections ?? {};
  const parts: string[] = [];

  if (s.ai_suggestion?.trim()) parts.push(s.ai_suggestion.trim());
  if (s.roadmap?.items?.length) parts.push(`Roadmap: ${s.roadmap.items.join("; ")}`);
  if (s.skill_focus?.length) parts.push(`Skills to focus on: ${s.skill_focus.join(", ")}`);
  if (s.next_steps?.length) parts.push(`Next steps: ${s.next_steps.join("; ")}`);

  const resourceTitles = s.resources?.items?.map((r) => r.title).filter(Boolean) ?? [];
  const courseTitles = s.courses?.items?.map((c) => c.title).filter(Boolean) ?? [];
  const learning = [...resourceTitles, ...courseTitles];
  if (learning.length) parts.push(`Resources/courses: ${learning.join(", ")}`);

  const agencyNames = s.agencies?.items?.map((a) => a.name).filter(Boolean) ?? [];
  if (agencyNames.length) parts.push(`Agencies: ${agencyNames.join(", ")}`);

  return parts.join("\n").slice(0, MAX_ASSISTANT_CHARS);
}

// Convert the workspace's turn list into the bounded history payload. Assistant
// turns that flatten to nothing are dropped (no useful context to send).
export function buildHistory(turns: Turn[]): HistoryTurn[] {
  const history: HistoryTurn[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      const content = t.content.trim();
      if (content) history.push({ role: "user", content });
    } else {
      const content = summarizeAssistantTurn(t.data).trim();
      if (content) history.push({ role: "assistant", content });
    }
  }
  return history.slice(-MAX_TURNS);
}
