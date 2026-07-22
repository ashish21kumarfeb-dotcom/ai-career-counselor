// LangGraph state for the agentic-chat POC (/api/agent-chat). Each channel is a
// last-value-wins slot; nodes return a Partial of this state and LangGraph merges
// it. Only the channels through the planner are defined here (step b); tool
// results, generated sections, verification, and logId are added in later steps.
import { Annotation } from "@langchain/langgraph";
import type { Intent } from "../ai/intent";
import type { ChatTurn } from "../ai/resolveQuery";
import type { getProfileByUserId } from "../profile/queries";
import type { MemoryEntry } from "../memory/queries";
import type { RetrievedDocument } from "../documents/queries";
import type { RetrievedAgency } from "../agencies/queries";
import type { AgentPlan, ResponseSections, Verification, EvaluationScore } from "./schema";
import type {
  ProfileAgentOutput,
  CareerDataAgentOutput,
  RecommendationAgentOutput,
  VerificationAgentOutput,
} from "./agents/contracts";
import type { TraceEvent } from "./trace/types";
import type { ExecutionPlan } from "./plan/types";

// The user_profiles row (or undefined if the user has no profile yet), reused
// verbatim from the existing query helper without a runtime import.
export type ProfileRow = Awaited<ReturnType<typeof getProfileByUserId>>;

// Raw tool output. `resources` holds the documents backing BOTH the resources and
// courses sections (same searchResources tool); the generate node buckets them.
export type ToolResults = {
  agencies: RetrievedAgency[];
  resources: RetrievedDocument[];
};

// What the memory node actually did. `status: "ok"` with factsWritten 0 is a real
// result (the message stated nothing durable); "failed" means the extractor or
// the write could not run. Conflating the two is what let a rate-limited
// extraction trace as a success.
export type MemoryUpdateReport = {
  status: "ok" | "failed" | "skipped";
  factsExtracted: number;
  factsWritten: number;
  error?: string;
};

const lastValue = <T>(_prev: T, next: T): T => next;

