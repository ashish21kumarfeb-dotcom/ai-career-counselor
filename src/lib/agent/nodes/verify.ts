// Verify node (SRS reflection step): a lightweight LLM pass that reviews the
// GENERATED text sections against the user query and the sources that were
// actually available, recording whether the answer is grounded and safe. It does
// not rewrite the answer in this POC — it records a verdict on state.verification
// (a future step can loop back to regenerate when grounded/safe is false).
// Fault-tolerant: on any failure it defaults to a permissive verdict with a note,
// so verification never blocks the response.
import { z } from "zod";
import { getGroq, CHAT_MODEL } from "../../ai/client";
import type { AgentStateType } from "../state";
import type { Verification } from "../schema";

const verifySchema = z.object({
  grounded: z.boolean(),
  safe: z.boolean(),
  notes: z.string(),
});

const VERIFY_PROMPT = `You are a verification/reflection agent for an AI career counselor. Review the draft answer against the user's question and the sources that were available. Respond with a single JSON object: {"grounded": bool, "safe": bool, "notes": "one short sentence"}.
- grounded = false if the draft states specific facts, agencies, courses, or links that are NOT supported by the available sources, or presents a suggested roadmap as if it were verified data.
- safe = false if it guarantees jobs/interviews/salaries, invents agencies, or gives overconfident/biased advice.
- Otherwise both true. Keep notes short.`;

export async function verifyNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const s = state.sections;
  const draft = {
    ai_suggestion: s?.ai_suggestion,
    roadmap: s?.roadmap,
    next_steps: s?.next_steps,
  };
  // Give the verifier the actual available source identifiers (not just counts) so
  // it can confirm that any agency/link the draft mentions is legitimately grounded.
  const agencyNames = state.toolResults.agencies.map((a) => a.name);
  const resourceLinks = state.toolResults.resources.map((d) => d.sourceUrl).filter(Boolean);
  const availability = [
    `Available verified agencies (${agencyNames.length}): ${agencyNames.join("; ") || "none"}.`,
    `Available resource links (${resourceLinks.length}): ${resourceLinks.join("; ") || "none"}.`,
    `Knowledge docs: ${state.ragDocs.length}. Profile: ${state.profile ? "present" : "absent"}.`,
    `Note: mentioning any agency or link from the lists above IS grounded.`,
  ].join("\n");

  let verification: Verification;
  try {
    const completion = await getGroq().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: VERIFY_PROMPT },
        {
          role: "user",
          content: `User query: ${JSON.stringify(state.query)}\n${availability}\nDraft text sections: ${JSON.stringify(draft)}`,
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = verifySchema.safeParse(JSON.parse(raw));
    verification = parsed.success
      ? parsed.data
      : { grounded: true, safe: true, notes: "verification output invalid; not enforced" };
  } catch (error) {
    console.error("Verification failed; defaulting to permissive verdict:", error);
    verification = { grounded: true, safe: true, notes: "verification skipped (error)" };
  }

  return { verification };
}
