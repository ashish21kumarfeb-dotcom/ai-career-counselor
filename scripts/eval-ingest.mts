// Ingest a Python-harness report (eval/reports/*.json) into eval_runs +
// eval_results. TypeScript owns all DB access — the Python side only reads JSONL
// and writes report JSON, so Drizzle stays the single schema owner.
//
//   npm run eval:ingest -- --report eval/reports/ragas-<timestamp>.json
//
// Report shape (produced by eval/run_ragas.py):
//   { framework, dataset, dataset_size, config, aggregate: {metric: number},
//     baseline_delta?, per_case: [{ case_id, recommendation_id?, metrics, passed? }] }
import "dotenv/config";
import { readFileSync } from "node:fs";
import { db } from "../src/db";
import { evalRuns, evalResults } from "../src/db/schema";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const reportPath = arg("report");
if (!reportPath) {
  console.error("[eval-ingest] usage: npm run eval:ingest -- --report <path to report json>");
  process.exit(1);
}

type Report = {
  framework: string;
  dataset: string;
  dataset_size: number;
  config?: unknown;
  aggregate?: Record<string, number>;
  baseline_delta?: unknown;
  per_case?: Array<{
    case_id: string;
    recommendation_id?: string;
    metrics?: Record<string, number>;
    passed?: boolean;
  }>;
};

const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
if (!report.framework || !report.dataset) {
  console.error("[eval-ingest] report is missing framework/dataset — refusing to ingest.");
  process.exit(1);
}

const [run] = await db
  .insert(evalRuns)
  .values({
    framework: report.framework,
    dataset: report.dataset,
    datasetSize: report.dataset_size ?? report.per_case?.length ?? 0,
    config: report.config,
    metrics: report.aggregate,
    baselineDelta: report.baseline_delta,
  })
  .returning({ id: evalRuns.id });

const perCase = report.per_case ?? [];
if (perCase.length > 0) {
  await db.insert(evalResults).values(
    perCase.map((c) => ({
      evalRunId: run.id,
      // Golden cases carry a slug, not a uuid; only real recommendation ids FK.
      recommendationId: c.recommendation_id,
      caseId: c.case_id,
      metrics: c.metrics,
      passed: c.passed,
    }))
  );
}

console.log(`[eval-ingest] eval_runs ${run.id}: ${perCase.length} case row(s) from ${reportPath}`);
process.exit(0);
