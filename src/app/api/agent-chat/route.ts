import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth/session";
import { chatSchema } from "../../../lib/chat/validation";
import { SCREEN_BLOCK_MESSAGE } from "../../../lib/chat/screen";
import { agentGraph } from "../../../lib/agent/graph";
import { saveRun } from "../../../lib/agent/trace/queries";
import { consumeRateLimit, userSubject, CHAT_LIMIT } from "../../../lib/rate-limit/queries";
import {
  appendMessage,
  createConversation,
  getRecentTurns,
  openConversation,
} from "../../../lib/conversations/queries";
import { summarizeAssistantTurn } from "../../../lib/conversations/summarize";
import {
  withUsageCapture,
  flushUsage,
  summarizeUsage,
  type UsageRow,
} from "../../../lib/ai/usage";

// The Career Chat route. Runs the LangGraph workflow:
// resolve query -> Profile Agent (profile + memory) -> intent -> planner ->
// Career Data Agent (RAG + DB-only agency/resource tools) -> Recommendation
// Agent -> Verification Agent (with one regeneration retry) -> memory update ->
// evaluate -> log -> persist trace.
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

  // Input screening now happens INSIDE the graph (the input_guardrail node), so
  // every block is a traced, persisted agent_runs row instead of an invisible
  // route-level early return. The graph is the single source of truth; this
  // route reads the guardrail result off the final state below and maps a block
  // to the same 400 it always returned. The price is that a blocked request now
  // costs graph startup and one trace write instead of a pure fast-400 — that
  // observability is the point; the run is still LLM-free.

  // Resolve the thread this message belongs to.
  //
  // A supplied id is checked against the caller's OWN conversations. It arrives in
  // a request body, so an unchecked id would let any authenticated user read
  // another user's history into their prompt and append to their thread. A
  // mismatch is reported as 404, not 403: confirming that an id exists but belongs
  // to someone else is itself the leak.
  let conversationId: string;
  try {
    if (parsed.data.conversationId) {
      const owned = await openConversation(parsed.data.conversationId, session.userId);
      if (!owned) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }
      conversationId = owned;
    } else {
      // First message of a new thread. Titled from the message the user typed.
      conversationId = await createConversation(session.userId, parsed.data.message);
    }
  } catch (error) {
    console.error("agent-chat conversation resolution failed:", error);
    return NextResponse.json(
      { error: "The assistant is unavailable right now. Please try again." },
      { status: 502 }
    );
  }

  // The history window, read BEFORE this message is stored — a message must never
  // appear in its own history, or resolve_query would try to resolve a question
  // against itself.
  //
  // Best-effort: a history read that fails degrades to first-turn behaviour
  // (the query reaches the pipeline unresolved). Not worth failing a request
  // the user can still be answered.
  //
  // The user turn itself is stored AFTER the graph clears the input guardrail
  // (below) — a blocked message must never land in conversation_messages,
  // because history is deliberately not re-screened on read: the invariant is
  // that every stored turn already passed the screen at write time.
  let history: Awaited<ReturnType<typeof getRecentTurns>> = [];
  try {
    history = await getRecentTurns(conversationId);
  } catch (error) {
    console.error("agent-chat history read failed; continuing without it:", error);
  }

  // Correlation id for the whole run. Minted here (not defaulted inside the
  // graph) so the id exists even if the graph throws before any node runs, and
  // so a failed run can still be recorded below.
  const runId = randomUUID();

  // Token ledger for this run. Owned here, not by the capture helper, so the rows
  // survive a throw and the failure path can still record what the run spent —
  // a run that died halfway through a seven-call pipeline is precisely the one
  // whose cost is worth knowing.
  const usageRows: UsageRow[] = [];

  try {
    const result = await withUsageCapture({ runId, userId: session.userId }, usageRows, () =>
      agentGraph.invoke({
        userId: session.userId,
        query: parsed.data.message,
        // Active-conversation context for follow-up resolution, loaded above from
        // this thread's stored turns. Empty on the first turn, so the resolve_query
        // node leaves the query untouched.
        history,
        conversationId,
        runId,
        // persist defaults true: the graph updates memory, logs the turn, and
        // flushes the audit trace to agent_runs.
      })
    );

    await flushUsage(usageRows);

    // The guardrail verdict, recorded by the graph (and already persisted to
    // agent_runs as a "blocked" run). Same response contract as the old
    // route-level screen: 400 with a generic message that names no rule. The
    // message was never stored (see above), so nothing needs undoing here — at
    // most an empty conversation row remains for a blocked first message, which
    // is accepted as the cost of keeping the failure path write-free.
    if (result.guardrail?.blocked) {
      console.warn(
        `agent-chat input screened: reason=${result.guardrail.reason} where=${result.guardrail.where} user=${session.userId} run=${runId}`
      );
      return NextResponse.json({ error: SCREEN_BLOCK_MESSAGE }, { status: 400 });
    }

    // The input cleared the guardrail: NOW store the user's turn, preserving the
    // invariant that every row in conversation_messages passed the screen.
    // Best-effort — a turn that fails to store costs the next follow-up its
    // context, which is not worth failing a request the user can still be
    // answered.
    try {
      await appendMessage({ conversationId, role: "user", content: parsed.data.message });
    } catch (error) {
      console.error("agent-chat user turn write failed:", error);
    }

    // The full render envelope — assembled ONCE and used for two purposes below:
    // returned to the client to drive the live Career Navigator, and persisted as
    // the assistant turn's render snapshot so a reload rebuilds that same UI.
    // Building it once is what keeps the stored snapshot and the live response
    // guaranteed identical — they are the same object, not two constructions that
    // could drift. `external` and `tools` come from result.careerData (the
    // in-memory envelope); this is the only place they are captured in structured
    // form, so the snapshot is the sole way those tabs survive a reload.
    const cd = result.careerData;
    const responsePayload = {
      intent: result.intent,
      plan: result.plan,
      sections: result.sections,
      external: {
        roadmaps: cd?.roadmaps ?? [],
        marketSignals: cd?.marketSignals ?? [],
        industryArticles: cd?.industryArticles ?? [],
        // Structured company entities for the Hiring Companies section (entity
        // discovery). Empty unless the live-hiring lane fired and extraction ran.
        hiringCompanies: cd?.hiringCompanyEntities ?? [],
      },
      // MCP provenance for the "Tools Used" indicator: which tools ran and over
      // which transport (mcp / direct fallback / skipped).
      tools: cd?.toolCalls ?? [],
      verification: result.verification,
      evaluation: result.evaluation,
    };

    // Store the assistant's turn. Two representations, on purpose:
    //   - `content`: the WHOLE response flattened to text, so a follow-up like "and
    //     the roadmap for that?" has the roadmap, skills, next steps and resource
    //     titles to resolve against — the same thing the user saw. This is what the
    //     prompt-history window reads.
    //   - `response`: the full structured envelope above, so reopening the thread
    //     restores the exact Career Navigator, not just the transcript text.
    // `recommendationId` links this turn to the ai_recommendations row behind it,
    // which is what makes a message the user can point at joinable to the run that
    // produced it. The turn is stored even when the flattened text is empty, so the
    // snapshot is never lost to an empty summary.
    try {
      const assistantTurn = summarizeAssistantTurn(result.sections);
      await appendMessage({
        conversationId,
        role: "assistant",
        content: assistantTurn || "Here's what I found for you.",
        response: responsePayload,
        recommendationId: result.recommendationId,
      });
    } catch (error) {
      console.error("agent-chat assistant turn write failed:", error);
    }

    return NextResponse.json(
      {
        // Echoed so the client can send it with the next message. On the first
        // message of a thread this is the only place the id exists.
        conversationId,
        ...responsePayload,
        // Per-run token totals. Surfaced on the response as well as persisted so
        // the cost of a turn is visible while developing without querying the DB.
        // Read-only reporting — nothing acts on these numbers yet, by design:
        // the allocator comes after there is a measured distribution to size it
        // against. NOT part of the render snapshot — it is dev telemetry, not UI.
        usage: summarizeUsage(usageRows),
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("agent-chat graph error:", error);
    // Record what the failed run spent before anything else.
    await flushUsage(usageRows);
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
        // A failed run has no recommendation, so this column is the only thing
        // tying it to the conversation it broke.
        conversationId,
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
