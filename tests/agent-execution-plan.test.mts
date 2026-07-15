// Execution-planner governance tests. Fully deterministic — no LLM, no DB.
// finalizeExecutionPlan() is the "dispose" half of propose/dispose, so every way
// a planner proposal can be overruled is asserted here.
// Run: npm run test:exec-plan
import "dotenv/config";
import { finalizeExecutionPlan, fallbackProposal, fallbackNeeds } from "../src/lib/agent/plan/finalize";
import { MANDATORY_AGENTS, AGENT_NAMES, TOOL_NAMES } from "../src/lib/agent/plan/registry";
import { plannerProposalSchema } from "../src/lib/agent/plan/types";
import type { PlannerProposal } from "../src/lib/agent/plan/types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
}

function proposal(over: Partial<PlannerProposal> = {}): PlannerProposal {
  return {
    goal: "Help the user switch into analytics.",
    requiredContext: ["profile", "memory"],
    agents: [...AGENT_NAMES],
    tools: [],
    expectedSections: ["ai_suggestion"],
    reasoning: "test",
    ...over,
  };
}
const LEARN = "how do I learn SQL to become a data analyst?"; // resourceGate passes, agencyGate fails
const ASK_PROVIDER = "can you suggest a career counsellor?";  // both gates pass

console.log("\n== registry allowlist: LLM proposes, registry disposes ==");
{
  const { executionPlan: ep } = finalizeExecutionPlan(
    proposal({
      agents: ["profile", "rogue_agent"],
      tools: [{ tool: "rm_rf_slash", reason: "definitely fine" }],
      requiredContext: ["profile", "the_entire_internet"],
      expectedSections: ["ai_suggestion", "make_me_a_sandwich"],
    }),
    LEARN, false
  );
  check("drops unregistered agent", !(ep.agents as string[]).includes("rogue_agent"), JSON.stringify(ep.agents));
  check("drops unregistered tool", !ep.tools.some((t) => (t.tool as string) === "rm_rf_slash"), JSON.stringify(ep.tools.map((t) => t.tool)));
  check("drops unregistered context", !(ep.requiredContext as string[]).includes("the_entire_internet"));
  check("drops unregistered section", !(ep.expectedSections as string[]).includes("make_me_a_sandwich"));
  check("records every drop as a plan issue", ep.planIssues.filter((i) => i.startsWith("Dropped")).length === 4, JSON.stringify(ep.planIssues));
}
{
  // The planner must not be able to skip its own verifier.
  const { executionPlan: ep } = finalizeExecutionPlan(proposal({ agents: ["profile"] }), LEARN, false);
  check("forces every mandatory agent back in", MANDATORY_AGENTS.every((a) => ep.agents.includes(a)), JSON.stringify(ep.agents));
  check("cannot drop the verification agent", ep.agents.includes("verification"));
  check("records the override", ep.planIssues.some((i) => i.includes("Forced required agent")), JSON.stringify(ep.planIssues));
}

console.log("\n== gates still decide sections (single source of truth) ==");
{
  // The whole point: an execution planner cannot bypass agencyGate.
  const { executionPlan: ep, plan } = finalizeExecutionPlan(
    proposal({ expectedSections: ["ai_suggestion", "agencies"] }), LEARN, false
  );
  check("agencies gated out of plan.sections", !plan.sections.includes("agencies"), JSON.stringify(plan.sections));
  check("expectedSections is POST-gate (never advertises a gated-out section)", !ep.expectedSections.includes("agencies"), JSON.stringify(ep.expectedSections));
  check("expectedSections mirrors plan.sections exactly", JSON.stringify(ep.expectedSections) === JSON.stringify(plan.sections));
  check("records the veto as a plan issue", ep.planIssues.some((i) => i.includes('Section "agencies" was proposed but gated out')), JSON.stringify(ep.planIssues));
}
{
  const { plan } = finalizeExecutionPlan(proposal({ expectedSections: ["ai_suggestion", "agencies"] }), ASK_PROVIDER, false);
  check("agencies survive when the query names a provider", plan.sections.includes("agencies"), JSON.stringify(plan.sections));
}
{
  const { plan } = finalizeExecutionPlan(proposal({ expectedSections: [] }), LEARN, false);
  check("empty proposal still yields >=1 section", plan.sections.length >= 1, JSON.stringify(plan.sections));
}

