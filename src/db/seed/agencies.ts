// Seed data for the `consulting_agencies` table — the DB source of truth for the
// agency_search tool (agentic-chat POC). Agency names come ONLY from this table;
// the model must never invent them. Names/websites here are generic samples on
// the RFC-reserved example.com domain, not real companies.
//
// Each row carries a sourceUrl under the `internal-seed/` namespace so this script
// is idempotent: it deletes and reinserts ONLY rows under that prefix. One row is
// left `pending` on purpose so tests/queries can prove verified-only filtering.
//
// Run standalone:  npx tsx src/db/seed/agencies.ts
import "dotenv/config";
import { like } from "drizzle-orm";
import { db } from "../index";
import { consultingAgencies } from "../schema";

const SEED_PREFIX = "internal-seed/";
const VERIFIED_ON = new Date("2026-06-01T00:00:00Z");

const SEED_AGENCIES = [
  {
    name: "CareerBridge Consulting",
    location: "Delhi",
    services:
      "Career counselling and course guidance for students and freshers, including roadmap planning.",
    website: "https://example.com/careerbridge",
    verificationStatus: "verified" as const,
    sourceUrl: `${SEED_PREFIX}agency-careerbridge`,
    lastVerified: VERIFIED_ON,
  },
  {
    name: "PathFinder Career Services",
    location: "Bangalore",
    services:
      "Job switch mentoring and career guidance for data analytics and software roles.",
    website: "https://example.com/pathfinder",
    verificationStatus: "verified" as const,
    sourceUrl: `${SEED_PREFIX}agency-pathfinder`,
    lastVerified: VERIFIED_ON,
  },
  {
    name: "NextStep Advisory",
    location: "Mumbai",
    services:
      "Resume review, interview preparation, and placement guidance for early-career candidates.",
    website: "https://example.com/nextstep",
    verificationStatus: "verified" as const,
    sourceUrl: `${SEED_PREFIX}agency-nextstep`,
    lastVerified: VERIFIED_ON,
  },
  {
    name: "Remote Careers Collective",
    location: "Remote",
    services:
      "Remote job search coaching, upskilling roadmaps, and mentorship for career switchers.",
    website: "https://example.com/remote-careers",
    verificationStatus: "verified" as const,
    sourceUrl: `${SEED_PREFIX}agency-remote-collective`,
    lastVerified: VERIFIED_ON,
  },
  {
    name: "Horizon Placement Partners",
    location: "Delhi",
    services:
      "Placement and consulting services for working professionals changing industries.",
    website: "https://example.com/horizon",
    verificationStatus: "verified" as const,
    sourceUrl: `${SEED_PREFIX}agency-horizon`,
    lastVerified: VERIFIED_ON,
  },
  {
    // Intentionally unverified — must never appear in searchAgencies results.
    name: "Unlisted Career Advisors",
    location: "Pune",
    services: "Career services pending verification.",
    website: "https://example.com/unlisted",
    verificationStatus: "pending" as const,
    sourceUrl: `${SEED_PREFIX}agency-pending`,
    lastVerified: null,
  },
];

async function seed() {
  // Idempotent: remove only previously seeded rows (safe prefix), then reinsert.
  await db
    .delete(consultingAgencies)
    .where(like(consultingAgencies.sourceUrl, `${SEED_PREFIX}%`));

  const inserted = await db
    .insert(consultingAgencies)
    .values(SEED_AGENCIES)
    .returning({
      id: consultingAgencies.id,
      name: consultingAgencies.name,
      verificationStatus: consultingAgencies.verificationStatus,
    });

  console.log(`Seeded ${inserted.length} consulting agencies:`);
  for (const a of inserted) {
    console.log(`  [${a.verificationStatus}] ${a.name}  (${a.id})`);
  }
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Agency seed failed:", error);
    process.exit(1);
  });
