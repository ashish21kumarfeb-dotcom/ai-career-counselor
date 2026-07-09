// Tool node: runs ONLY the DB tools the plan requires, and re-enforces the gates
// at the tool boundary (defense in depth — finalizePlan already gated, but a tool
// must never run for a section the query didn't earn). All tools are DB-only and
// return [] when nothing matches; the generate node then says "no verified data
// found" rather than inventing. Fault-tolerant: a tool failure degrades to [].
import { searchAgencies } from "../../agencies/queries";
import { searchResources } from "../../documents/queries";
import { agencyGate, resourceGate } from "../schema";
import type { AgentStateType, ToolResults } from "../state";

export async function toolNode(
  state: AgentStateType
): Promise<Partial<AgentStateType>> {
  const sections = state.plan?.sections ?? [];
  const query = state.query;

  const wantsAgencies = sections.includes("agencies") && agencyGate(query);
  const wantsResources =
    (sections.includes("resources") || sections.includes("courses")) &&
    resourceGate(query);

  const [agencies, resources] = await Promise.all([
    wantsAgencies
      ? searchAgencies(query).catch((e) => {
          console.error("searchAgencies failed:", e);
          return [];
        })
      : Promise.resolve([]),
    wantsResources
      ? searchResources(query).catch((e) => {
          console.error("searchResources failed:", e);
          return [];
        })
      : Promise.resolve([]),
  ]);

  const toolResults: ToolResults = { agencies, resources };
  return { toolResults };
}
