// Runtime configuration for the agent graph's loops. Values are read from the
// environment ONCE at module load (the graph is compiled once and reused, so a
// per-request read would suggest a configurability the compiled graph does not
// have). Tests that need a different value set process.env BEFORE dynamically
// importing the graph module — the pattern tests/agent-regeneration.test.mts
// already uses.
//
// readAgentConfig is exported as a pure function so the clamping rules are unit
// testable without mutating the real environment.

export type AgentConfig = {
  // How many times the Recommendation Agent may REGENERATE after a rejection
  // before the run gives up and ships the safe fallback. 0 disables the loop
  // entirely (a rejection goes straight to fallback). Clamped: every retry is a
  // full generation + verification pass, so an unbounded value is a cost bug,
  // not a preference.
  maxRegenerations: number;
  // How many times verification may send the run back to the PLANNER (a full
  // re-plan + re-retrieval + re-generation pass) when it judges the evidence
  // insufficient. 0 disables re-planning — the kill-switch that restores the
  // regenerate-only loop.
  maxReplans: number;
};

const DEFAULTS = { maxRegenerations: 2, maxReplans: 1 } as const;
const BOUNDS = {
  maxRegenerations: { min: 0, max: 3 },
  maxReplans: { min: 0, max: 2 },
} as const;

function clampInt(
  name: string,
  raw: string | undefined,
  def: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    console.warn(`[agent-config] ${name}=${JSON.stringify(raw)} is not a number; using default ${def}.`);
    return def;
  }
  if (n < min || n > max) {
    const clamped = Math.min(max, Math.max(min, n));
    console.warn(`[agent-config] ${name}=${n} out of range [${min}, ${max}]; clamped to ${clamped}.`);
    return clamped;
  }
  return n;
}

// The parameter is typed as just the keys this config reads (not
// NodeJS.ProcessEnv) so tests can pass minimal fixture objects.
export type AgentConfigEnv = {
  AGENT_MAX_REGENERATIONS?: string;
  AGENT_MAX_REPLANS?: string;
};

export function readAgentConfig(
  // The cast is safe: reading an absent property yields undefined, which every
  // clamp treats as "use the default".
  env: AgentConfigEnv = process.env as AgentConfigEnv
): AgentConfig {
  return {
    maxRegenerations: clampInt(
      "AGENT_MAX_REGENERATIONS",
      env.AGENT_MAX_REGENERATIONS,
      DEFAULTS.maxRegenerations,
      BOUNDS.maxRegenerations.min,
      BOUNDS.maxRegenerations.max
    ),
    maxReplans: clampInt(
      "AGENT_MAX_REPLANS",
      env.AGENT_MAX_REPLANS,
      DEFAULTS.maxReplans,
      BOUNDS.maxReplans.min,
      BOUNDS.maxReplans.max
    ),
  };
}

// The singleton the graph reads. Frozen so a stray mutation cannot silently
// change loop bounds mid-process.
export const agentConfig: Readonly<AgentConfig> = Object.freeze(readAgentConfig());
