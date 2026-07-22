import { z } from "zod";

// Validation for the chat API input. Mirrors the profile/auth validation style.
//
// NOTE THE ABSENCE OF `history`. The client used to send the recent turns back
// with every message and the server fed them to resolve_query's rewriter. That is
// gone: the server now loads the window from `conversation_messages` itself
// (src/lib/conversations/queries.ts). The removal is the security half of the
// change, not a refactor — conversation history is model-visible context, so a
// client-supplied array was an unauthenticated write into the prompt, and no
// amount of screening makes fabricated prior turns as trustworthy as the ones the
// server wrote itself. It also removes the possibility of the two disagreeing
// about what was said.
export const chatSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(4000),
  // The thread this message belongs to. Omitted on the first message of a new
  // conversation, in which case the route creates one and returns its id. A
  // supplied id is resolved against the caller's own threads before it is used.
  conversationId: z.string().uuid().optional(),
});

export type ChatInput = z.infer<typeof chatSchema>;
