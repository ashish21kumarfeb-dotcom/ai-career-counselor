// Data-access helpers for `conversations` and `conversation_messages`.
//
// This module is the server's replacement for the client-held turn list. Every
// helper that takes a conversation id ALSO takes a user id and filters on it —
// see openConversation below for why that is not defensive boilerplate.
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { conversationMessages, conversations } from "../../db/schema";
import type { ChatTurn } from "../ai/resolveQuery";

// Read bounds for the history window, enforced HERE rather than trusted from the
// consumer, on the same reasoning as MAX_MEMORY_ROWS in memory/queries.ts: this
// query decides part of the prompt's size, so it must be the thing that bounds it.
//
// A conversation grows without limit. The turns are written by the pipeline, but
// this is the read, and the read is what feeds resolve_query's rewriter. Without a
// cap the prompt for turn 200 contains 199 prior turns and the cost of a follow-up
// grows linearly with how long the user has been talking — the failure is silent,
// gradual, and lands as a latency and bill problem long after the change that
// caused it.
//
// 12 turns x 1500 chars ~= 18 KB worst case, roughly 4.5k tokens. resolve_query
// clips further (6 turns x 500 chars) — these are the outer bound, not the
// working set, so a future consumer that wants more context than the rewriter
// does cannot accidentally unbound itself.
export const MAX_HISTORY_TURNS = 12;
export const MAX_MESSAGE_CHARS = 1500;

// Create a thread for this user. `title` is the trimmed opening message; it is a
// display label only and is never fed back into a prompt.
export async function createConversation(
  userId: string,
  title?: string
): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId, title: title?.trim().slice(0, 120) || null })
    .returning({ id: conversations.id });
  return rows[0].id;
}

// Resolve a caller-supplied conversation id to a thread THIS user owns.
//
// The ownership filter is the entire point of the function. A conversation id is
// a bearer token for a chat history the moment it is accepted without one: the id
// arrives in a request body, so any authenticated user could paste another user's
// id and have the server load that person's turns into the prompt — and, worse,
// append to their thread. Filtering on user_id in the same WHERE clause means a
// mismatched pair is indistinguishable from a nonexistent one, which is also why
// this returns undefined rather than throwing a distinguishable "not yours".
export async function openConversation(
  conversationId: string,
  userId: string
): Promise<string | undefined> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  return rows[0]?.id;
}

// Append one turn. Content is clipped at the WRITE as well as the read: a stored
// turn that is larger than the window will ever surface is dead weight in the
// table and a trap for any future reader that forgets to clip.
export async function appendMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  recommendationId?: string;
  // The full render snapshot for an assistant turn (see conversation_messages.response
  // in schema.ts). Stored UNCLIPPED — unlike `content`, which is bounded because it
  // feeds the prompt window; this is replayed into the UI, not into a prompt. Undefined
  // for user turns.
  response?: unknown;
}): Promise<void> {
  await db.insert(conversationMessages).values({
    conversationId: input.conversationId,
    role: input.role,
    content: input.content.trim().slice(0, MAX_MESSAGE_CHARS),
    response: input.response,
    recommendationId: input.recommendationId,
  });
  // Bump the thread's recency so the (future) conversation list can order by it.
  // Same statement count as a trigger would cost on this driver, and visible here.
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, input.conversationId));
}

// The bounded history window: the most recent turns of this thread, oldest first.
//
// Selected DESC (so the LIMIT keeps the NEWEST turns — a limit over an ascending
// scan would keep the oldest, which is exactly backwards) and reversed in memory,
// because every consumer wants chronological order.
export async function getRecentTurns(
  conversationId: string,
  limit: number = MAX_HISTORY_TURNS
): Promise<ChatTurn[]> {
  const rows = await db
    .select({
      role: conversationMessages.role,
      content: conversationMessages.content,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .map((row) => ({
      role: row.role,
      content:
        row.content.length > MAX_MESSAGE_CHARS
          ? `${row.content.slice(0, MAX_MESSAGE_CHARS - 1)}…`
          : row.content,
    }));
}

// A user's threads, most recently active first. No read path in the request flow
// yet — the conversation list UI is the next step; this exists so the ordering
// index above has the query it was created for.
export async function listConversations(userId: string, limit: number = 30) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

// Full thread, oldest first. Same ownership rule as openConversation: callers pass
// a user id and a thread that is not theirs reads as empty.
export async function getConversationMessages(
  conversationId: string,
  userId: string
) {
  const owned = await openConversation(conversationId, userId);
  if (!owned) return [];
  return db
    .select({
      role: conversationMessages.role,
      content: conversationMessages.content,
      // The render snapshot, when present. Assistant turns written after this
      // column landed carry the full AgentResponse envelope here; user turns and
      // legacy assistant turns are null and rehydrate as text only.
      response: conversationMessages.response,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(asc(conversationMessages.createdAt));
}
