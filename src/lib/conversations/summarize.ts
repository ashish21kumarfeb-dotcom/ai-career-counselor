// Flattens an assistant response into the single text block stored as its
// conversation turn.
//
// MOVED FROM THE CLIENT (src/components/chat/history.ts). It ran there because
// the client owned the history; now that the server does, doing it here is what
// makes the stored thread independent of who rendered it. A second surface — a
// conversation list, an export, a future mobile client — gets the same turn text
// without reimplementing this, and no client can decide what the server believes
// the assistant said.
//
// The whole response is flattened, not just ai_suggestion: the user saw the
// roadmap, the skills, the next steps and the resource titles, so a follow-up like
// "and the roadmap for that?" must have all of it to resolve against.
import type { ResponseSections } from "../agent/schema";

// Sized to MAX_MESSAGE_CHARS in ./queries — the clip there is the enforcement,
// this is where the sections are chosen to fit within it.
const MAX_ASSISTANT_CHARS = 1500;

export function summarizeAssistantTurn(sections: ResponseSections | undefined): string {
  const s = sections ?? {};
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
