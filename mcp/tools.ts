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

export const TOOL_DESCRIPTIONS = {
  searchAgencies:
    "Search VERIFIED career consulting agencies in the database. Returns only rows whose verification_status is 'verified' — never unverified or invented agencies. Returns an empty array when nothing matches.",
  searchResources:
    "Search curated career learning resources and courses. Returns only global rows carrying a real http source URL — never a user's own uploaded document. Returns an empty array when no on-topic resource matches.",
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
