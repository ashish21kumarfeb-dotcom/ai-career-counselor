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
  searchHiringCompanies,
} from "../../external/tavily";
import {
  agencyGate,
  resourceGate,
  careerRoadmapGate,
  marketSignalGate,
  industryArticleGate,
  liveBusinessGate,
} from "../schema";
import { buildDbSections } from "../sections";
import { extractHiringCompanies } from "./hiringCompanies";
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
  // Live-business / hiring-companies lane: real companies from the open web when the
  // query wants current hiring activity. Same master-kill-switch + keyword-gate shape
  // as the lanes above; liveBusinessGate ALSO vetoed the DB agency tool (agencyGate),
  // so a freshness query lands here instead of on the seeded consulting_agencies rows.
  const wantsHiring = externalOn && liveBusinessGate(query);

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
  //
  // A PROVIDER outage and a TRANSPORT fallback are different failures and must not
  // be conflated (see externalNote below): callTool sets degradedReason whenever the
  // MCP path was not used — including the ordinary local case of MCP_ENABLED being
  // unset — which says nothing about whether the search itself succeeded. Only
  // direct() actually throwing means the provider was unavailable, so that is
  // recorded separately, here, where it is known.
  const providerFailed = new Set<string>();
  const externalCall = (
    want: boolean,
    tool: string,
    direct: () => Promise<ExternalResult[]>
  ): Promise<ToolCallResult<ExternalResult>> =>
    want
      ? callTool<ExternalResult>(tool, { query, limit: 5 }, externalResultSchema, () =>
          direct().catch((e) => {
            console.error(`Career Data Agent: ${tool} failed:`, e);
            providerFailed.add(tool);
            return [] as ExternalResult[];
          })
        )
      : Promise.resolve(skipped() as ToolCallResult<ExternalResult>);

  const retrievalStart = performance.now();
  const [
    ragDocs,
    resourceResult,
    agencyResult,
    roadmapResult,
    marketResult,
    articleResult,
    hiringResult,
  ] = await Promise.all([
      // contextTerms are passed HERE too, not only to searchResources below. They
      // were omitted, so the parameter's `[]` default applied and RAG grounding —
      // the lane whose passages the answer is actually built on — ranked without
      // any knowledge of the user, while the resource-link lane ranked with it.
      // Personalization was reaching the citations and not the evidence.
      //
      // Safe to add because contextTerms only ADD to an already-included doc's
      // score (see scoreDocument); inclusion is decided by specificHits against
      // the query alone. So this reorders results without widening them, and the
      // abstention floor is untouched: a profile term cannot pull in a document
      // the query did not already qualify.
      searchDocuments(query, userId, 3, contextTerms).catch((e) => {
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
      externalCall(wantsHiring, "searchHiringCompanies", () => searchHiringCompanies(query, 5)),
    ]);
  const toolLatencyMs = Math.round(performance.now() - retrievalStart);

  const resourceDocs = resourceResult.data;
  const agencyRows = agencyResult.data;
  const roadmaps = roadmapResult.data;
  const marketSignals = marketResult.data;
  const industryArticles = articleResult.data;
  const hiringCompanies = hiringResult.data;

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
    record("searchHiringCompanies", hiringResult),
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
  //
  // A note is emitted ONLY when the lane actually came back empty. It used to key on
  // `degradedReason`, which callTool sets for ANY non-MCP call — so in the normal
  // local configuration (MCP_ENABLED unset) a lane that had just returned five
  // sourced results still reported "No verified external market signals available
  // (external provider unavailable)". That note is read by the Recommendation Agent
  // as RETRIEVAL STATUS — "searched and NOT found, treat as a gap in the evidence" —
  // so the prompt told the model its own evidence did not exist while listing it two
  // paragraphs above. That contradiction, not the retrieval, is why a query with good
  // market data still answered as though it had none. Transport degradation is
  // already reported honestly and separately, in toolCalls.
  const externalNote = (
    label: string,
    tool: string,
    res: ToolCallResult<ExternalResult>
  ): void => {
    if (res.transport === "skipped" || res.data.length > 0) return;
    missingDataNotes.push(
      providerFailed.has(tool)
        ? `No verified external ${label} available (external provider unavailable).`
        : `No verified external ${label} found for this query.`
    );
  };
  externalNote("career roadmaps", "searchCareerRoadmaps", roadmapResult);
  externalNote("market signals", "searchMarketSignals", marketResult);
  externalNote("industry articles", "searchIndustryArticles", articleResult);
  externalNote("companies hiring", "searchHiringCompanies", hiringResult);

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
    ...hiringCompanies.map((r) => ({ id: r.url, type: "external_hiring_company", sourceUrl: r.url })),
  ];
  const sourcesUsed = [
    ...agencyRows.map((a) => ({ id: a.id, type: "agency", sourceUrl: a.sourceUrl })),
    ...resourceDocs.map((d) => ({ id: d.id, type: d.type, sourceUrl: d.sourceUrl })),
    ...externalSourceRefs,
  ];

  // Company/entity-discovery step: distil the sourced hiring results into structured
  // company entities for the dedicated "Hiring Companies" section. Runs ONLY when the
  // live-hiring lane actually returned sourced rows (so it costs nothing on any other
  // query), and is best-effort — the grounding firewall lives in coerceHiringCompanies,
  // and any failure degrades to [] without touching the rest of the envelope.
  const hiringCompanyEntities =
    hiringCompanies.length > 0 ? await extractHiringCompanies(query, hiringCompanies) : [];

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
    // Real companies hiring now (open web). Carried on the envelope, audited in
    // toolCalls, folded into sourcesUsed above, and cited by the Recommendation Agent.
    hiringCompanies,
    // The structured companies extracted from those results (entity-discovery). Empty
    // unless the hiring lane fired and yielded rows. Drives the Hiring Companies section.
    hiringCompanyEntities,
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
