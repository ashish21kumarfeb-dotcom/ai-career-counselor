// Seed corpus for the RAG slice (Phase 4). Inserts a small set of GLOBAL career
// knowledge documents (userId null) into `documents`.
//
// Each seeded row carries a sourceUrl under the `internal-seed/` namespace. This
// is NOT an external citation — it transparently marks the row as our own
// curated knowledge, and lets this script be idempotent: it deletes and
// reinserts ONLY rows under that prefix, never touching user documents or any
// other global rows.
//
// Run standalone:  npx tsx src/db/seed/documents.ts
// (dotenv must load before ../index, which reads DATABASE_URL at import time.)
import "dotenv/config";
import { like } from "drizzle-orm";
import { db } from "../index";
import { documents } from "../schema";

const SEED_PREFIX = "internal-seed/";

const SEED_DOCUMENTS = [
  {
    type: "career_data" as const,
    sourceUrl: `${SEED_PREFIX}transition-to-data-analytics`,
    content:
      "Moving into data analytics typically starts with building a foundation in spreadsheets and SQL, then learning a data-focused language such as Python or R for cleaning and analysis, and a visualization tool such as Power BI or Tableau. Employers commonly look for the ability to translate a business question into a query, validate the data, and communicate findings clearly. Building two or three portfolio projects on real, public datasets is a widely recommended way to demonstrate these skills when you do not yet have analytics work experience.",
  },
  {
    type: "industry_article" as const,
    sourceUrl: `${SEED_PREFIX}choosing-skills-to-learn`,
    content:
      "A durable way to choose which skills to learn is to look at recurring requirements across real job postings for the roles you are targeting, rather than following generic 'hot skills' lists. Group the requirements into fundamentals that appear in almost every posting and differentiators that appear in only some, and prioritize the fundamentals first. Pair each technical skill with evidence — a project, a certification, or measurable work — because employers weigh demonstrated ability more heavily than a list of tools.",
  },
  {
    type: "career_data" as const,
    sourceUrl: `${SEED_PREFIX}resume-fundamentals`,
    content:
      "An effective resume leads with concise, achievement-oriented bullet points that state what you did, how you did it, and the measurable result where possible. Tailor the resume to each role by mirroring the language of the job description for skills you genuinely have. Keep formatting simple and consistent so applicant tracking systems can parse it, and keep it to one to two pages for most early- and mid-career candidates.",
  },
  {
    type: "career_data" as const,
    sourceUrl: `${SEED_PREFIX}job-search-strategy`,
    content:
      "A structured job search combines direct applications with networking and referrals, since many roles are filled through referrals. Track applications so you can follow up, and prepare for interviews by rehearsing concrete stories about past work using a simple situation-action-result structure. Rejections are a normal part of the process and are not necessarily a signal about your ability; treat each interview as information about fit and areas to strengthen.",
  },
  {
    type: "industry_article" as const,
    sourceUrl: `${SEED_PREFIX}career-switching-considerations`,
    content:
      "When switching careers, identify the transferable skills from your current field and map them to the requirements of the target field, so you are building on existing strengths rather than starting from zero. Expect a transition period and, in some cases, a lateral or lower starting position while you establish credibility. Informational conversations with people already in the target role are a low-risk way to test your assumptions before committing time and money to courses or credentials.",
  },
];

async function seed() {
  // Idempotent: remove only previously seeded rows (safe prefix), then reinsert.
  await db.delete(documents).where(like(documents.sourceUrl, `${SEED_PREFIX}%`));

  const inserted = await db
    .insert(documents)
    .values(SEED_DOCUMENTS)
    .returning({ id: documents.id, sourceUrl: documents.sourceUrl });

  console.log(`Seeded ${inserted.length} documents:`);
  for (const d of inserted) {
    console.log(`  ${d.sourceUrl}  (${d.id})`);
  }
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
