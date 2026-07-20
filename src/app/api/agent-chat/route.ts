import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth/session";
import { chatSchema } from "../../../lib/chat/validation";
import { screenChatInput, SCREEN_BLOCK_MESSAGE } from "../../../lib/chat/screen";
import { agentGraph } from "../../../lib/agent/graph";
import { saveRun } from "../../../lib/agent/trace/queries";
import { consumeRateLimit, userSubject, CHAT_LIMIT } from "../../../lib/rate-limit/queries";

// The Career Chat route. Runs the LangGraph workflow:
// intent -> context (profile + memory + RAG) -> planner -> tools (DB-only agency
// + resource search) -> generate -> verify -> evaluate -> memory update -> log.
// Returns a DYNAMIC sectioned response — only the sections the planner deemed
// relevant.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Rate limit before parsing the body: the limiter's job is to cap what an
  // authenticated caller can spend, and a malformed request that reaches the
  // handler has already cost a session lookup. Keyed on the user id, which is the
  // only identity worth limiting here — every path below this point requires a
  // session, so there is no anonymous traffic to key on an IP instead.
  const limit = await consumeRateLimit(userSubject(session.userId), CHAT_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error:
          "You've hit the hourly limit for this assistant. Please try again shortly.",
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  // Input screening. Placed after schema validation (so the fields exist) and
  // before the graph (so a blocked request costs nothing downstream). Logged
  // rather than silently dropped — a screen whose hits are invisible cannot be
  // tuned, and a rise in blocks is itself a signal worth seeing.
  const screen = screenChatInput(parsed.data.message, parsed.data.history ?? []);
  if (screen.blocked) {
    console.warn(
      `agent-chat input screened: reason=${screen.reason} where=${screen.where} user=${session.userId}`
    );
    return NextResponse.json({ error: SCREEN_BLOCK_MESSAGE }, { status: 400 });
  }

  // Correlation id for the whole run. Minted here (not defaulted inside the
  // graph) so the id exists even if the graph throws before any node runs, and
  // so a failed run can still be recorded below.
  const runId = randomUUID();

  try {
    const result = await agentGraph.invoke({
      userId: session.userId,
      query: parsed.data.message,
      // Active-conversation context for follow-up resolution. Empty when absent, so
      // the resolve_query node leaves the query untouched (first-turn behaviour).
      history: parsed.data.history ?? [],
      runId,
      // persist defaults true: the graph updates memory, logs the turn, and
      // flushes the audit trace to agent_runs.
    });

    // The dynamic sections are unchanged. Additionally expose the EXTERNAL (Tavily)
    // sourced results and the per-tool MCP transport records — both already computed
    // on the Career Data envelope (result.careerData). This is response-shaping only:
    // no agent, planner, retrieval, or MCP logic is touched. The full audit trace
    // still lands in agent_runs, not here.
    const cd = result.careerData;
    return NextResponse.json(
      {
        intent: result.intent,
        plan: result.plan,
        sections: result.sections,
        external: {
          roadmaps: cd?.roadmaps ?? [],
          marketSignals: cd?.marketSignals ?? [],
          industryArticles: cd?.industryArticles ?? [],
        },
        // MCP provenance for the "Tools Used" indicator: which tools ran and over
        // which transport (mcp / direct fallback / skipped).
        tools: cd?.toolCalls ?? [],
        verification: result.verification,
        evaluation: result.evaluation,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("agent-chat graph error:", error);
    // The graph threw, so persist_trace never ran and the run would otherwise
    // vanish. Record the failure — an audit trace that only keeps successes is
    // worse than none. Best-effort: never let it mask the original error.
    try {
      await saveRun({
        runId,
        userId: session.userId,
        query: parsed.data.message,
        trace: [],
        finalStatus: "failed",
      });
    } catch (traceError) {
      console.error("agent-chat failed-run trace write failed:", traceError);
    }
    return NextResponse.json(
      { error: "The assistant is unavailable right now. Please try again." },
      { status: 502 }
    );
  }
}
