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
} finally {
  await cleanup();
  console.log("\ncleaned up fixtures.");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