export const AgentState = Annotation.Root({
  // Inputs (provided at invoke).
  userId: Annotation<string>(),
  query: Annotation<string>(),
  // Recent turns of the active conversation, LOADED BY THE ROUTE FROM
  // `conversation_messages` — no longer sent by the client. Used ONLY by the
  // resolve_query node to rewrite a follow-up into a standalone question; empty on
  // the first turn of a thread.
  history: Annotation<ChatTurn[]>({ reducer: lastValue, default: () => [] }),
  // The thread this run belongs to, so persist_trace can attribute the run to it.
  // Empty for a direct graph invocation (tests) — nothing in the pipeline reads it.
  conversationId: Annotation<string>({ reducer: lastValue, default: () => "" }),
  // The raw user message as typed, preserved after resolve_query overwrites `query`
  // with the resolved standalone form. Empty until that node runs.
  //
  // WHICH CHANNEL SHOULD A NODE READ? The rule, and it is not optional:
  //
  //   `query`         — anything that ACTS ON the question. Intent, planner, the
  //                     regex gates, retrieval/tokenization, generation, grounding
  //                     evidence. These want the resolved standalone form; that is
  //                     the entire point of rewriting a follow-up, and reading the
  //                     raw text here would break multi-turn resolution.
  //
  //   `originalQuery` — anything that RECORDS or DERIVES DURABLE STATE FROM the
  //                     user. Memory extraction (nodes/memory.ts) and turn logging
  //                     (nodes/log.ts). A rewrite is the machine's paraphrase; it
  //                     must never be stored as something the user said, and must
  //                     never become the input to a fact that outlives the run.
  //
  // Always read it as `state.originalQuery || state.query` — it defaults to "" and
  // is only populated once resolve_query has run, so a direct/partial invocation
  // (tests) would otherwise see an empty string.
  originalQuery: Annotation<string>({ reducer: lastValue, default: () => "" }),
  // Correlation id for the whole run, supplied by the caller (the route mints a
  // uuid; tests pass a fixed one). Deliberately NOT defaulted to a random value
  // here: a hidden per-run default would be untestable and could silently differ
  // from the id the route already returned/persisted.
  runId: Annotation<string>({ reducer: lastValue, default: () => "" }),
  // Whether the memory + log nodes write to the DB. Defaults true (the route);
  // tests invoke with false to avoid writes for a non-existent fake user.
  persist: Annotation<boolean>({ reducer: lastValue, default: () => true }),

  // --- Audit trace. THE ONLY APPEND-REDUCER CHANNEL in this graph: every other
  // channel is last-value-wins, but each traced node contributes one event and
  // they must accumulate in execution order rather than overwrite each other.
  // Written exclusively by the traced() wrapper in graph.ts — nodes never touch it.
  trace: Annotation<TraceEvent[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // Derived context.
  intent: Annotation<Intent>({ reducer: lastValue, default: () => "other" }),
  profile: Annotation<ProfileRow | undefined>({ reducer: lastValue, default: () => undefined }),
  memory: Annotation<MemoryEntry[]>({ reducer: lastValue, default: () => [] }),
  ragDocs: Annotation<RetrievedDocument[]>({ reducer: lastValue, default: () => [] }),

  // Planner output: which sections this query needs (post-gate). Kept in its
  // original shape — /api/agent-chat and the UI read it — and now derived FROM
  // executionPlan through the same finalizePlan() gates, so gating cannot drift.
  plan: Annotation<AgentPlan | undefined>({ reducer: lastValue, default: () => undefined }),

  // The full execution plan: goal, required context, agents, tools, risk checks,
  // expected sections. The artifact the workflow is judged on; persisted to
  // agent_runs.execution_plan.
  executionPlan: Annotation<ExecutionPlan | undefined>({ reducer: lastValue, default: () => undefined }),

  // DB tool output (agency + resource lookups).
  toolResults: Annotation<ToolResults>({
    reducer: lastValue,
    default: () => ({ agencies: [], resources: [] }),
  }),

  // Generated dynamic response (only the planned sections) + reflection result.
  sections: Annotation<ResponseSections | undefined>({ reducer: lastValue, default: () => undefined }),
  verification: Annotation<Verification | undefined>({ reducer: lastValue, default: () => undefined }),

  // Custom-evaluator score (SRS §8), stored on ai_recommendations.
  evaluation: Annotation<EvaluationScore | undefined>({ reducer: lastValue, default: () => undefined }),

  // Id of the ai_recommendations row the log node wrote, so the trace row can
  // foreign-key to it. Undefined when persist:false or the write failed.
  recommendationId: Annotation<string | undefined>({ reducer: lastValue, default: () => undefined }),

  // What the memory node did, so the trace reports it rather than assuming it.
  memoryUpdate: Annotation<MemoryUpdateReport | undefined>({ reducer: lastValue, default: () => undefined }),

  // --- Explicit A2A agent output envelopes (the messages passed between the four
  // agents). Each agent node writes exactly one of these; the next node builds its
  // input DTO from the previous envelope(s), making the hand-off explicit. The
  // compat channels above (profile, memory, ragDocs, toolResults, sections,
  // verification) stay populated so the unchanged evaluate/memory/log nodes work.
  profileAgent: Annotation<ProfileAgentOutput | undefined>({ reducer: lastValue, default: () => undefined }),
  careerData: Annotation<CareerDataAgentOutput | undefined>({ reducer: lastValue, default: () => undefined }),
  recommendation: Annotation<RecommendationAgentOutput | undefined>({ reducer: lastValue, default: () => undefined }),
  verificationResult: Annotation<VerificationAgentOutput | undefined>({ reducer: lastValue, default: () => undefined }),

  // How many times the Recommendation Agent has REGENERATED after a rejection.
  // 0 on the first pass. The router allows exactly one retry, so this never
  // exceeds 1; it is the loop's termination guard and must be incremented by a
  // node (a conditional-edge function returns a route, it cannot write state).
  regenerationAttempts: Annotation<number>({ reducer: lastValue, default: () => 0 }),
});

export type AgentStateType = typeof AgentState.State;
