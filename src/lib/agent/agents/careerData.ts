// Career Data Agent (SRS §6.3).
//
// Responsibility: retrieve ONLY verified DB/tool data. It is the SINGLE owner of
// the DB retrieval tools — RAG grounding (searchDocuments, always, user-scoped),
// plus resource/course search and agency search when the plan asks for them and
// the deterministic gate passes. It never invents agencies, courses, resources,
// or links; a requested-but-empty section yields an explicit "no verified data"
// note in missingDataNotes.
//
// Input:  CareerDataAgentInput  { userId, query, intent, plannedSections, userContext }
// Output: CareerDataAgentOutput { ragDocs, resources, courses, agencies,
//                                 sourcesUsed, missingDataNotes }
//
// The userContext handed off from the Profile Agent nudges resource RANKING toward
// the user's field/goal; it never grants inclusion on its own (relevance is decided
// by the query's specific topic terms).
import { searchDocuments, searchResources } from "../../documents/queries";
import { searchAgencies } from "../../agencies/queries";
import { agencyGate, resourceGate } from "../schema";
import { buildDbSections } from "../sections";
import { careerDataAgentOutputSchema } from "./contracts";
import type { CareerDataAgentInput, CareerDataAgentOutput } from "./contracts";
import type { UserContext } from "./contracts";

// Profile-derived ranking terms: the user's skills, interests, goal, and current
// role, tokenized. Used only to rank retrieved resources, never to include them.
function contextTermsFrom(userContext: UserContext): string[] {
  return [
    ...userContext.skills,
    ...userContext.interests,
    userContext.careerGoal ?? "",
    userContext.currentRole ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

export async function runCareerDataAgent(
  input: CareerDataAgentInput
): Promise<CareerDataAgentOutput> {
  const { userId, query, plannedSections, userContext } = input;

  // Re-enforce the gates at the retrieval boundary (defense in depth — the planner
  // already gated, but a tool must never run for a section the query didn't earn).
  const wantsAgencies = plannedSections.includes("agencies") && agencyGate(query);
  const wantsResources =
    (plannedSections.includes("resources") || plannedSections.includes("courses")) &&
    resourceGate(query);

  const contextTerms = contextTermsFrom(userContext);

  // RAG grounding always runs (user-scoped: global curated docs + this user's own
  // docs, never another user's). Resource/agency tools run only when planned+gated.
  const [ragDocs, resourceDocs, agencyRows] = await Promise.all([
    searchDocuments(query, userId).catch((e) => {
      console.error("Career Data Agent: searchDocuments failed:", e);
      return [];
    }),
    wantsResources
      ? searchResources(query, 5, contextTerms).catch((e) => {
          console.error("Career Data Agent: searchResources failed:", e);
          return [];
        })
      : Promise.resolve([]),
    wantsAgencies
      ? searchAgencies(query).catch((e) => {
          console.error("Career Data Agent: searchAgencies failed:", e);
          return [];
        })
      : Promise.resolve([]),
  ]);

  // Reuse the shared, LLM-free mappers: partition resources vs courses and map
  // agencies to DB-sourced items. A planned-but-empty section carries a note.
  const db = buildDbSections(plannedSections, agencyRows, resourceDocs);
  const resources = db.resources?.items ?? [];
  const courses = db.courses?.items ?? [];
  const agencies = db.agencies?.items ?? [];

  const missingDataNotes: string[] = [];
  for (const note of [db.agencies?.note, db.resources?.note, db.courses?.note]) {
    if (note) missingDataNotes.push(note);
  }

  // sourcesUsed mirrors what the log node records (agencies + resource docs), so a
  // later switch to reading this field keeps ai_recommendations.sources_used stable.
  const sourcesUsed = [
    ...agencyRows.map((a) => ({ id: a.id, type: "agency", sourceUrl: a.sourceUrl })),
    ...resourceDocs.map((d) => ({ id: d.id, type: d.type, sourceUrl: d.sourceUrl })),
  ];

  const output: CareerDataAgentOutput = {
    ragDocs,
    resources,
    courses,
    agencies,
    sourcesUsed,
    missingDataNotes,
  };

  // Validate the output contract at the hand-off boundary. On the unexpected event
  // of a validation failure, log and return the constructed output rather than
  // throwing into the graph.
  const parsed = careerDataAgentOutputSchema.safeParse(output);
  if (!parsed.success) {
    console.error("Career Data Agent output failed contract validation:", parsed.error);
    return output;
  }
  return parsed.data;
}
