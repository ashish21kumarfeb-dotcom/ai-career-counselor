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
import { searchDocuments, searchResources, type RetrievedDocument } from "../../documents/queries";
import { searchAgencies, type RetrievedAgency } from "../../agencies/queries";
import {
  externalSearchEnabled,
  searchCareerRoadmaps,
  searchMarketSignals,
  searchIndustryArticles,
} from "../../external/tavily";
import {
  agencyGate,
  resourceGate,
  careerRoadmapGate,
  marketSignalGate,
  industryArticleGate,
} from "../schema";
import { buildDbSections } from "../sections";
import { callTool, type ToolCallResult } from "../tools/mcpClient";
import {
  careerDataAgentOutputSchema,
  externalResultSchema,
  mcpAgencyRowSchema,
  mcpDocumentRowSchema,
} from "./contracts";
import type {
  CareerDataAgentInput,
  CareerDataAgentOutput,
  ExternalResult,
  ToolCallRecord,
} from "./contracts";
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

  // External (Tavily) tools. Unlike the DB tools they are NOT bound to a response
  // section yet — they gate on their own keyword gate AND on the master kill switch,
  // so with EXTERNAL_SEARCH_ENABLED off (the default) none of them touches the
  // network. Each still goes through MCP with a direct fallback so the transport is
  // recorded honestly, exactly like the DB tools.
  const externalOn = externalSearchEnabled();
  const wantsRoadmaps = externalOn && careerRoadmapGate(query);
  const wantsMarket = externalOn && marketSignalGate(query);
  const wantsArticles = externalOn && industryArticleGate(query);

  const contextTerms = contextTermsFrom(userContext);

  // RAG grounding always runs (user-scoped: global curated docs + this user's own
  // docs, never another user's). Resource/agency tools run only when planned+gated.
  //
  // The two GATED tools go through MCP; searchDocuments stays a direct call
  // because it is user-scoped and the MCP boundary has no session identity yet.
  // Every call is recorded in `toolCalls` with the transport that carried it, so
  // "runs on MCP" is a claim the run can prove rather than one we assert.
  const skipped = (): ToolCallResult<never> => ({ data: [], transport: "skipped" });

  // Measure the wall-clock span of the retrieval fan-out so the trace's tool
  // latency is a measured number, not one inferred from the node's total duration.
  // The direct fallback for an external tool wraps the SAME helper the MCP server
  // calls, catching a provider outage into [] so a Tavily failure degrades to an
  // empty (but sourced-honest) result with the reason recorded in the tool-call —
  // it never fabricates data and never breaks the workflow.
  const externalCall = (
    want: boolean,
    tool: string,
    direct: () => Promise<ExternalResult[]>
  ): Promise<ToolCallResult<ExternalResult>> =>
    want
      ? callTool<ExternalResult>(tool, { query, limit: 5 }, externalResultSchema, () =>
          direct().catch((e) => {
            console.error(`Career Data Agent: ${tool} failed:`, e);
            return [] as ExternalResult[];
          })
        )
      : Promise.resolve(skipped() as ToolCallResult<ExternalResult>);

  const retrievalStart = performance.now();
  const [ragDocs, resourceResult, agencyResult, roadmapResult, marketResult, articleResult] =
    await Promise.all([
      searchDocuments(query, userId).catch((e) => {
        console.error("Career Data Agent: searchDocuments failed:", e);
        return [] as RetrievedDocument[];
      }),
      wantsResources
        ? callTool<RetrievedDocument>(
            "searchResources",
            { query, limit: 5, contextTerms },
            mcpDocumentRowSchema,
            () =>
              searchResources(query, 5, contextTerms).catch((e) => {
                console.error("Career Data Agent: searchResources failed:", e);
                return [];
              })
          )
        : Promise.resolve(skipped() as ToolCallResult<RetrievedDocument>),
      wantsAgencies
        ? callTool<RetrievedAgency>(
            "searchAgencies",
            { query, limit: 5 },
            mcpAgencyRowSchema,
            () =>
              searchAgencies(query).catch((e) => {
                console.error("Career Data Agent: searchAgencies failed:", e);
                return [];
              })
          )
        : Promise.resolve(skipped() as ToolCallResult<RetrievedAgency>),
      externalCall(wantsRoadmaps, "searchCareerRoadmaps", () => searchCareerRoadmaps(query, 5)),
      externalCall(wantsMarket, "searchMarketSignals", () => searchMarketSignals(query, 5)),
      externalCall(wantsArticles, "searchIndustryArticles", () => searchIndustryArticles(query, 5)),
    ]);
  const toolLatencyMs = Math.round(performance.now() - retrievalStart);

  const resourceDocs = resourceResult.data;
  const agencyRows = agencyResult.data;
  const roadmaps = roadmapResult.data;
  const marketSignals = marketResult.data;
  const industryArticles = articleResult.data;

  // One tool-call record per tool. `ok` is false for a degraded run (fell back to
  // direct, or an external provider outage) so a reader never mistakes a fallback
  // for a clean protocol call. Shared builder keeps the shape identical.
  const record = (tool: string, res: ToolCallResult<unknown>): ToolCallRecord => ({
    tool,
    transport: res.transport,
    ok: res.transport !== "skipped" && !res.degradedReason,
    items: res.data.length,
    degradedReason: res.degradedReason,
  });

  const toolCalls: ToolCallRecord[] = [
    { tool: "searchDocuments", transport: "direct", ok: true, items: ragDocs.length },
    record("searchResources", resourceResult),
    record("searchAgencies", agencyResult),
    record("searchCareerRoadmaps", roadmapResult),
    record("searchMarketSignals", marketResult),
    record("searchIndustryArticles", articleResult),
  ];

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

  // External tools note ONLY when they actually ran (never on a skipped tool): a
  // degraded run says the provider was unavailable; an empty-but-ok run says nothing
  // on-topic was found. Both keep the audit honest without inventing data.
  const externalNote = (label: string, res: ToolCallResult<ExternalResult>): void => {
    if (res.transport === "skipped") return;
    if (res.degradedReason) {
      missingDataNotes.push(`No verified external ${label} available (external provider unavailable).`);
    } else if (res.data.length === 0) {
      missingDataNotes.push(`No verified external ${label} found for this query.`);
    }
  };
  externalNote("career roadmaps", roadmapResult);
  externalNote("market signals", marketResult);
  externalNote("industry articles", articleResult);

  // sourcesUsed records everything that grounds the rendered answer: the DB
  // agencies + resource docs, plus the external (Tavily) sourced results now that
  // they ground the free text (Recommendation Agent context) and are recognized by
  // verification. Each external row keys on its url (its stable identity) under a
  // per-lane type. The log node still reads the legacy state.toolResults channel,
  // so this does not yet change ai_recommendations.sources_used — it keeps the
  // envelope honest about what actually grounded the answer.
  const externalSourceRefs = [
    ...roadmaps.map((r) => ({ id: r.url, type: "external_roadmap", sourceUrl: r.url })),
    ...marketSignals.map((r) => ({ id: r.url, type: "external_market_signal", sourceUrl: r.url })),
    ...industryArticles.map((r) => ({ id: r.url, type: "external_industry_article", sourceUrl: r.url })),
  ];
  const sourcesUsed = [
    ...agencyRows.map((a) => ({ id: a.id, type: "agency", sourceUrl: a.sourceUrl })),
    ...resourceDocs.map((d) => ({ id: d.id, type: d.type, sourceUrl: d.sourceUrl })),
    ...externalSourceRefs,
  ];

  const output: CareerDataAgentOutput = {
    ragDocs,
    resources,
    courses,
    agencies,
    // External sourced results. Carried on the envelope (and in toolCalls/trace),
    // and now folded into sourcesUsed above: they ground the Recommendation Agent's
    // free text and are recognized by verification, so they genuinely back the
    // answer rather than being supplementary UI data only.
    roadmaps,
    marketSignals,
    industryArticles,
    sourcesUsed,
    missingDataNotes,
    toolCalls,
    toolLatencyMs,
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
