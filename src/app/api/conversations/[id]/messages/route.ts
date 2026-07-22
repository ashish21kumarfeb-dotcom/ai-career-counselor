import { NextResponse } from "next/server";
import { getSession } from "../../../../../lib/auth/session";
import { getConversationMessages } from "../../../../../lib/conversations/queries";

// GET /api/conversations/[id]/messages — the full transcript of one thread,
// oldest first, for rehydrating a conversation on reload.
//
// Ownership is enforced INSIDE getConversationMessages: it takes the session
// user and returns [] for a thread that is not theirs (or does not exist). A
// conversation id travels in the URL, so an unchecked read would let any
// authenticated user load someone else's history — the same threat the POST
// route guards against. A not-owned/nonexistent id is reported as 404, never
// 403: distinguishing "exists but not yours" from "does not exist" is itself the
// leak. `params` is a Promise in this Next.js — it must be awaited.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const messages = await getConversationMessages(id, session.userId);
    // Empty is ambiguous by design: a real thread the user has not written to yet
    // and a thread that is not theirs both read as []. Only a thread with turns is
    // distinguishable, and only to its owner. The client treats an empty transcript
    // for a supplied id as "nothing to resume" and starts fresh.
    return NextResponse.json({ messages }, { status: 200 });
  } catch (error) {
    console.error("conversation messages read failed:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
