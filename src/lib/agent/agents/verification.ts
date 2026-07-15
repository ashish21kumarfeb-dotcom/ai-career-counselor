// Verification Agent (SRS §6.5 reflection) — the enforcing gate.
//
// Two layers:
//   1) DETERMINISTIC HARD CHECKS (always run, no LLM): every agency/resource/course
//      in the draft must trace back to the Career Data Agent output, and every
//      section key must be in the plan. Anything invented or unplanned is SANITIZED
//      out (removed) and recorded as an issue. These checks give verification real
//      teeth — they can flip `approved` to false and change the response.
//   2) SOFT LLM CHECK (optional, fault-tolerant): judges the free-text sections for
//      grounding/safety.
//
// Correction #1 (no silent permissive success): if the soft check errors or returns
// invalid output, it is marked UNAVAILABLE — grounded/safe are NOT reported as
// confidently true, and the unavailability is recorded in issues/notes. The
// deterministic checks still run and still decide the outcome.
//
// The soft check is dependency-injected (opts.softCheck) so every branch is testable
// deterministically without hitting the model; the default is the real Groq call.
import { z } from "zod";
import { getGroq, CHAT_MODEL } from "../../ai/client";
import { verificationAgentOutputSchema } from "./contracts";
import type { AgentPlan, ResponseSections, SectionName } from "../schema";
import type {
  CareerDataAgentOutput,
  VerificationAgentInput,
  VerificationAgentOutput,
} from "./contracts";

// Safe replacement for free-text sections when the soft check flags them unsafe.
export const SAFE_FALLBACK_TEXT =
  "To keep this grounded and safe, here is a careful summary: review the verified resources and steps shown below. Career outcomes depend on your skills, preparation, and market demand — there are no guarantees.";

// Stable identity for an agency, so an invented agency (name/source/website not in
// the Career Data output) is detected regardless of item ordering.
//
// JSON.stringify over the field tuple, NOT a delimiter join: on a plain space
// {name:"Acme X", source:"Y"} and {name:"Acme", source:"X Y"} collapse to the same
// key, letting a re-split of a verified agency's fields pass the subset check below.
// JSON escapes each field, so no value can forge a boundary. It also keeps this file
// pure ASCII: the raw NUL separator this replaces was unambiguous too, but tripped
// git's binary detection, silently costing the repo a reviewable diff on the one file
// where review matters most.
function agencyIdentity(a: { name: string; source: string | null; website: string | null }): string {
  return JSON.stringify([a.name, a.source ?? "", a.website ?? ""]);
}

// --- Invented-provider detection in free text ----------------------------------
// The subset checks below only cover the DB-backed sections. The LLM-authored free
// text is a subset of nothing, so an agency NAMED in prose ("reach out to ABC
// Career Consultancy") has no hard check to fail — and the only reader of that
// prose, the soft check, is allowed to be unavailable. agencyGate can veto the
// agencies SECTION while the same provider walks through in a sentence.
//
// Detection is suffix-anchored: a capitalized name followed by a provider word. A
// bare proper noun ("Korn Ferry") is indistinguishable from a tool or role name
// ("Power BI") without a name list, so it is deliberately out of scope — this
// catches the shape an invented provider takes, not every conceivable one.
const PROVIDER_SUFFIX =
  "Consultanc(?:y|ies)|Consultants?|Consulting|Advisors?|Advisory|Agenc(?:y|ies)|Placements?|Careers|Partners|Associates|Mentors?|Counsell?ors?|Coaches|Coaching";

const PROVIDER_NAME = new RegExp(
  `\\b([A-Z][\\w&.'-]*(?:\\s+[A-Z][\\w&.'-]*)*\\s+(?:${PROVIDER_SUFFIX}))\\b`,
  "g"
);

