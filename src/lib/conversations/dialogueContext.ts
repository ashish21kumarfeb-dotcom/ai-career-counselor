// The token-budgeted dialogue block fed to the ANSWER model (the Recommendation
// Agent), so a multi-turn answer stays consistent with what the user has already
// asked and been told — not just the single resolved question resolve_query hands
// forward.
//
// WHY A SECOND, TIGHTER BUDGET THAN getRecentTurns. The history window read in
// queries.ts is the OUTER bound (12 turns x 1500 chars ~= 18 KB) — deliberately
// generous so a future consumer that wants more context than any current one is not
// silently starved. Dumping all of it into the answer prompt on every turn is the
// exact unbounded-growth failure that comment warns about: a long thread would make
// each answer's prompt (and bill, and latency) grow with how long the user has been
// talking. So this is the working set, not the outer bound — a bounded slice of the
// most recent dialogue, sized independently of the window.
//
// Budget is expressed in CHARACTERS as a documented proxy for tokens, the same
// convention used across this codebase (see the char->token note in queries.ts).
// ~2400 chars ~= ~600 tokens: enough recent back-and-forth for continuity, capped
// regardless of thread length.
//
// Deterministic and pure (no LLM): "summary" here means a bounded rendering of the
// recent turns, not a model-generated abstract. That keeps it cheap, adds no failure
// mode to the answer path, and makes the budget behaviour unit-testable without a
// model — matching every other context helper here.
import type { ChatTurn } from "../ai/resolveQuery";

export const DIALOGUE_CHAR_BUDGET = 2400;
export const MAX_DIALOGUE_TURN_CHARS = 400;

// Shown in place of the turns that did not fit, so the model knows the dialogue is
// truncated rather than assuming it is seeing the whole thread.
const OMITTED_NOTE = "[earlier turns omitted to fit the context budget]";

function clipTurn(content: string): string {
  const t = content.trim();
  return t.length > MAX_DIALOGUE_TURN_CHARS
    ? `${t.slice(0, MAX_DIALOGUE_TURN_CHARS - 1)}…`
    : t;
}

// Render the recent dialogue as a labelled, budget-bounded block, oldest line first.
// Returns "" when there is nothing to show, so the caller can omit the block (and its
// framing) entirely rather than emit an empty heading.
//
// Turns are FILLED newest-first — the most recent exchange is the most relevant to
// the current question, so it is the last thing to be dropped — then reversed back to
// chronological order, which is how a reader (and the model) expects to see a
// conversation. At least the newest turn is always kept, even if it alone would
// exceed the budget (it is already per-turn clipped well under it).
export function buildDialogueContext(
  history: ChatTurn[],
  budgetChars: number = DIALOGUE_CHAR_BUDGET
): string {
  if (!history || history.length === 0) return "";

  const kept: string[] = [];
  let used = 0;
  let anyDropped = false;

  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    const who = turn.role === "assistant" ? "Assistant" : "User";
    const line = `${who}: ${clipTurn(turn.content)}`;
    const cost = line.length + 1; // +1 for the newline joiner.

    // Once the budget is spent, stop — but never drop the newest turn to nothing.
    if (used + cost > budgetChars && kept.length > 0) {
      anyDropped = true;
      break;
    }
    kept.push(line);
    used += cost;
  }

  kept.reverse();
  return (anyDropped ? [OMITTED_NOTE, ...kept] : kept).join("\n");
}
