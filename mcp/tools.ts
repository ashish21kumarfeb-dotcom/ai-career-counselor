// MCP tool definitions — a thin protocol adapter over the EXISTING query
// helpers. No retrieval logic lives here: searchAgencies/searchResources are
// imported verbatim from src/lib, so exposing them over MCP cannot fork their
// behaviour from the direct-call path.
//
// SCOPE (deliberate): only the two GLOBAL tools are exposed. searchDocuments and
// the resume tools are user-scoped and do NOT self-enforce identity — that check
// lives in getSession() at the route handlers. Exposing them here would move the
// enforcement point to a boundary that has no session, so any client could ask
// for any user's documents by passing their id. They stay MCP-planned until the
// server carries a session identity rather than trusting a caller-supplied userId.
import { z } from "zod";
import { searchAgencies } from "../src/lib/agencies/queries";
import { searchResources } from "../src/lib/documents/queries";
import {
  searchCareerRoadmaps,
  searchMarketSignals,
  searchIndustryArticles,
  searchHiringCompanies,
} from "../src/lib/external/tavily";

// registerTool takes a RAW ZOD SHAPE, not z.object({...}).
export const searchAgenciesInput = {
  query: z.string().describe("The user's query. Matched against agency name, services and location."),
  limit: z.number().int().min(1).max(20).default(5).describe("Max agencies to return."),
};

export const searchResourcesInput = {
  query: z.string().describe("The user's query. Must contain a specific topic term or nothing is returned."),
  limit: z.number().int().min(1).max(20).default(5).describe("Max resources to return."),
  // The direct helper is positional — searchResources(query, 5, contextTerms).
  // MCP tools take named arguments, so the shape is explicit here.
  contextTerms: z.array(z.string()).default([]).describe("Profile-derived terms. Rank results only; never grant inclusion."),
};

// The three EXTERNAL tools share one provider (Tavily) and one shape (sourced
// rows with a url). They take a topic/field query and, optionally, a result cap.
const externalToolInput = {
  query: z.string().describe("The role, skill, or field to search for."),
  limit: z.number().int().min(1).max(10).default(5).describe("Max results to return."),
};
export const searchCareerRoadmapsInput = externalToolInput;
export const searchMarketSignalsInput = externalToolInput;
export const searchIndustryArticlesInput = externalToolInput;
export const searchHiringCompaniesInput = externalToolInput;

export const TOOL_DESCRIPTIONS = {
  searchAgencies:
    "Search VERIFIED career consulting agencies in the database. Returns only rows whose verification_status is 'verified' — never unverified or invented agencies. Returns an empty array when nothing matches.",
  searchResources:
    "Search curated career learning resources and courses. Returns only global rows carrying a real http source URL — never a user's own uploaded document. Returns an empty array when no on-topic resource matches.",
  searchCareerRoadmaps:
    "Search the web (Tavily) for career roadmaps and learning paths for a role or skill. Returns only SOURCED results — each carries a real http URL, title, snippet, and source host. Never guarantees a job, salary, or outcome; never invents a roadmap. Returns an empty array when nothing matches.",
  searchMarketSignals:
    "Search the web (Tavily) for QUALITATIVE labor-market signals — demand, hiring and growth trends — for a field, biased toward reputable sources. Returns only SOURCED results (real http URL + source host). These describe what a cited source says; they are NOT salary or job guarantees and make no numeric promises. Returns an empty array when nothing matches.",
  searchIndustryArticles:
    "Search the web (Tavily) for current industry articles and analysis about a field. Returns only SOURCED results (real http URL + source host + publish date when available). Reports what published articles say; never presents an unnamed blogger as an authority and never invents expert or executive claims. Returns an empty array when nothing matches.",
  searchHiringCompanies:
    "Search the OPEN web (Tavily) for real companies currently hiring for a role/field in a location — for freshness/live-hiring queries ('top companies hiring in Berlin', 'latest firms hiring in Germany'). Returns only SOURCED results (real http URL + source host), surfacing company and careers/jobs pages. Never invents a company and makes no job or salary guarantee. Returns an empty array when nothing matches. Use this instead of searchAgencies for live-market questions; searchAgencies is for curated verified partner agencies only.",
} as const;

// Handlers return the rows as JSON text. MCP content blocks are strings, so the
// client re-parses and re-validates against the shared zod schemas — the type
// fidelity lost at the protocol boundary is restored at the boundary, not assumed.
export async function handleSearchAgencies(args: { query: string; limit?: number }) {
  const rows = await searchAgencies(args.query, args.limit ?? 5);
  return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
}

export async function handleSearchResources(args: {
  query: string;
  limit?: number;
  contextTerms?: string[];
}) {
  const rows = await searchResources(args.query, args.limit ?? 5, args.contextTerms ?? []);
  return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
}

// The external handlers call the shared Tavily helpers verbatim (same helpers the
// Career Data Agent uses as its direct fallback, so the two paths cannot diverge).
// A provider failure THROWS out of the helper — the handler lets it propagate so
// the MCP call errors and the client records a degraded reason, rather than
// swallowing the outage into a silent empty result.
export async function handleSearchCareerRoadmaps(args: { query: string; limit?: number }) {
  const rows = await searchCareerRoadmaps(args.query, args.limit ?? 5);
  return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
}

export async function handleSearchMarketSignals(args: { query: string; limit?: number }) {
  const rows = await searchMarketSignals(args.query, args.limit ?? 5);
  return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
}

export async function handleSearchIndustryArticles(args: { query: string; limit?: number }) {
  const rows = await searchIndustryArticles(args.query, args.limit ?? 5);
  return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
}

export async function handleSearchHiringCompanies(args: { query: string; limit?: number }) {
  const rows = await searchHiringCompanies(args.query, args.limit ?? 5);
  return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
}
