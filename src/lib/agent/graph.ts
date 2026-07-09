// The agentic-chat graph (step d): START -> intent -> context -> planner -> tools
// -> generate -> verify -> END. Later steps insert memory + log nodes and expose
// this via /api/agent-chat. Compiled once and reused.
import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import { intentNode } from "./nodes/intent";
import { contextNode } from "./nodes/context";
import { plannerNode } from "./nodes/planner";
import { toolNode } from "./nodes/tools";
import { generateNode } from "./nodes/generate";
import { verifyNode } from "./nodes/verify";

export function buildAgentGraph() {
  // Node names must not collide with state channel names (e.g. "intent").
  return new StateGraph(AgentState)
    .addNode("extract_intent", intentNode)
    .addNode("gather_context", contextNode)
    .addNode("planner", plannerNode)
    .addNode("tools", toolNode)
    .addNode("generate", generateNode)
    .addNode("verify", verifyNode)
    .addEdge(START, "extract_intent")
    .addEdge("extract_intent", "gather_context")
    .addEdge("gather_context", "planner")
    .addEdge("planner", "tools")
    .addEdge("tools", "generate")
    .addEdge("generate", "verify")
    .addEdge("verify", END)
    .compile();
}

// Reusable compiled graph.
export const agentGraph = buildAgentGraph();
