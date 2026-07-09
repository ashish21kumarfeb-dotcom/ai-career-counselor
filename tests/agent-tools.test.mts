// Tool tests for the agentic-chat POC step (a): searchAgencies + searchResources.
// Fully self-contained and deterministic — it inserts its own fixture rows
// (marked with a "test-tools" token in source_url), asserts, and cleans up in a
// finally block. Does NOT depend on the seed scripts or existing DB state.
// Run: npm run test:tools   (requires DATABASE_URL)
import "dotenv/config";
import { eq, ilike } from "drizzle-orm";
import { db } from "../src/db/index";
import { users, consultingAgencies, documents } from "../src/db/schema";
import { searchAgencies } from "../src/lib/agencies/queries";
import { searchResources } from "../src/lib/documents/queries";

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

const TOKEN = "test-tools"; // present in every fixture source_url for cleanup
const VERIFIED_ON = new Date("2026-06-01T00:00:00Z");

// throwaway user for the user-owned (non-global) resource fixture
const email = "toolstest+verify@example.test";

async function cleanup(userId?: string) {
  await db.delete(documents).where(ilike(documents.sourceUrl, `%${TOKEN}%`));
  await db.delete(consultingAgencies).where(ilike(consultingAgencies.sourceUrl, `%${TOKEN}%`));
  if (userId) await db.delete(users).where(eq(users.id, userId));
}

await cleanup(); // clear any leftovers from a prior aborted run
await db.delete(users).where(eq(users.email, email));
const [u] = await db.insert(users).values({ name: "Tools Test", email }).returning({ id: users.id });
const userId = u.id;

try {
  // --- fixtures: agencies ---
  await db.insert(consultingAgencies).values([
    {
      name: "TestBridge Counselling",
      location: "Testdelhi",
      services: "career counselling and guidance for students",
      website: "https://example.com/tb",
      verificationStatus: "verified",
      sourceUrl: `${TOKEN}/agency-verified-delhi`,
      lastVerified: VERIFIED_ON,
    },
    {
      name: "TestData Mentors",
      location: "Testbangalore",
      services: "data analytics mentoring and job switch support",
      website: "https://example.com/td",
      verificationStatus: "verified",
      sourceUrl: `${TOKEN}/agency-verified-bangalore`,
      lastVerified: VERIFIED_ON,
    },
    {
      name: "TestPending Advisors",
      location: "Testdelhi",
      services: "career counselling pending verification",
      website: "https://example.com/tp",
      verificationStatus: "pending",
      sourceUrl: `${TOKEN}/agency-pending-delhi`,
      lastVerified: null,
    },
  ]);

  // --- fixtures: resource documents ---
  await db.insert(documents).values([
    // global + real http URL -> should be returned by searchResources
    {
      userId: null,
      type: "career_data",
      sourceUrl: `https://example.com/${TOKEN}/analyst-roadmap`,
      content: "test analyst roadmap resource covering sql and python",
    },
    // global but NON-http source_url (knowledge row) -> must be EXCLUDED
    {
      userId: null,
      type: "career_data",
      sourceUrl: `${TOKEN}/knowledge-not-a-link`,
      content: "test analyst roadmap knowledge without a link",
    },
    // user-owned (non-global) with real URL -> must be EXCLUDED (cross-user guard)
    {
      userId,
      type: "career_data",
      sourceUrl: `https://example.com/${TOKEN}/private-analyst`,
      content: "test analyst roadmap private user document",
    },
  ]);

  // ===== searchAgencies =====
  console.log("\n== searchAgencies ==");
  const aDelhi = await searchAgencies("counselling Testdelhi");
  const aNames = aDelhi.map((a) => a.name);
  check("returns the verified Delhi agency", aNames.includes("TestBridge Counselling"), JSON.stringify(aNames));
  check("excludes the pending agency (verified-only)", !aNames.includes("TestPending Advisors"), JSON.stringify(aNames));

  const aBlr = await searchAgencies("Testbangalore");
  check("matches on location keyword", aBlr.some((a) => a.name === "TestData Mentors"), JSON.stringify(aBlr.map((a) => a.name)));

  const aNone = await searchAgencies("zzzznomatchzzz");
  check("returns [] when nothing matches", aNone.length === 0, JSON.stringify(aNone));

  const aEmpty = await searchAgencies("the and for");
  check("returns [] when no usable keywords", aEmpty.length === 0, JSON.stringify(aEmpty));

  // ===== searchResources =====
  console.log("\n== searchResources ==");
  const r = await searchResources("analyst roadmap");
  const urls = r.map((d) => d.sourceUrl);
  check("returns the global http-linked resource", urls.includes(`https://example.com/${TOKEN}/analyst-roadmap`), JSON.stringify(urls));
  check("excludes non-http knowledge row", !urls.includes(`${TOKEN}/knowledge-not-a-link`), JSON.stringify(urls));
  check("excludes user-owned document (cross-user guard)", !urls.includes(`https://example.com/${TOKEN}/private-analyst`), JSON.stringify(urls));
  check("every returned resource has an http URL", r.every((d) => (d.sourceUrl ?? "").startsWith("http")), JSON.stringify(urls));

  const rNone = await searchResources("zzzznomatchzzz");
  check("returns [] when nothing matches", rNone.length === 0, JSON.stringify(rNone));
} finally {
  await cleanup(userId);
  console.log("\ncleaned up fixtures + throwaway user.");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
