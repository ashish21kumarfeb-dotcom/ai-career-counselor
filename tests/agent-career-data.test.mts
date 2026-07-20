// Career Data Agent tests (multi-agent A2A refactor, step 3). Deterministic — no
// LLM. Drives runCareerDataAgent directly with hand-built plans against its own
// fixture rows (token "test-career-data"), then cleans up. Verifies: RAG grounding
// always runs; resources vs courses are bucketed from one fetch; verified-only
// agency filtering; gates re-enforced at the retrieval boundary; planned-but-empty
// sections yield a missingDataNote; unplanned sections retrieve nothing; and the
// output validates against its contract.
// Run: npm run test:career-data   (requires DATABASE_URL)
import "dotenv/config";
import { ilike } from "drizzle-orm";
import { db } from "../src/db/index";
import { consultingAgencies, documents } from "../src/db/schema";
import { runCareerDataAgent } from "../src/lib/agent/agents/careerData";
import { careerDataAgentOutputSchema } from "../src/lib/agent/agents/contracts";
import type { CareerDataAgentInput, UserContext } from "../src/lib/agent/agents/contracts";
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

const TOKEN = "test-career-data";
const GUIDE_URL = `https://example.com/${TOKEN}/zzcdtopic-guide`;
const COURSE_URL = `https://example.com/${TOKEN}/zzcdtopic-course`;
const KNOWLEDGE_URL = `${TOKEN}/zzcdtopic-knowledge`; // non-http: RAG-only, never a resource link

const DEFAULT_CTX: UserContext = {
  stage: null,
  currentRole: null,
  skills: [],
  interests: [],
  careerGoal: null,
  location: null,
};

function input(query: string, sections: SectionName[]): CareerDataAgentInput {
  return {
    userId: "00000000-0000-0000-0000-000000000000",
    query,
    intent: "career_advice",
    plannedSections: sections,
    userContext: DEFAULT_CTX,
  };
}

async function cleanup() {
  await db.delete(documents).where(ilike(documents.sourceUrl, `%${TOKEN}%`));
  await db.delete(consultingAgencies).where(ilike(consultingAgencies.sourceUrl, `%${TOKEN}%`));
}

await cleanup();

await db.insert(consultingAgencies).values({
  name: "CareerData Verified Agency",
  location: "Testcity",
  services: "zzcdagency career counselling and guidance",
  website: "https://example.com/cdv",
  verificationStatus: "verified",
  sourceUrl: `${TOKEN}/agency-verified`,
  lastVerified: new Date("2026-06-01T00:00:00Z"),
});

await db.insert(consultingAgencies).values({
  name: "CareerData Pending Agency",
  location: "Testcity",
  services: "zzcdagency career counselling pending",
  website: "https://example.com/cdp",
  verificationStatus: "pending",
  sourceUrl: `${TOKEN}/agency-pending`,
  lastVerified: null,
});

await db.insert(documents).values([
  // resource-like (no course/cert terms) -> resources bucket
  { userId: null, type: "career_data", sourceUrl: GUIDE_URL, content: "zzcdtopic roadmap learning path guide for engineers" },
  // course-like (course/coursera/certification) -> courses bucket
  { userId: null, type: "career_data", sourceUrl: COURSE_URL, content: "zzcdtopic certification course on coursera" },
  // non-http global knowledge -> retrievable for RAG, never a resource link
  { userId: null, type: "career_data", sourceUrl: KNOWLEDGE_URL, content: "zzcdtopic knowledge: overview of zzcdtopic careers" },
]);

