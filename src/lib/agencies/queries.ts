import { and, eq, ilike, or } from "drizzle-orm";
import { db } from "../../db";
import { consultingAgencies } from "../../db/schema";

// DB-only agency search tool for the agentic-chat POC (the first planner tool).
// Keyword retrieval over `consulting_agencies`, matching the query against name,
// services, and location. CRITICAL GUARANTEE: only rows whose verification_status
// is `verified` are ever returned — the model must never surface an unverified or
// invented agency. Returns [] when there are no usable keywords or nothing
// matches; the caller then states plainly that no verified agencies were found.

export type RetrievedAgency = {
  id: string;
  name: string;
  location: string | null;
  services: string | null;
  website: string | null;
  sourceUrl: string | null;
};

// Common words stripped so retrieval keys off meaningful terms (mirrors the
// keyword approach in ../documents/queries.ts; kept local to avoid coupling).
const STOPWORDS = new Set([
  "the", "and", "for", "are", "you", "your", "how", "what", "should", "can",
  "with", "into", "from", "that", "this", "have", "has", "will", "would",
  "about", "want", "need", "get", "got", "who", "why", "when", "where", "which",
  "there", "their", "them", "they", "not", "but", "any", "all", "some", "near",
  "please", "show", "find", "list", "give", "help", "career", "careers",
]);

function keywords(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    )
  );
}

export async function searchAgencies(
  query: string,
  limit = 5
): Promise<RetrievedAgency[]> {
  const words = keywords(query);
  if (words.length === 0) {
    return [];
  }

  // Each keyword may match name OR services OR location.
  const keywordMatch = or(
    ...words.flatMap((w) => [
      ilike(consultingAgencies.name, `%${w}%`),
      ilike(consultingAgencies.services, `%${w}%`),
      ilike(consultingAgencies.location, `%${w}%`),
    ])
  );

  const rows = await db
    .select({
      id: consultingAgencies.id,
      name: consultingAgencies.name,
      location: consultingAgencies.location,
      services: consultingAgencies.services,
      website: consultingAgencies.website,
      sourceUrl: consultingAgencies.sourceUrl,
    })
    .from(consultingAgencies)
    .where(
      and(eq(consultingAgencies.verificationStatus, "verified"), keywordMatch)
    )
    .limit(limit);

  return rows;
}
