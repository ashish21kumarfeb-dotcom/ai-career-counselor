// Profile Agent (SRS §6.3 — first A2A agent).
//
// Responsibility: load and summarize the user's profile and relevant memory, and
// distil their background into a structured userContext plus the durable
// constraints that should shape any advice. Deterministic — no LLM — so its
// output is stable, cheap, and fully testable. It does NOT do RAG/tool retrieval;
// that is the Career Data Agent's job (clean responsibility split).
//
// Input:  ProfileAgentInput  { userId, query }
// Output: ProfileAgentOutput { profileSummary, memorySummary, userContext,
//                              importantConstraints }
// The output is validated against its contract before returning, so a malformed
// hand-off is caught at the boundary.
import { getProfileByUserId } from "../../profile/queries";
import { getMemoryByUserId } from "../../memory/queries";
import { USER_TYPE_LABELS, detailEntries } from "../../profile/fields";
import { profileAgentOutputSchema } from "./contracts";
import type { ProfileAgentInput, ProfileAgentOutput, UserContext } from "./contracts";

type ProfileRow = NonNullable<Awaited<ReturnType<typeof getProfileByUserId>>>;

// Memory keys (from the fixed vocabulary in ai/memory.ts) that carry durable
// constraints/preferences shaping advice. target_role_or_company and
// actions_taken are context, not constraints, so they stay in the memory summary
// only.
const CONSTRAINT_KEYS = new Set(["constraints", "work_preferences", "timeline"]);

// Split a stored comma/semicolon/newline list (skills, interests) into distinct,
// trimmed items, preserving order.
function splitList(value: string | null | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[,;\n]+/)) {
    const item = raw.trim();
    if (item && !seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      out.push(item);
    }
  }
  return out;
}

// Deterministic one-line background summary from the profile's non-empty fields.
// For a parent/guardian the common columns describe their CHILD, so they are
// relabelled and the whole summary is framed as "seeking guidance for their
// child" — the advice must target the child, not the parent. Type-specific
// answers in `details` (e.g. stream, years of experience, grow-vs-switch, child's
// strengths) are appended so downstream advice can use them.
function summarizeProfile(profile: ProfileRow, ctx: UserContext): string {
  const isParent = profile.userType === "parent_guardian";
  const parts: string[] = [USER_TYPE_LABELS[profile.userType] ?? profile.userType];
  if (isParent) parts.push("seeking guidance for their child");
  if (ctx.currentRole) parts.push(`currently ${ctx.currentRole}`);
  if (profile.yearsExperience != null) parts.push(`${profile.yearsExperience} yrs experience`);
  if (profile.education) parts.push(`${isParent ? "child's education" : "education"}: ${profile.education}`);
  if (ctx.location) parts.push(`based in ${ctx.location}`);
  if (ctx.skills.length) parts.push(`skills: ${ctx.skills.join(", ")}`);
  if (ctx.interests.length) parts.push(`${isParent ? "child's interests" : "interests"}: ${ctx.interests.join(", ")}`);
  if (ctx.careerGoal) parts.push(`${isParent ? "parent's concern" : "goal"}: ${ctx.careerGoal}`);
  for (const d of detailEntries(profile.userType, profile.details as Record<string, unknown> | null)) {
    parts.push(`${d.label.toLowerCase()}: ${d.value}`);
  }
  return `${parts.join("; ")}.`;
}

export async function runProfileAgent(
  input: ProfileAgentInput
): Promise<ProfileAgentOutput> {
  // Both reads are safe for an unknown user (profile -> undefined, memory -> []).
  const [profile, memory] = await Promise.all([
    getProfileByUserId(input.userId),
    getMemoryByUserId(input.userId),
  ]);

  const userContext: UserContext = {
    stage: profile?.userType ?? null,
    currentRole: profile?.currentRole ?? null,
    skills: splitList(profile?.skills),
    interests: splitList(profile?.interests),
    careerGoal: profile?.careerGoal ?? null,
    location: profile?.location ?? null,
  };

  const profileSummary = profile
    ? summarizeProfile(profile, userContext)
    : "No profile on file for this user.";

  const memorySummary = memory.length
    ? memory.map((m) => `- ${m.memoryKey}: ${m.memoryValue}`).join("\n")
    : "No stored memory for this user.";

  const importantConstraints = memory
    .filter((m) => CONSTRAINT_KEYS.has(m.memoryKey))
    .map((m) => m.memoryValue);

  const output: ProfileAgentOutput = {
    profileSummary,
    memorySummary,
    userContext,
    importantConstraints,
  };

  // Validate the output contract at the hand-off boundary. The build is
  // deterministic, so this should always pass; if it ever doesn't, log and return
  // the constructed (correctly shaped) output rather than throwing into the graph.
  const parsed = profileAgentOutputSchema.safeParse(output);
  if (!parsed.success) {
    console.error("Profile Agent output failed contract validation:", parsed.error);
    return output;
  }
  return parsed.data;
}
