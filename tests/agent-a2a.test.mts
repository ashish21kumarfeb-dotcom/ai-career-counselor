// A2A graph-wiring integration tests (multi-agent refactor, step 7).
//
// Part A (default, DETERMINISTIC): chains the four agent NODE wrappers directly with
// DB-only plans. A plan with no free-text sections means the Recommendation Agent
// makes no LLM call and the Verification soft check short-circuits — so the whole
// hand-off chain runs without touching Groq. Asserts: every A2A envelope is
// populated; the Profile->CareerData hand-off flows; final sections equal the plan
// after verification; agency-only vs resource/course plans stay separate; an invented
// DB item cannot survive verification; and the compat channels the evaluate/log nodes
// read are populated.
//
// Part B (opt-in RUN_LIVE_GRAPH=1): a full agentGraph.invoke on a free-text query.
// DEFERRED by default (LLM calls; Groq daily quota). Asserts the envelopes + response
// shape end-to-end.
// Run: npm run test:a2a           (Part A only; requires DATABASE_URL)
//      RUN_LIVE_GRAPH=1 npm run test:a2a   (adds Part B; needs GROQ_API_KEY)
import "dotenv/config";
import { eq, ilike } from "drizzle-orm";
import { db } from "../src/db/index";
import { users, userProfiles, memory, consultingAgencies, documents } from "../src/db/schema";
import { profileAgentNode } from "../src/lib/agent/nodes/profileAgent";
import { careerDataAgentNode } from "../src/lib/agent/nodes/careerDataAgent";
import { recommendationAgentNode } from "../src/lib/agent/nodes/recommendationAgent";
import { verificationAgentNode } from "../src/lib/agent/nodes/verificationAgent";
import type { AgentStateType } from "../src/lib/agent/state";
import type { AgentPlan, SectionName } from "../src/lib/agent/schema";

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
function sameSet(a: string[], b: string[]): boolean {
  const bs = new Set(b);
  return a.length === b.length && a.every((x) => bs.has(x));
}

const TOKEN = "test-a2a";
const email = "a2atest+user@example.test";

function baseState(over: Partial<AgentStateType>): AgentStateType {
  return {
    userId: "",
    query: "",
    history: [],
    conversationId: "",
    originalQuery: "",
    runId: "",
    trace: [],
    recommendationId: undefined,
    memoryUpdate: undefined,
    persist: false,
    intent: "career_advice",
    profile: undefined,
    memory: [],
    ragDocs: [],
    plan: undefined,
    executionPlan: undefined,
    toolResults: { agencies: [], resources: [] },
    sections: undefined,
    verification: undefined,
    evaluation: undefined,
    profileAgent: undefined,
    careerData: undefined,
    recommendation: undefined,
    verificationResult: undefined,
    regenerationAttempts: 0,
    guardrail: undefined,
    intentSlots: undefined,
    replanAttempts: 0,
    plannerFeedback: undefined,
    ...over,
  };
}
function plan(sections: SectionName[]): AgentPlan {
  return { sections, reasoning: "test" };
}

// Run the four agent nodes in graph order, threading state (deterministic for
// DB-only plans — no LLM calls).
async function runChain(state: AgentStateType): Promise<AgentStateType> {
  state = { ...state, ...(await profileAgentNode(state)) };
  state = { ...state, ...(await careerDataAgentNode(state)) };
  state = { ...state, ...(await recommendationAgentNode(state)) };
  state = { ...state, ...(await verificationAgentNode(state)) };
  return state;
}

async function cleanup() {
  await db.delete(documents).where(ilike(documents.sourceUrl, `%${TOKEN}%`));
  await db.delete(consultingAgencies).where(ilike(consultingAgencies.sourceUrl, `%${TOKEN}%`));
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  for (const u of existing) {
    await db.delete(memory).where(eq(memory.userId, u.id));
    await db.delete(userProfiles).where(eq(userProfiles.userId, u.id));
  }
  await db.delete(users).where(eq(users.email, email));
}

await cleanup();
const [user] = await db.insert(users).values({ name: "A2A Test", email }).returning({ id: users.id });

