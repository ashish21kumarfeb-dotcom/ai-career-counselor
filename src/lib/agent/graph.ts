// The agentic-chat graph: START -> intent -> context -> planner -> tools ->
// generate -> verify -> evaluate -> memory -> log -> END. Exposed via
// /api/agent-chat. Compiled once and reused.
import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import { intentNode } from "./nodes/intent";
import { contextNode } from "./nodes/context";
import { plannerNode } from "./nodes/planner";
import { toolNode } from "./nodes/tools";
import { generateNode } from "./nodes/generate";
import { verifyNode } from "./nodes/verify";
import { evaluateNode } from "./nodes/evaluate";
import { memoryNode } from "./nodes/memory";
import { logNode } from "./nodes/log";

export function buildAgentGraph() {
  // Node names must not collide with state channel names (e.g. "intent").
  return new StateGraph(AgentState)
    .addNode("extract_intent", intentNode)
    .addNode("gather_context", contextNode)
    .addNode("planner", plannerNode)
    .addNode("tools", toolNode)
    .addNode("generate", generateNode)
    .addNode("verify", verifyNode)
    .addNode("evaluate", evaluateNode)
    .addNode("update_memory", memoryNode)
    .addNode("log_turn", logNode)
    .addEdge(START, "extract_intent")
    .addEdge("extract_intent", "gather_context")
    .addEdge("gather_context", "planner")
    .addEdge("planner", "tools")
    .addEdge("tools", "generate")
    .addEdge("generate", "verify")
    .addEdge("verify", "evaluate")
    .addEdge("evaluate", "update_memory")
    .addEdge("update_memory", "log_turn")
    .addEdge("log_turn", END)
    .compile();
}

// Reusable compiled graph.
export const agentGraph = buildAgentGraph();
