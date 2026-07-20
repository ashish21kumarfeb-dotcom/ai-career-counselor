import Groq from "groq-sdk";

// Server-only Groq client. The SDK reads GROQ_API_KEY from the environment, so
// the key is never bundled or sent to the browser. Do NOT import this module
// from a "use client" component.
//
// The client is created lazily so a missing key fails only the chat route with a
// clear message, rather than throwing at import time for the whole app.

let client: Groq | null = null;

export function getGroq(): Groq {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set");
  }
  client ??= new Groq();
  return client;
}

// Model is env-overridable. Default: Llama 3.3 70B Versatile (a current Groq
// production model, verified against Groq's docs). Set GROQ_MODEL in .env to
// switch (e.g. GROQ_MODEL=openai/gpt-oss-120b).
export const CHAT_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

// A smaller, faster Groq model for the cheap intent-classification pass that
// runs before the main answer. Kept separate from CHAT_MODEL so classification
// stays fast/cheap without downgrading the answer. Override with
// GROQ_INTENT_MODEL in .env.
export const INTENT_MODEL =
  process.env.GROQ_INTENT_MODEL ?? "llama-3.1-8b-instant";

// Model for the context-aware query-resolution pass (rewriting a follow-up into a
// standalone question before the pipeline runs). Defaults to the cheap INTENT_MODEL
// since the task is a small, structured rewrite; override with GROQ_REWRITE_MODEL.
export const REWRITE_MODEL =
  process.env.GROQ_REWRITE_MODEL ?? INTENT_MODEL;