// Words that make a match a GENERIC phrase ("Career Counsellors", "Top Placement
// Agencies") rather than a name ("ABC Career Consultancy"). A match must carry at
// least one distinctive token beyond these and the suffix to count as a provider
// NAME — generic advice to see a counsellor is the planner's call to gate, not an
// invented record.
const GENERIC_NAME_WORDS = new Set([
  "career", "careers", "placement", "placements", "job", "jobs", "professional",
  "professionals", "local", "online", "top", "best", "good", "reputable", "some",
  "many", "several", "most", "few", "other", "various", "experienced", "certified",
  "independent", "specialist", "specialised", "specialized", "qualified",
  "the", "a", "an", "your", "our", "their", "these", "those", "such",
]);

function isProviderName(match: string): boolean {
  // Drop the trailing suffix word; what precedes it must carry a distinctive token.
  const lead = match.split(/\s+/).slice(0, -1);
  return lead.some(
    (t) => !GENERIC_NAME_WORDS.has(t.toLowerCase().replace(/[^a-z0-9&]/g, ""))
  );
}

// Substring match in both directions so a verified "Pune Career Consultancy Pvt
// Ltd" still covers prose that shortens it to "Pune Career Consultancy".
function isVerifiedProvider(match: string, allowed: string[]): boolean {
  const m = match.toLowerCase();
  return allowed.some((name) => {
    const n = name.toLowerCase();
    return n.includes(m) || m.includes(n);
  });
}

function freeTextOf(sections: ResponseSections): string[] {
  return [
    sections.ai_suggestion ?? "",
    ...(sections.roadmap?.items ?? []),
    ...(sections.skill_focus ?? []),
    ...(sections.next_steps ?? []),
  ].filter((t) => t.trim().length > 0);
}

// The distinct provider names the free text mentions that no verified record backs.
// Empty agency names are dropped from the allowlist — a blank would otherwise
// substring-match everything and allow any invented name through. Exported for tests.
export function inventedProviders(
  sections: ResponseSections,
  agencies: { name: string }[]
): string[] {
  const allowed = agencies.map((a) => a.name.trim()).filter(Boolean);
  const found = new Set<string>();
  for (const text of freeTextOf(sections)) {
    for (const [, name] of text.matchAll(PROVIDER_NAME)) {
      if (!isProviderName(name)) continue;
      if (isVerifiedProvider(name, allowed)) continue;
      found.add(name);
    }
  }
  return [...found];
}

// --- Layer 1: deterministic hard checks + sanitization (pure) ------------------
// Returns a sanitized copy of the draft plus the list of hard issues found. Never
// throws. Exported for direct testing.
export function sanitizeDraft(
  input: VerificationAgentInput
): { finalSections: ResponseSections; hardIssues: string[] } {
  const finalSections: ResponseSections = structuredClone(input.draftSections);
  const hardIssues: string[] = [];
  const planned = new Set<SectionName>(input.plan.sections);

  // 1. Remove any section not in the plan.
  for (const key of Object.keys(finalSections) as (keyof ResponseSections)[]) {
    if (!planned.has(key as SectionName)) {
      delete finalSections[key];
      hardIssues.push(`Removed unplanned section "${key}" (not in the plan).`);
    }
  }

  // 2. Agencies must be a subset of the Career Data Agent's agencies.
  if (finalSections.agencies) {
    const allowed = new Set(input.careerData.agencies.map(agencyIdentity));
    const before = finalSections.agencies.items.length;
    const kept = finalSections.agencies.items.filter((a) => allowed.has(agencyIdentity(a)));
    if (kept.length !== before) {
      hardIssues.push(`Removed ${before - kept.length} agency item(s) not backed by verified records.`);
      finalSections.agencies =
        kept.length > 0 ? { items: kept } : { items: [], note: "No verified agencies found for this query." };
    }
  }

  // 3. Resource URLs must be a subset of the Career Data Agent's resources.
  if (finalSections.resources) {
    const allowed = new Set(input.careerData.resources.map((r) => r.url));
    const before = finalSections.resources.items.length;
    const kept = finalSections.resources.items.filter((r) => allowed.has(r.url));
    if (kept.length !== before) {
      hardIssues.push(`Removed ${before - kept.length} resource link(s) not backed by retrieved data.`);
      finalSections.resources =
        kept.length > 0 ? { items: kept } : { items: [], note: "No verified resources found for this query." };
    }
  }

  // 4. Course URLs must be a subset of the Career Data Agent's courses.
  if (finalSections.courses) {
    const allowed = new Set(input.careerData.courses.map((c) => c.url));
    const before = finalSections.courses.items.length;
    const kept = finalSections.courses.items.filter((c) => allowed.has(c.url));
    if (kept.length !== before) {
      hardIssues.push(`Removed ${before - kept.length} course link(s) not backed by retrieved data.`);
      finalSections.courses =
        kept.length > 0 ? { items: kept } : { items: [], note: "No verified courses found for this query." };
    }
  }

  // 5. Free text must not NAME a provider that no verified record backs. There is
  // nothing to subset the prose against, so the remedy is the one the soft check
  // already uses — replace the free text with the safe summary — but decided here,
  // deterministically, so it holds when the soft check is unavailable.
  const invented = inventedProviders(finalSections, input.careerData.agencies);
  if (invented.length > 0) {
    hardIssues.push(
      `Removed free-text naming unverified provider(s): ${invented.join("; ")}.`
    );
    applyUnsafeFallback(finalSections, input.plan);
  }

  return { finalSections, hardIssues };
}

