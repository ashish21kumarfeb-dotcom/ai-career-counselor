// Agent-to-agent (A2A) handoff logging. Makes the message passing between the
// four SRS agents visible at runtime for observability, without affecting the
// response. Kept out of production logs to avoid noise.
//
// Not yet called in this step (the graph is unchanged); the node wrappers wired
// in later steps call logHandoff as they construct each agent's input from the
// previous agent's output envelope — making the hand-off explicit in code.

// A concise, readable label for whatever payload is being handed off, so logs
// stay short (never dumps large objects).
function summarize(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return `[${payload.length} items]`;
  if (typeof payload === "object") return `{${Object.keys(payload).join(", ")}}`;
  return String(payload);
}

export function logHandoff(from: string, to: string, payload?: unknown): void {
  if (process.env.NODE_ENV === "production") return;
  const detail = summarize(payload);
  console.log(`[A2A] ${from} → ${to}${detail ? `  ${detail}` : ""}`);
}
