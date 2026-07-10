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

  // Profile-derived terms nudge resource RANKING toward the user's field/goal —
  // they never grant inclusion on their own (relevance is decided by the query's
  // specific topic terms), so an off-topic query never pulls the profile's topic.
  const p = state.profile;
  const contextTerms = p
    ? `${p.skills ?? ""} ${p.interests ?? ""} ${p.careerGoal ?? ""} ${p.currentRole ?? ""}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3)
    : [];

  const [agencies, resources] = await Promise.all([
    wantsAgencies
      ? searchAgencies(query).catch((e) => {
          console.error("searchAgencies failed:", e);
          return [];
        })
      : Promise.resolve([]),
    wantsResources
      ? searchResources(query, 5, contextTerms).catch((e) => {
          console.error("searchResources failed:", e);
          return [];
        })
      : Promise.resolve([]),
  ]);

  const toolResults: ToolResults = { agencies, resources };
  return { toolResults };
}