try {
  console.log("\n== resources + courses bucketing + RAG grounding ==");
  const r1 = await runCareerDataAgent(input("zzcdtopic roadmap course learning", ["resources", "courses"]));
  const resUrls = r1.resources.map((r) => r.url);
  const courseUrls = r1.courses.map((c) => c.url);
  check("RAG grounding ran (ragDocs non-empty)", r1.ragDocs.length > 0, JSON.stringify(r1.ragDocs.map((d) => d.sourceUrl)));
  check("ragDocs include the non-http knowledge doc", r1.ragDocs.some((d) => d.sourceUrl === KNOWLEDGE_URL), JSON.stringify(r1.ragDocs.map((d) => d.sourceUrl)));
  check("guide -> resources bucket", resUrls.includes(GUIDE_URL), JSON.stringify(resUrls));
  check("course -> courses bucket", courseUrls.includes(COURSE_URL), JSON.stringify(courseUrls));
  check("guide NOT in courses (partition)", !courseUrls.includes(GUIDE_URL), JSON.stringify(courseUrls));
  check("course NOT in resources (partition)", !resUrls.includes(COURSE_URL), JSON.stringify(resUrls));
  check("non-http knowledge is NOT a resource link", !resUrls.includes(KNOWLEDGE_URL) && !courseUrls.includes(KNOWLEDGE_URL), JSON.stringify([...resUrls, ...courseUrls]));
  check("no missingDataNotes when sections filled", r1.missingDataNotes.length === 0, JSON.stringify(r1.missingDataNotes));
  check("sourcesUsed covers the retrieved resource docs", r1.sourcesUsed.length >= 2, JSON.stringify(r1.sourcesUsed));
  check("output validates against contract", careerDataAgentOutputSchema.safeParse(r1).success);

  console.log("\n== agencies: gated + verified-only ==");
  const r2 = await runCareerDataAgent(input("zzcdagency counselling", ["agencies"]));
  const agencySources = r2.agencies.map((a) => a.source);
  check("fetches the verified agency", agencySources.includes(`${TOKEN}/agency-verified`), JSON.stringify(agencySources));
  check("excludes the pending agency (verified-only)", !agencySources.includes(`${TOKEN}/agency-pending`), JSON.stringify(agencySources));
  check("no resources fetched for a pure agency query", r2.resources.length === 0 && r2.courses.length === 0);

  console.log("\n== gate re-enforced at retrieval boundary ==");
  const r3 = await runCareerDataAgent(input("zzcdtopic learning", ["agencies"]));
  check("agencies NOT fetched when agencyGate fails despite being planned", r3.agencies.length === 0, JSON.stringify(r3.agencies));
  check("planned-but-empty agencies -> missingDataNote", r3.missingDataNotes.some((n) => n.toLowerCase().includes("agenc")), JSON.stringify(r3.missingDataNotes));

  console.log("\n== planned resources with no match -> note ==");
  const r4 = await runCareerDataAgent(input("zznomatchtopic roadmap learning", ["resources"]));
  check("no resources found", r4.resources.length === 0);
  check("missingDataNote for resources", r4.missingDataNotes.some((n) => n.toLowerCase().includes("resource")), JSON.stringify(r4.missingDataNotes));

  console.log("\n== unplanned sections retrieve nothing ==");
  const r5 = await runCareerDataAgent(input("zzcdtopic zzcdagency", ["ai_suggestion"]));
  check("no resources when not planned", r5.resources.length === 0);
  check("no courses when not planned", r5.courses.length === 0);
  check("no agencies when not planned", r5.agencies.length === 0);
  check("no missingDataNotes when nothing DB-backed is planned", r5.missingDataNotes.length === 0, JSON.stringify(r5.missingDataNotes));

  // A lane that RETURNED RESULTS must never also be reported as unavailable.
  //
  // missingDataNotes are injected into the Recommendation Agent prompt as RETRIEVAL
  // STATUS — "searched and NOT found, treat as a gap in the evidence". The note used
  // to key on callTool's `degradedReason`, which is set for ANY non-MCP call,
  // including the ordinary local case of MCP_ENABLED being unset. So a market lane
  // that had just returned five sourced results still emitted "No verified external
  // market signals available (external provider unavailable)", and the prompt told
  // the model its own evidence did not exist while listing it two paragraphs above.
  // That contradiction is why a query with good market data still answered as though
  // it had none. Transport degradation is reported separately, in toolCalls.
  console.log("\n== a lane with results is never reported as unavailable ==");
  {
    const external = process.env.EXTERNAL_SEARCH_ENABLED;
    const mcp = process.env.MCP_ENABLED;
    // MCP off is the condition that used to poison the note. External search on, so
    // the lanes actually run. Skips cleanly when no provider key is configured.
    process.env.MCP_ENABLED = "false";
    process.env.EXTERNAL_SEARCH_ENABLED = "true";
    try {
      if (!process.env.TAVILY_API_KEY) {
        console.log("  SKIPPED (no TAVILY_API_KEY configured)");
      } else {
        const r6 = await runCareerDataAgent(
          input("What is the average salary for cyber security jobs in India?", ["ai_suggestion"])
        );
        const ran = r6.toolCalls.filter((c) => c.transport !== "skipped");
        check(
          "transport degradation is still reported honestly in toolCalls",
          ran.some((c) => !!c.degradedReason),
          JSON.stringify(ran)
        );
        for (const [label, rows] of [
          ["market signals", r6.marketSignals ?? []],
          ["industry articles", r6.industryArticles ?? []],
        ] as const) {
          if (rows.length === 0) {
            console.log(`  (lane "${label}" returned nothing this run — nothing to assert)`);
            continue;
          }
          check(
            `"${label}" returned ${rows.length} result(s) and is NOT called unavailable`,
            !r6.missingDataNotes.some((n) => n.includes(label)),
            JSON.stringify(r6.missingDataNotes)
          );
        }
      }
    } finally {
      if (external === undefined) delete process.env.EXTERNAL_SEARCH_ENABLED;
      else process.env.EXTERNAL_SEARCH_ENABLED = external;
      if (mcp === undefined) delete process.env.MCP_ENABLED;
      else process.env.MCP_ENABLED = mcp;
    }
  }
} finally {
  await cleanup();
  console.log("\ncleaned up fixtures.");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