// Replace/remove free-text sections when the soft check flags the answer unsafe.
// Keeps the verified DB sections; only planned free-text is affected.
function applyUnsafeFallback(sections: ResponseSections, plan: AgentPlan): void {
  if (plan.sections.includes("ai_suggestion")) {
    sections.ai_suggestion = SAFE_FALLBACK_TEXT;
  } else {
    delete sections.ai_suggestion;
  }
  delete sections.roadmap;
  delete sections.skill_focus;
  delete sections.next_steps;
}

// --- Layer 2: soft LLM check (injectable) --------------------------------------
export type SoftCheckResult = { available: boolean; grounded: boolean; safe: boolean; notes: string };
export type SoftCheckFn = (
  query: string,
  sections: ResponseSections,
  careerData: CareerDataAgentOutput
) => Promise<SoftCheckResult>;

const verifySchema = z.object({ grounded: z.boolean(), safe: z.boolean(), notes: z.string() });

const VERIFY_PROMPT = `You are a verification/reflection agent for an AI career counselor. Review the draft answer against the user's question and the sources that were available. Respond with a single JSON object: {"grounded": bool, "safe": bool, "notes": "one short sentence"}.
- grounded = false if the draft states specific facts, agencies, courses, or links that are NOT supported by the available sources, or presents a suggested roadmap as if it were verified data.
- safe = false if it guarantees jobs/interviews/salaries, invents agencies, or gives overconfident/biased advice.
- Otherwise both true. Keep notes short.`;

// Default soft check: a real Groq call. Fault-tolerant — any error or invalid output
// returns available:false (NOT a permissive grounded/safe:true).
export async function runSoftCheck(
  query: string,
  sections: ResponseSections,
  careerData: CareerDataAgentOutput
): Promise<SoftCheckResult> {
  const draft = {
    ai_suggestion: sections.ai_suggestion,
    roadmap: sections.roadmap,
    skill_focus: sections.skill_focus,
    next_steps: sections.next_steps,
  };
  const hasFreeText =
    !!sections.ai_suggestion?.trim() ||
    (sections.roadmap?.items.length ?? 0) > 0 ||
    (sections.skill_focus?.length ?? 0) > 0 ||
    (sections.next_steps?.length ?? 0) > 0;

  // Nothing free-text to judge (e.g. a pure agency/DB response) -> trivially fine.
  if (!hasFreeText) {
    return { available: true, grounded: true, safe: true, notes: "No free-text sections to verify." };
  }

  try {
    const agencyNames = careerData.agencies.map((a) => a.name);
    const resourceLinks = [...careerData.resources, ...careerData.courses]
      .map((r) => r.url)
      .filter(Boolean);
    const availability = [
      `Available verified agencies (${agencyNames.length}): ${agencyNames.join("; ") || "none"}.`,
      `Available resource/course links (${resourceLinks.length}): ${resourceLinks.join("; ") || "none"}.`,
      `Knowledge docs: ${careerData.ragDocs.length}.`,
      `Note: mentioning any agency or link from the lists above IS grounded.`,
    ].join("\n");

    const completion = await getGroq().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: VERIFY_PROMPT },
        { role: "user", content: `User query: ${JSON.stringify(query)}\n${availability}\nDraft text sections: ${JSON.stringify(draft)}` },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = verifySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { available: false, grounded: false, safe: false, notes: "Soft verification output invalid; grounding/safety not confirmed." };
    }
    return { available: true, grounded: parsed.data.grounded, safe: parsed.data.safe, notes: parsed.data.notes };
  } catch (error) {
    console.error("Soft verification unavailable:", error);
    return { available: false, grounded: false, safe: false, notes: "Soft verification unavailable (LLM error); grounding/safety not confirmed." };
  }
}

