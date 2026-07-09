import { z } from "zod";

// Validation for the chat API input. Mirrors the profile/auth validation style.
export const chatSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(4000),
});

export type ChatInput = z.infer<typeof chatSchema>;
