import { NextResponse } from "next/server";
import { getSession } from "../../../lib/auth/session";
import { listConversations } from "../../../lib/conversations/queries";

// GET /api/conversations — this user's threads, most recently active first.
//
// The read half of Phase 5: the write path (POST /api/agent-chat) already
// creates threads and stores turns; this is what a client needs to resume one.
// User-scoped by construction — listConversations filters on the session user,
// so there is no id to check and no way to enumerate another user's threads.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const conversations = await listConversations(session.userId);
    return NextResponse.json({ conversations }, { status: 200 });
  } catch (error) {
    console.error("conversations list failed:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