try {
  await db.insert(userProfiles).values({
    userId: user.id,
    userType: "job_switcher",
    education: "B.Com",
    currentRole: "Sales Executive",
    skills: "Excel, CRM",
    interests: "Analytics",
    careerGoal: "business analytics",
    location: "Pune",
  });
  await db.insert(memory).values({ userId: user.id, memoryKey: "constraints", memoryValue: "User cannot relocate out of Pune." });

  await db.insert(consultingAgencies).values({
    name: "A2A Verified Agency",
    location: "Testcity",
    services: "zza2aagency career counselling and guidance",
    website: "https://example.com/a2av",
    verificationStatus: "verified",
    sourceUrl: `${TOKEN}/agency-verified`,
    lastVerified: new Date("2026-06-01T00:00:00Z"),
  });
  await db.insert(documents).values([
    { userId: null, type: "career_data", sourceUrl: `https://example.com/${TOKEN}/guide`, content: "zza2atopic roadmap learning guide" },
    { userId: null, type: "career_data", sourceUrl: `https://example.com/${TOKEN}/course`, content: "zza2atopic certification course on coursera" },
  ]);

  console.log("\n== A. Agency-only plan: full node chain ==");
  {
    const out = await runChain(baseState({ userId: user.id, query: "zza2aagency counselling", intent: "agency_search", plan: plan(["agencies"]) }));
    check("profileAgent envelope populated", out.profileAgent !== undefined);
    check("careerData envelope populated", out.careerData !== undefined);
    check("recommendation envelope populated", out.recommendation !== undefined);
    check("verificationResult envelope populated", out.verificationResult !== undefined);
    check("A2A hand-off: careerData saw the profile stage", out.careerData !== undefined && out.profileAgent?.userContext.stage === "job_switcher");
    check("final sections equal the plan", sameSet(Object.keys(out.sections ?? {}), ["agencies"]), JSON.stringify(Object.keys(out.sections ?? {})));
    check("only agencies returned (no resources/courses)", out.sections?.resources === undefined && out.sections?.courses === undefined);
    check("agency came from the DB (verified)", (out.sections?.agencies?.items ?? []).some((a) => a.name === "A2A Verified Agency"));
    check("verification approved", out.verificationResult?.approved === true);
    check("soft check available (no free text -> trivially ok)", out.verificationResult?.softCheckAvailable === true);
    // compat channels evaluate/log read
    check("compat toolResults.agencies populated with ids", out.toolResults.agencies.length >= 1 && out.toolResults.agencies.every((a) => !!a.id));
    check("compat ragDocs is an array", Array.isArray(out.ragDocs));
  }

  console.log("\n== A. Resource/course plan: no agencies ==");
  {
    const out = await runChain(baseState({ userId: user.id, query: "zza2atopic roadmap course learning", intent: "skill_guidance", plan: plan(["resources", "courses"]) }));
    check("final sections equal the plan", sameSet(Object.keys(out.sections ?? {}), ["resources", "courses"]), JSON.stringify(Object.keys(out.sections ?? {})));
    check("no agencies section", out.sections?.agencies === undefined);
    const resUrls = (out.sections?.resources?.items ?? []).map((r) => r.url);
    const courseUrls = (out.sections?.courses?.items ?? []).map((c) => c.url);
    const allowed = new Set((out.careerData?.resources ?? []).map((r) => r.url).concat((out.careerData?.courses ?? []).map((c) => c.url)));
    check("resource URLs come only from Career Data", resUrls.every((u) => allowed.has(u)), JSON.stringify(resUrls));
    check("course URLs come only from Career Data", courseUrls.every((u) => allowed.has(u)), JSON.stringify(courseUrls));
    check("verification approved", out.verificationResult?.approved === true);
  }

  console.log("\n== A. Invented DB item cannot survive verification ==");
  {
    // Hand-craft a recommendation envelope with a ghost agency not in careerData.
    const realAgency = { name: "Real Co", location: null, services: null, website: null, source: "real" };
    const ghost = { name: "Ghost Co", location: null, services: null, website: "https://ghost", source: "ghost" };
    const state = baseState({
      userId: user.id,
      query: "zza2aagency counselling",
      plan: plan(["agencies"]),
      careerData: { ragDocs: [], resources: [], courses: [], agencies: [realAgency], sourcesUsed: [], missingDataNotes: [], toolCalls: [] },
      recommendation: { draftSections: { agencies: { items: [{ ...realAgency }, ghost] } } },
    });
    const out = { ...state, ...(await verificationAgentNode(state)) };
    const names = (out.sections?.agencies?.items ?? []).map((a) => a.name);
    check("ghost agency stripped by verification", !names.includes("Ghost Co") && names.includes("Real Co"), JSON.stringify(names));
    check("verification not approved (invented data)", out.verificationResult?.approved === false);
    check("issue records the removal", (out.verificationResult?.issues ?? []).some((i) => i.toLowerCase().includes("agency")));
  }

  console.log("\n== A. Fields the evaluate/log nodes read are present ==");
  {
    const out = await runChain(baseState({ userId: user.id, query: "zza2aagency counselling", intent: "agency_search", plan: plan(["agencies"]) }));
    check("sections present (evaluate + log read it)", out.sections !== undefined);
    check("intent present (log reads it)", typeof out.intent === "string");
    check("toolResults present (evaluate counts + log sources_used)", out.toolResults.agencies.length >= 0 && Array.isArray(out.toolResults.resources));
    check("profile compat present for evaluate", out.profile !== undefined);
    check("memory compat present for evaluate", out.memory.length >= 1);
  }
} finally {
  await cleanup();
  console.log("\ncleaned up fixtures + throwaway user.");
}

// --- Part B: full live graph (opt-in; deferred — Groq daily quota) ---
if (process.env.RUN_LIVE_GRAPH === "1") {
  console.log("\n== B. Full agentGraph.invoke (live) ==");
  const { agentGraph } = await import("../src/lib/agent/graph");
  const result = await agentGraph.invoke({ userId: "00000000-0000-0000-0000-000000000000", query: "I want to become a data analyst. Suggest a roadmap and courses.", persist: false });
  check("intent present", typeof result.intent === "string");
  check("plan present", Array.isArray(result.plan?.sections));
  check("sections present", result.sections !== undefined);
  check("verification present (shape compatible)", typeof result.verification?.grounded === "boolean" && typeof result.verification?.safe === "boolean");
  check("all four envelopes populated", !!result.profileAgent && !!result.careerData && !!result.recommendation && !!result.verificationResult);
  check("final sections are a subset of the plan", Object.keys(result.sections ?? {}).every((k) => (result.plan?.sections ?? []).includes(k as SectionName)));
} else {
  console.log("\n== B. Full live graph: SKIPPED (set RUN_LIVE_GRAPH=1; deferred — Groq daily quota) ==");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