console.log("\n== tools derived from GATED sections, not from the proposal ==");
{
  const { executionPlan: ep } = finalizeExecutionPlan(
    proposal({ expectedSections: ["ai_suggestion", "agencies"], tools: [{ tool: "searchAgencies", reason: "user wants help" }] }),
    LEARN, false
  );
  const agencyTool = ep.tools.find((t) => t.tool === "searchAgencies")!;
  check("planned-but-gated tool is marked not allowed", agencyTool.allowed === false);
  check("records the tool veto", ep.planIssues.some((i) => i.includes('Tool "searchAgencies" was planned but vetoed')), JSON.stringify(ep.planIssues));
}
{
  // A plan that omits a tool that will run would be a lie.
  const { executionPlan: ep } = finalizeExecutionPlan(proposal({ tools: [] }), LEARN, false);
  const rag = ep.tools.find((t) => t.tool === "searchDocuments")!;
  check("searchDocuments always listed even when unrequested", !!rag && rag.allowed === true);
  check("searchDocuments is marked ungated (always runs)", rag.gated === false);
  check("every registered tool appears with a verdict", TOOL_NAMES.every((n) => ep.tools.some((t) => t.tool === n)), JSON.stringify(ep.tools.map((t) => t.tool)));
}
{
  const { executionPlan: ep } = finalizeExecutionPlan(proposal({ expectedSections: ["resources", "courses"] }), LEARN, false);
  check("searchResources allowed when a link section is gated in", ep.tools.find((t) => t.tool === "searchResources")?.allowed === true);
  check("searchAgencies not allowed for a learning query", ep.tools.find((t) => t.tool === "searchAgencies")?.allowed === false);
}

console.log("\n== risk checks are computed, never authored by the model ==");
{
  const { executionPlan: ep } = finalizeExecutionPlan(proposal({ expectedSections: ["ai_suggestion", "agencies"] }), LEARN, false);
  const push = ep.riskChecks.find((r) => r.check === "agency_push")!;
  check("agency_push triggered when planner asked for agencies", push.triggered === true);
  check("agency_push VETOED when the gate blocks", push.action === "veto");
  check("veto note names the gate", push.note.includes("agencyGate VETOED"), push.note);
}
{
  const { executionPlan: ep } = finalizeExecutionPlan(proposal({ expectedSections: ["ai_suggestion", "agencies"] }), ASK_PROVIDER, false);
  const push = ep.riskChecks.find((r) => r.check === "agency_push")!;
  check("agency_push allowed when the query names a provider", push.action === "allow");
}
{
  const { executionPlan: ep } = finalizeExecutionPlan(proposal({ expectedSections: ["ai_suggestion"] }), LEARN, false);
  const push = ep.riskChecks.find((r) => r.check === "agency_push")!;
  check("agency_push not triggered when agencies unrequested", push.triggered === false);
  check("risk register covers all four checks", ep.riskChecks.length === 4, JSON.stringify(ep.riskChecks.map((r) => r.check)));
}
{
  // A model must never be able to declare itself risk-free.
  const parsed = plannerProposalSchema.safeParse({
    goal: "g", requiredContext: [], agents: [], tools: [], expectedSections: [], reasoning: "r",
    riskChecks: [{ check: "agency_push", triggered: false, action: "allow", note: "all good, trust me" }],
  });
  check("proposal schema parses (extra keys tolerated)", parsed.success);
  check("planner-authored riskChecks are not carried through", !("riskChecks" in (parsed.success ? parsed.data : {})), JSON.stringify(parsed.success ? parsed.data : {}));
}

console.log("\n== degraded fallback fails closed ==");
{
  const gatePassing = [
    "what guidance do you have for a fresher?",
    "can you suggest a career counsellor?",
    "find me a recruiter",
  ];
  for (const q of gatePassing) {
    const { executionPlan: ep, plan } = finalizeExecutionPlan(fallbackProposal(q), q, true);
    check(`[${q.slice(0, 30)}…] fallback marked degraded`, ep.degraded === true);
    check(`[${q.slice(0, 30)}…] fallback excludes agencies`, !plan.sections.includes("agencies"), JSON.stringify(plan.sections));
    check(`[${q.slice(0, 30)}…] fallback still answers`, plan.sections.length >= 1);
    check(`[${q.slice(0, 30)}…] fallback keeps the verifier`, ep.agents.includes("verification"));
  }
  check("fallbackNeeds hard-codes agencies:false", fallbackNeeds("any career counsellor?").needs.agencies === false);
  const { executionPlan: ok } = finalizeExecutionPlan(proposal(), LEARN, false);
  check("a modelled plan is NOT marked degraded", ok.degraded === false);
}

console.log("\n== plan artifact honesty ==");
{
  const { executionPlan: ep } = finalizeExecutionPlan(proposal({ goal: "Switch into analytics." }), LEARN, false);
  check("goal is carried from the proposal", ep.goal === "Switch into analytics.");
  check("clean plan has no issues", ep.planIssues.length === 0, JSON.stringify(ep.planIssues));
  check("reasoning is carried", ep.reasoning === "test");
}

console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
process.exit(failed === 0 ? 0 : 1);