// The correction brief handed BACK to the Recommendation Agent when a draft is
// rejected. Deterministic — built from the issues the checks already produced,
// plus the standing grounding rules the draft evidently broke. No LLM: asking a
// model to explain why another model failed adds a failure mode and buys nothing
// the issue list does not already say.
//
// Undefined when there is nothing to fix, so `recommendedFix` being present is
// itself the signal that a regeneration has something to act on.
export function buildRecommendedFix(issues: string[]): string | undefined {
  if (issues.length === 0) return undefined;
  return [
    "Rewrite the free-text sections so that every one of the problems below is gone.",
    "Use ONLY the agencies, courses and links supplied in the context — if the context lists none, name none.",
    "Do not invent providers, companies, statistics or salaries, and do not guarantee jobs, interviews or outcomes.",
  ].join(" ");
}

// --- Agent entrypoint ----------------------------------------------------------
export async function runVerificationAgent(
  input: VerificationAgentInput,
  opts?: { softCheck?: SoftCheckFn }
): Promise<VerificationAgentOutput> {
  const softCheck = opts?.softCheck ?? runSoftCheck;

  // Layer 1 — always runs.
  const { finalSections, hardIssues } = sanitizeDraft(input);
  const issues = [...hardIssues];

  // Layer 2 — judged against the already-sanitized free text.
  const soft = await softCheck(input.query, finalSections, input.careerData);
  const softCheckAvailable = soft.available;

  // Correction #1: never report grounded/safe as true when the check didn't run.
  const grounded = soft.available ? soft.grounded : false;
  const safe = soft.available ? soft.safe : false;

  // Fallback only on a KNOWN unsafe result (available + safe=false). An unavailable
  // check does NOT trigger fallback and does NOT block approval on its own.
  if (softCheckAvailable && !soft.safe) {
    applyUnsafeFallback(finalSections, input.plan);
    issues.push("Soft verification flagged the answer as unsafe; free-text was replaced with a safe summary.");
  }
  if (!softCheckAvailable) {
    issues.push(`Soft verification unavailable: ${soft.notes}`);
  }

  const approved = hardIssues.length === 0 && !(softCheckAvailable && !soft.safe);

  const noteParts: string[] = [approved ? "Passed verification." : "Verification applied corrections."];
  if (!softCheckAvailable) noteParts.push("Soft grounding/safety check was not available — not confirmed.");
  else if (soft.notes) noteParts.push(soft.notes);
  const verificationNotes = noteParts.join(" ");

  const output: VerificationAgentOutput = {
    approved,
    grounded,
    safe,
    softCheckAvailable,
    issues,
    verificationNotes,
    // Only meaningful when the draft was rejected — this is what the
    // Recommendation Agent regenerates against.
    recommendedFix: approved ? undefined : buildRecommendedFix(issues),
    finalSections,
  };

  // Validate the output contract at the hand-off boundary, matching the Profile
  // and Career Data agents. Log and return the constructed (correctly shaped)
  // output rather than throwing into the graph.
  const parsed = verificationAgentOutputSchema.safeParse(output);
  if (!parsed.success) {
    console.error("Verification Agent output failed contract validation:", parsed.error);
  }
  return output;
}
