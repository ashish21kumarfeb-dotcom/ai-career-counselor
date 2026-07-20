// Seed corpus for the RAG slice (Phase 4). Inserts a small set of GLOBAL career
// knowledge documents (userId null) into `documents`.
//
// Each seeded row carries a sourceUrl under the `internal-seed/` namespace. This
// is NOT an external citation — it transparently marks the row as our own
// curated knowledge, and lets this script be idempotent: it deletes and
// reinserts ONLY rows under that prefix, never touching user documents or any
// other global rows.
//
// This file also seeds RESOURCE/COURSE-LINK documents (see RESOURCE_DOCUMENTS):
// global rows carrying REAL external URLs, which the agentic-chat `searchResources`
// tool returns as verified resource/course links. These are curated real links, not
// invented ones. They are kept idempotent by their exact URLs (see seed()).
//
// Run standalone:  npx tsx src/db/seed/documents.ts
// (dotenv must load before ../index, which reads DATABASE_URL at import time.)
import "dotenv/config";
import { inArray, like, or } from "drizzle-orm";
import { db } from "../index";
import { documents } from "../schema";
import { createDocument } from "../../lib/documents/write";
import { chunkDocument } from "../../lib/documents/chunk";

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

// Resource/course-link documents: GLOBAL rows (userId null) with REAL external
// URLs. `searchResources` returns exactly these (global + http source_url) as
// linkable resources/courses, while the internal-seed knowledge rows above stay
// RAG-only. URLs are well-known, stable public resources — curated, not invented.
const RESOURCE_DOCUMENTS = [
  {
    type: "career_data" as const,
    sourceUrl: "https://roadmap.sh/data-analyst",
    content:
      "Data analyst roadmap: a step-by-step learning path covering spreadsheets, SQL, statistics, a data language (Python or R), and a BI/visualization tool such as Power BI or Tableau, followed by portfolio projects on real datasets.",
  },
  {
    type: "career_data" as const,
    sourceUrl: "https://roadmap.sh/frontend",
    content:
      "Frontend / web development roadmap: a structured path through HTML, CSS, JavaScript, a framework such as React, version control with Git, and building and deploying real projects.",
  },
  {
    type: "career_data" as const,
    sourceUrl: "https://grow.google/certificates/data-analytics/",
    content:
      "Google Data Analytics Professional Certificate: a beginner-friendly course and certification covering spreadsheets, SQL, R, and Tableau, aimed at preparing learners for entry-level data analyst roles.",
  },
  {
    type: "career_data" as const,
    sourceUrl: "https://www.freecodecamp.org/learn/data-analysis-with-python/",
    content:
      "Free Data Analysis with Python course: a hands-on curriculum covering Pandas, NumPy, and reading and cleaning data, useful for building data analyst skills and preparation.",
  },
  {
    type: "industry_article" as const,
    sourceUrl: "https://developer.mozilla.org/en-US/docs/Learn",
    content:
      "MDN Learn Web Development: structured, reputable learning guides and resources for HTML, CSS, and JavaScript fundamentals for aspiring web developers.",
  },
  // Azure / .NET / cloud resources and certifications (real Microsoft Learn URLs).
  {
    type: "career_data" as const,
    sourceUrl: "https://learn.microsoft.com/en-us/credentials/certifications/azure-fundamentals/",
    content:
      "Microsoft Azure Fundamentals (AZ-900) certification: a beginner course and certification covering core Azure cloud concepts, services, security, pricing, and support — the recommended starting point for learning Azure.",
  },
  {
    type: "career_data" as const,
    sourceUrl: "https://learn.microsoft.com/en-us/credentials/certifications/azure-developer/",
    content:
      "Microsoft Azure Developer Associate (AZ-204) certification: a course and certification for developers building cloud apps on Azure — App Service, Azure Functions, storage, Cosmos DB, and securing and monitoring solutions. Strong for .NET developers moving to Azure.",
  },
  {
    type: "industry_article" as const,
    sourceUrl: "https://learn.microsoft.com/en-us/azure/",
    content:
      "Microsoft Learn Azure documentation: official, reputable learning resources and guides for Azure cloud services, tutorials, and architecture across compute, storage, networking, and databases.",
  },
  {
    type: "industry_article" as const,
    sourceUrl: "https://learn.microsoft.com/en-us/azure/app-service/",
    content:
      "Azure App Service documentation: guides and resources for hosting and deploying web apps and APIs on Azure App Service, including .NET, and continuous deployment.",
  },
  {
    type: "industry_article" as const,
    sourceUrl: "https://learn.microsoft.com/en-us/azure/azure-functions/",
    content:
      "Azure Functions documentation: learning resources for building serverless functions and event-driven cloud apps on Azure, with .NET, triggers, and bindings.",
  },
  {
    type: "industry_article" as const,
    sourceUrl: "https://learn.microsoft.com/en-us/azure/azure-sql/",
    content:
      "Azure SQL documentation: resources and guides for Azure SQL Database and managed SQL cloud databases — provisioning, querying, security, and performance on Azure.",
  },
  {
    type: "industry_article" as const,
    sourceUrl: "https://learn.microsoft.com/en-us/dotnet/azure/",
    content:
      ".NET on Azure documentation: official resources for building, deploying, and scaling .NET applications on Azure, including App Service, Functions, and Azure SDK for .NET.",
  },
];

async function seed() {
  // Idempotent: remove only rows this script manages — the internal-seed knowledge
  // rows (by prefix) AND the resource/course rows (by their exact URLs) — then
  // reinsert. Never touches user documents or other global rows.
  const resourceUrls = RESOURCE_DOCUMENTS.map((d) => d.sourceUrl);
  await db
    .delete(documents)
    .where(
      or(
        like(documents.sourceUrl, `${SEED_PREFIX}%`),
        inArray(documents.sourceUrl, resourceUrls)
      )
    );

  // Inserted one at a time through createDocument rather than as one bulk insert:
  // retrieval reads chunks, so a bulk insert straight into `documents` would seed
  // a corpus that the retriever cannot see. The extra round trips are irrelevant
  // for a seed script that runs by hand.
  const inserted: Array<{ id: string; sourceUrl: string; chunks: number }> = [];
  for (const doc of [...SEED_DOCUMENTS, ...RESOURCE_DOCUMENTS]) {
    const id = await createDocument(doc);
    inserted.push({ id, sourceUrl: doc.sourceUrl, chunks: chunkDocument(doc.content).length });
  }

  console.log(`Seeded ${inserted.length} documents:`);
  for (const d of inserted) {
    console.log(`  ${d.sourceUrl}  (${d.id}, ${d.chunks} chunk${d.chunks === 1 ? "" : "s"})`);
  }
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
