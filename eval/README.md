# Offline Evaluation Harness (RAGAS)

Benchmarks the pipeline's answers offline — RAG-specific metrics (faithfulness,
answer relevancy, context precision/recall) over exported datasets — plus a
regression gate against a committed baseline. The **runtime** evaluator
(`src/lib/agent/nodes/evaluate.ts`) is unchanged; this harness is for
benchmarking and regression testing, never the request path.

Division of labour: **TypeScript owns all DB access** (export + ingest);
**Python only reads JSONL and writes report JSON**. Drizzle stays the single
schema owner.

## One-time setup (Windows)

```powershell
cd eval
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Required env (read from the shell; the repo's `.env` values work):
`GROQ_API_KEY` (judge LLM via Groq's OpenAI-compatible endpoint) and
`VOYAGE_API_KEY` (embeddings for answer_relevancy — same vendor the app's RAG
embeddings use). Optional overrides: `GROQ_EVAL_MODEL`, `VOYAGE_EVAL_MODEL`.

## The regression flow (golden dataset)

From the repo root, with the venv active:

```powershell
# 1. Run the CURRENT pipeline over tests/fixtures/eval-golden.jsonl (~30 curated
#    queries; needs GROQ_API_KEY; no DB writes)
npm run eval:golden

# 2. Score it with RAGAS
python eval/run_ragas.py --dataset eval/datasets/golden-<date>.jsonl

# 3. Compare against the committed baseline (exit 1 on regression).
#    First ever run promotes automatically; later promotions are deliberate:
python eval/compare_baseline.py --report eval/reports/ragas-<timestamp>.json
#    ... after reviewing an intended improvement:  --promote

# 4. Persist the scores to eval_runs / eval_results
npm run eval:ingest -- --report eval/reports/ragas-<timestamp>.json
```

## Benchmarking production traffic

```powershell
npm run eval:export -- --limit 200        # ai_recommendations -> eval/datasets/prod-<date>.jsonl
python eval/run_ragas.py --dataset eval/datasets/prod-<date>.jsonl
npm run eval:ingest -- --report eval/reports/ragas-<timestamp>.json
```

Historical rows written before the source-excerpt enrichment may have partial
contexts; they are tagged `contexts_complete: false` and only scored on
answer_relevancy (judging faithfulness against contexts the export could not
reconstruct would punish the answer for the export's gap).

## What is committed vs ignored

- Committed: `eval/*.py`, `requirements.txt`, `eval/baselines/`,
  `tests/fixtures/eval-golden.jsonl`.
- Ignored (see `.gitignore`): `eval/.venv/`, `eval/datasets/`, `eval/reports/`,
  `__pycache__/`.

## Phase 2 (deferred)

DeepEval G-Eval metrics mirroring the runtime rubric (personalization, safety,
actionability) + HallucinationMetric, emitting the same report shape so
`eval:ingest` and the baseline comparison work unchanged.
