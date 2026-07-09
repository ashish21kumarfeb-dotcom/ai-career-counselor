import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth/session";
import { getProfileByUserId } from "../../../lib/profile/queries";
import { chatSchema } from "../../../lib/chat/validation";
import { logRecommendation } from "../../../lib/chat/queries";
import { getGroq, CHAT_MODEL } from "../../../lib/ai/client";
import { buildSystemPrompt } from "../../../lib/ai/prompt";
import { classifyIntent } from "../../../lib/ai/intent";
import { searchDocuments } from "../../../lib/documents/queries";
import { getMemoryByUserId, upsertMemory } from "../../../lib/memory/queries";
import { extractMemories } from "../../../lib/ai/memory";

// Extract durable facts from the user's message and upsert them to memory. Runs
// concurrently with answer generation and must never fail the chat response —
// extractMemories is already fault-tolerant; this guards the DB writes too.
async function writeMemoryFromMessage(userId: string, message: string) {
  try {
    const facts = await extractMemories(message);
    for (const fact of facts) {
      await upsertMemory(userId, fact.key, fact.value);
    }
  } catch (error) {
    console.error("Memory write failed:", error);
  }
}

// Chat slice: non-streaming, single-turn. Input -> intent extraction + profile +
// context (memory + RAG retrieval) -> (personalized, source-grounded system
// prompt + guardrails) -> Groq -> answer, logged to ai_recommendations with its
// intent and sources used. Durable facts from the message are written back to
// memory. No agents or streaming yet.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
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

  const message = parsed.data.message;

  // Extract intent (cheap, fast model), load the user's profile row, retrieve
  // grounding documents, and read stored memory in parallel — all independent.
  // Profile is undefined if they somehow reach chat without one; the prompt
  // module handles that. sources/memory are [] when nothing is found. Memory
  // reflects PRIOR turns; this turn's facts are written back below.
  const [intent, profile, sources, memory] = await Promise.all([
    classifyIntent(message),
    getProfileByUserId(session.userId),
    searchDocuments(message),
    getMemoryByUserId(session.userId),
  ]);
  const systemPrompt = buildSystemPrompt(profile, sources, memory);

  // Fire memory extraction + write concurrently with answer generation — it only
  // needs the user message, so it adds no wall-clock latency. Awaited before the
  // response so it completes within the request (serverless-safe).
  const memoryWrite = writeMemoryFromMessage(session.userId, message);

  let answer: string;
  try {
    const completion = await getGroq().chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
    });
    answer = completion.choices[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    console.error("Chat model error:", error);
    await memoryWrite; // settle the in-flight write (self-guarded) before returning
    return NextResponse.json(
      { error: "The assistant is unavailable right now. Please try again." },
      { status: 502 }
    );
  }

  await memoryWrite; // self-guarded: logs its own errors, never throws

  if (!answer) {
    return NextResponse.json(
      { error: "The assistant returned an empty response. Please try again." },
      { status: 502 }
    );
  }

  // Log the turn to ai_recommendations. Never let a logging failure fail the
  // request — return the answer, but surface the DB error clearly on the server.
  try {
    await logRecommendation({
      userId: session.userId,
      query: message,
      finalAnswer: answer,
      intent,
      sourcesUsed: sources.length
        ? sources.map((s) => ({ id: s.id, type: s.type, sourceUrl: s.sourceUrl }))
        : undefined,
    });
  } catch (error) {
    console.error("ai_recommendations logging failed:", error);
  }

  return NextResponse.json({ answer }, { status: 200 });
}
