// Profile Agent tests (multi-agent A2A refactor, step 2). Deterministic — no LLM.
// Inserts a throwaway user with a profile + memory rows, asserts the agent's
// structured output (userContext, summaries, importantConstraints), checks the
// output validates against its contract, and verifies the unknown-user path
// returns a safe empty output. Cleans up all fixtures.
// Run: npm run test:profile   (requires DATABASE_URL)
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index";
import { users, userProfiles, memory } from "../src/db/schema";
import { runProfileAgent } from "../src/lib/agent/agents/profile";
import { profileAgentOutputSchema } from "../src/lib/agent/agents/contracts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`);
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const email = "profileagent+test@example.test";

async function cleanup() {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  for (const u of existing) {
    await db.delete(memory).where(eq(memory.userId, u.id));
    await db.delete(userProfiles).where(eq(userProfiles.userId, u.id));
  }
  await db.delete(users).where(eq(users.email, email));
}

await cleanup(); // clear leftovers from a prior aborted run
const [user] = await db.insert(users).values({ name: "Profile Agent Test", email }).returning({ id: users.id });

try {
  await db.insert(userProfiles).values({
    userId: user.id,
    userType: "job_switcher",
    education: "B.Com",
    currentRole: "Sales Executive",
    skills: "Excel, Communication, CRM",
    interests: "Data Analytics, Business Intelligence",
    careerGoal: "Switch to business analytics",
    location: "Pune",
  });
  await db.insert(memory).values([
    { userId: user.id, memoryKey: "constraints", memoryValue: "User cannot relocate out of Pune." },
    { userId: user.id, memoryKey: "work_preferences", memoryValue: "User prefers roles with little to no coding." },
    { userId: user.id, memoryKey: "timeline", memoryValue: "User wants to switch within 6 months." },
    { userId: user.id, memoryKey: "target_role_or_company", memoryValue: "User is targeting business analyst roles." },
    { userId: user.id, memoryKey: "actions_taken", memoryValue: "User started an Excel course." },
  ]);

  console.log("\n== Profile Agent: populated user ==");
  const out = await runProfileAgent({ userId: user.id, query: "How do I switch to analytics?", intent: "career_advice" });

  // userContext
  check("stage = job_switcher", out.userContext.stage === "job_switcher", String(out.userContext.stage));
  check("currentRole = Sales Executive", out.userContext.currentRole === "Sales Executive", String(out.userContext.currentRole));
  check("skills split into array", sameList(out.userContext.skills, ["Excel", "Communication", "CRM"]), JSON.stringify(out.userContext.skills));
  check("interests split into array", sameList(out.userContext.interests, ["Data Analytics", "Business Intelligence"]), JSON.stringify(out.userContext.interests));
  check("careerGoal captured", out.userContext.careerGoal === "Switch to business analytics", String(out.userContext.careerGoal));
  check("location captured", out.userContext.location === "Pune", String(out.userContext.location));

  // summaries
  check("profileSummary mentions role", out.profileSummary.includes("Sales Executive"), out.profileSummary);
  check("profileSummary mentions a skill", out.profileSummary.includes("Excel"), out.profileSummary);
  // Legacy job_switcher rows are now humanized as "Working professional" (the
  // type was folded into working_professional; the stored enum value is kept).
  check("profileSummary humanizes stage", out.profileSummary.includes("Working professional"), out.profileSummary);
  check("memorySummary includes a constraint value", out.memorySummary.includes("cannot relocate out of Pune"), out.memorySummary);

  // importantConstraints: only constraints / work_preferences / timeline
  check("3 important constraints", out.importantConstraints.length === 3, JSON.stringify(out.importantConstraints));
  check("includes the relocation constraint", out.importantConstraints.some((c) => c.includes("cannot relocate")), JSON.stringify(out.importantConstraints));
  check("includes the no-coding preference", out.importantConstraints.some((c) => c.includes("little to no coding")), JSON.stringify(out.importantConstraints));
  check("includes the timeline", out.importantConstraints.some((c) => c.includes("within 6 months")), JSON.stringify(out.importantConstraints));
  check("excludes target_role_or_company", !out.importantConstraints.some((c) => c.includes("targeting business analyst")), JSON.stringify(out.importantConstraints));
  check("excludes actions_taken", !out.importantConstraints.some((c) => c.includes("started an Excel course")), JSON.stringify(out.importantConstraints));

  // contract
  check("output validates against contract", profileAgentOutputSchema.safeParse(out).success);

  console.log("\n== Profile Agent: unknown user (safe empty) ==");
  const empty = await runProfileAgent({ userId: "00000000-0000-0000-0000-0000000000ff", query: "hi", intent: "other" });
  check("no profile -> summary says so", empty.profileSummary === "No profile on file for this user.", empty.profileSummary);
  check("no memory -> summary says so", empty.memorySummary === "No stored memory for this user.", empty.memorySummary);
  check("empty skills array", empty.userContext.skills.length === 0);
  check("empty constraints array", empty.importantConstraints.length === 0);
  check("empty output still validates", profileAgentOutputSchema.safeParse(empty).success);
} finally {
  await cleanup();
  console.log("\ncleaned up fixtures + throwaway user.");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
