// The agentic-chat graph (step c): START -> intent -> context -> planner -> tools
// -> END. Later steps insert generate, verify, memory, and log nodes between tools
// and END. Compiled once and reused.
import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import { intentNode } from "./nodes/intent";
import { contextNode } from "./nodes/context";
import { plannerNode } from "./nodes/planner";
import { toolNode } from "./nodes/tools";

export function buildAgentGraph() {
  // Node names must not collide with state channel names (e.g. "intent").
  return new StateGraph(AgentState)
    .addNode("extract_intent", intentNode)
    .addNode("gather_context", contextNode)
    .addNode("planner", plannerNode)
    .addNode("tools", toolNode)
    .addEdge(START, "extract_intent")
    .addEdge("extract_intent", "gather_context")
    .addEdge("gather_context", "planner")
    .addEdge("planner", "tools")
    .addEdge("tools", END)
    .compile();
}

// Reusable compiled graph.
export const agentGraph = buildAgentGraph();
