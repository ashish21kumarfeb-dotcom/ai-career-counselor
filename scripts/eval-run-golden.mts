// Run the CURRENT pipeline over the committed golden dataset and export the
// results as an offline-evaluation dataset (JSONL). This is the regression path:
// unlike eval-export.mts (which benchmarks historical production rows), every
// answer here is produced by the code as it exists right now, with the full
// grounding contexts captured in-memory — no persistence gap.
//
//   npm run eval:golden -- [--limit 30] [--out path]
//
// Runs with persist:false (no DB writes, no memory updates) and a nil user (no
// profile), so the dataset measures the pipeline, not one user's context.
// Sequential on purpose: parallel runs would trip Groq rate limits and poison
// the scores with degraded fallbacks.
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentGraph } from "../src/lib/agent/graph";
import { toJsonl, type EvalCase } from "../src/lib/eval/export";
import { summarizeAssistantTurn } from "../src/lib/conversations/summarize";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!process.env.GROQ_API_KEY) {
  console.error("[eval-golden] GROQ_API_KEY is required — the golden run invokes the live pipeline.");
  process.exit(1);
}

type GoldenCase = { case_id: string; query: string; intent?: string; ground_truth?: string };

const fixturePath = join("tests", "fixtures", "eval-golden.jsonl");
const golden: GoldenCase[] = readFileSync(fixturePath, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as GoldenCase);

const limit = Number.parseInt(arg("limit") ?? String(golden.length), 10) || golden.length;
const date = new Date().toISOString().slice(0, 10);
const out = arg("out") ?? join("eval", "datasets", `golden-${date}.jsonl`);
const NOBODY = "00000000-0000-0000-0000-000000000000";

const cases: EvalCase[] = [];
for (const g of golden.slice(0, limit)) {
  const started = Date.now();
  try {
    const r = await agentGraph.invoke({ userId: NOBODY, query: g.query, persist: false });
    // Full grounding contexts straight off the envelope: every source ref's
    // excerpt (all lanes + RAG docs post-enrichment).
    const contexts = (r.careerData?.sourcesUsed ?? [])
      .map((s) => s.excerpt?.trim())
      .filter((e): e is string => !!e);
    cases.push({
      case_id: g.case_id,
      query: g.query,
      answer: summarizeAssistantTurn(r.sections) || "",
      contexts,
      intent: r.intent,
      ground_truth: g.ground_truth,
      contexts_complete: contexts.length > 0,
      runtime_eval: r.evaluation,
    });
    console.log(`[eval-golden] ${g.case_id} ok (${Date.now() - started}ms, ${contexts.length} contexts)`);
  } catch (error) {
    // A failed case is recorded as absent, not as an empty answer — an outage
    // must not read as a quality regression.
    console.error(`[eval-golden] ${g.case_id} FAILED, skipping:`, error);
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, toJsonl(cases), "utf8");
console.log(`[eval-golden] wrote ${cases.length}/${Math.min(limit, golden.length)} case(s) -> ${out}`);
process.exit(0);
