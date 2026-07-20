import { z } from "zod";

// One prior conversation turn the client sends so the pipeline can resolve
// follow-up references. Optional and bounded — older/empty callers stay valid.
const chatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
});

// Validation for the chat API input. Mirrors the profile/auth validation style.
export const chatSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(4000),
  // Recent turns of the active conversation (most recent last). Used only to
  // rewrite a follow-up into a standalone query; capped to keep the request small.
  history: z.array(chatTurnSchema).max(20).optional(),
});

export type ChatInput = z.infer<typeof chatSchema>;
