// LangGraph state for the agentic-chat POC (/api/agent-chat). Each channel is a
// last-value-wins slot; nodes return a Partial of this state and LangGraph merges
// it. Only the channels through the planner are defined here (step b); tool
// results, generated sections, verification, and logId are added in later steps.
import { Annotation } from "@langchain/langgraph";
import type { Intent } from "../ai/intent";
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

// The user_profiles row (or undefined if the user has no profile yet), reused
// verbatim from the existing query helper without a runtime import.
export type ProfileRow = Awaited<ReturnType<typeof getProfileByUserId>>;

// Raw tool output. `resources` holds the documents backing BOTH the resources and
// courses sections (same searchResources tool); the generate node buckets them.
export type ToolResults = {
  agencies: RetrievedAgency[];
  resources: RetrievedDocument[];
};

const lastValue = <T>(_prev: T, next: T): T => next;

export const AgentState = Annotation.Root({
  // Inputs (provided at invoke).
  userId: Annotation<string>(),
  query: Annotation<string>(),
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

  // Planner output: which sections this query needs (post-gate).
  plan: Annotation<AgentPlan | undefined>({ reducer: lastValue, default: () => undefined }),

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

  // --- Explicit A2A agent output envelopes (the messages passed between the four
  // agents). Each agent node writes exactly one of these; the next node builds its
  // input DTO from the previous envelope(s), making the hand-off explicit. The
  // compat channels above (profile, memory, ragDocs, toolResults, sections,
  // verification) stay populated so the unchanged evaluate/memory/log nodes work.
  profileAgent: Annotation<ProfileAgentOutput | undefined>({ reducer: lastValue, default: () => undefined }),
  careerData: Annotation<CareerDataAgentOutput | undefined>({ reducer: lastValue, default: () => undefined }),
  recommendation: Annotation<RecommendationAgentOutput | undefined>({ reducer: lastValue, default: () => undefined }),
  verificationResult: Annotation<VerificationAgentOutput | undefined>({ reducer: lastValue, default: () => undefined }),
});

export type AgentStateType = typeof AgentState.State;
