import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth/session";
import { chatSchema } from "../../../lib/chat/validation";
import { agentGraph } from "../../../lib/agent/graph";

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

  try {
    const result = await agentGraph.invoke({
      userId: session.userId,
      query: parsed.data.message,
      // persist defaults true: the graph updates memory and logs the turn.
    });

    return NextResponse.json(
      {
        intent: result.intent,
        plan: result.plan,
        sections: result.sections,
        verification: result.verification,
        evaluation: result.evaluation,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("agent-chat graph error:", error);
    return NextResponse.json(
      { error: "The assistant is unavailable right now. Please try again." },
      { status: 502 }
    );
  }
}
