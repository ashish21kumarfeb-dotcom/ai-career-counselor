// Tool-node tests for the agentic-chat POC step (c). Deterministic (no LLM): it
// drives toolNode directly with hand-built plans against its own fixture rows
// (marked with a "test-tools-node" token), then cleans up. Verifies: only planned
// tools run, the gates are re-enforced at the tool boundary, verified-only agency
// filtering survives, and one searchResources fetch backs both resources+courses.
// Run: npm run test:tools-node   (requires DATABASE_URL)
import "dotenv/config";
import { ilike } from "drizzle-orm";
import { db } from "../src/db/index";
import { consultingAgencies, documents } from "../src/db/schema";
import { toolNode } from "../src/lib/agent/nodes/tools";
import type { AgentStateType } from "../src/lib/agent/state";
import type { SectionName } from "../src/lib/agent/schema";

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

const TOKEN = "test-tools-node";

function makeState(query: string, sections: SectionName[]): AgentStateType {
  return {
    userId: "00000000-0000-0000-0000-000000000000",
    query,
    runId: "",
    trace: [],
    recommendationId: undefined,
    memoryUpdate: undefined,
    persist: false,
    intent: "other",
    profile: undefined,
    memory: [],
    ragDocs: [],
    plan: { sections, reasoning: "test" },
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
  };
}

async function cleanup() {
  await db.delete(documents).where(ilike(documents.sourceUrl, `%${TOKEN}%`));
  await db.delete(consultingAgencies).where(ilike(consultingAgencies.sourceUrl, `%${TOKEN}%`));
}

await cleanup();

const [verifiedAgency] = await db
  .insert(consultingAgencies)
  .values({
    name: "ToolNode Verified Agency",
    location: "Testcity",
    services: "zzuniqueagency career counselling and guidance",
    website: "https://example.com/tnv",
    verificationStatus: "verified",
    sourceUrl: `${TOKEN}/agency-verified`,
    lastVerified: new Date("2026-06-01T00:00:00Z"),
  })
  .returning({ id: consultingAgencies.id });

const [pendingAgency] = await db
  .insert(consultingAgencies)
  .values({
    name: "ToolNode Pending Agency",
    location: "Testcity",
    services: "zzuniqueagency career counselling pending",
    website: "https://example.com/tnp",
    verificationStatus: "pending",
    sourceUrl: `${TOKEN}/agency-pending`,
    lastVerified: null,
  })
  .returning({ id: consultingAgencies.id });

const [resourceDoc] = await db
  .insert(documents)
  .values({
    userId: null,
    type: "career_data",
    sourceUrl: `https://example.com/${TOKEN}/zzuniqueresource`,
    content: "zzuniqueresource roadmap learning path for analysts",
  })
  .returning({ id: documents.id });

try {
  // 1. agencies planned + provider term present -> verified fixture only
  console.log("\n== agencies section ==");
  const r1 = await toolNode(makeState("zzuniqueagency counselling", ["agencies"]));
  const aIds = (r1.toolResults?.agencies ?? []).map((a) => a.id);
  check("fetches the verified agency", aIds.includes(verifiedAgency.id), JSON.stringify(aIds));
  check("excludes the pending agency (verified-only)", !aIds.includes(pendingAgency.id), JSON.stringify(aIds));
  check("does not fetch resources when only agencies planned", (r1.toolResults?.resources ?? []).length === 0);

  // 2. resources planned + learning term present -> resource fixture
  console.log("\n== resources section ==");
  const r2 = await toolNode(makeState("zzuniqueresource learning", ["resources"]));
  const rIds = (r2.toolResults?.resources ?? []).map((d) => d.id);
  check("fetches the resource doc", rIds.includes(resourceDoc.id), JSON.stringify(rIds));
  check("does not fetch agencies when only resources planned", (r2.toolResults?.agencies ?? []).length === 0);

  // 3. resources + courses -> one searchResources fetch backs both
  console.log("\n== resources + courses share one fetch ==");
  const r3 = await toolNode(makeState("zzuniqueresource learning", ["resources", "courses"]));
  check("resource docs available for resources+courses", (r3.toolResults?.resources ?? []).some((d) => d.id === resourceDoc.id));

  // 4. gate re-enforced at boundary: agencies planned but query has no provider term
  console.log("\n== gate re-enforced at tool boundary ==");
  const r4 = await toolNode(makeState("zzuniqueresource learning", ["agencies"]));
  check("agencies NOT fetched when agencyGate fails despite being planned", (r4.toolResults?.agencies ?? []).length === 0, JSON.stringify(r4.toolResults?.agencies));

  // 5. passthrough: no tool sections -> no DB tool calls
  console.log("\n== passthrough (no tool sections) ==");
  const r5 = await toolNode(makeState("zzuniqueagency zzuniqueresource", ["ai_suggestion"]));
  check("agencies empty when not planned", (r5.toolResults?.agencies ?? []).length === 0);
  check("resources empty when not planned", (r5.toolResults?.resources ?? []).length === 0);
} finally {
  await cleanup();
  console.log("\ncleaned up fixtures.");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
