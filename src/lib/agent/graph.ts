// The agentic-chat graph, now an explicit multi-agent (A2A) flow:
// START -> intent -> planner -> Profile Agent -> Career Data Agent ->
// Recommendation Agent -> Verification Agent -> memory -> evaluate -> log -> END.
// Exposed via /api/agent-chat. Compiled once and reused.
//
// The four agents are standalone cores (src/lib/agent/agents/*) wrapped by thin
// nodes that pass typed DTO envelopes between them (see each node for the explicit
// hand-off). The memory / evaluate / log nodes are unchanged — the agent nodes keep
// their backward-compat state channels populated.
import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import { intentNode } from "./nodes/intent";
import { plannerNode } from "./nodes/planner";
import { profileAgentNode } from "./nodes/profileAgent";
import { careerDataAgentNode } from "./nodes/careerDataAgent";
import { recommendationAgentNode } from "./nodes/recommendationAgent";
import { verificationAgentNode } from "./nodes/verificationAgent";
import { memoryNode } from "./nodes/memory";
import { evaluateNode } from "./nodes/evaluate";
import { logNode } from "./nodes/log";

export function buildAgentGraph() {
  // Node names must not collide with state channel names.
  return new StateGraph(AgentState)
    .addNode("extract_intent", intentNode)
    .addNode("planner", plannerNode)
    .addNode("profile_agent", profileAgentNode)
    .addNode("career_data_agent", careerDataAgentNode)
    .addNode("recommendation_agent", recommendationAgentNode)
    .addNode("verification_agent", verificationAgentNode)
    .addNode("update_memory", memoryNode)
    .addNode("evaluate", evaluateNode)
    .addNode("log_turn", logNode)
    .addEdge(START, "extract_intent")
    .addEdge("extract_intent", "planner")
    .addEdge("planner", "profile_agent")
    .addEdge("profile_agent", "career_data_agent")
    .addEdge("career_data_agent", "recommendation_agent")
    .addEdge("recommendation_agent", "verification_agent")
    .addEdge("verification_agent", "update_memory")
    .addEdge("update_memory", "evaluate")
    .addEdge("evaluate", "log_turn")
    .addEdge("log_turn", END)
    .compile();
}

// Reusable compiled graph.
export const agentGraph = buildAgentGraph();
