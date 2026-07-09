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
import type { AgentPlan, ResponseSections, Verification } from "./schema";

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
});

export type AgentStateType = typeof AgentState.State;
