"""Run RAGAS metrics over an exported dataset (JSONL from eval:export or
eval:golden) and write a JSON report to eval/reports/.

    python eval/run_ragas.py --dataset eval/datasets/golden-2026-07-23.jsonl
        [--batch 4] [--sleep 5] [--out eval/reports/...]

Metrics:
    faithfulness       — answer claims supported by the contexts. Runs only on
                         cases with contexts_complete=true (judging an answer
                         against contexts the export could not reconstruct
                         punishes the answer for the export's gap).
    answer_relevancy   — answer addresses the question (needs embeddings).
    context_precision  — retrieved contexts relevant to the question.
    context_recall     — contexts cover the reference; only on cases that carry
                         a ground_truth (the golden dataset).

The report shape is the contract with scripts/eval-ingest.mts:
    { framework, dataset, dataset_size, config, aggregate, per_case }

Batched with a sleep between batches: the judge is Groq and free-tier rate
limits otherwise degrade scores mid-run.
"""

import argparse
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

from datasets import Dataset
from ragas import evaluate
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.metrics import (
    answer_relevancy,
    context_precision,
    context_recall,
    faithfulness,
)

from config import EMBED_MODEL, JUDGE_MODEL, embeddings, judge_llm


def load_cases(path: Path) -> list[dict]:
    cases = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                cases.append(json.loads(line))
    return cases


def clean(value) -> float | None:
    """NaN-safe metric extraction (RAGAS yields NaN when a judge call fails)."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else round(f, 4)


def run_batch(rows: list[dict], metrics, llm, emb) -> list[dict]:
    ds = Dataset.from_dict(
        {
            "user_input": [r["query"] for r in rows],
            "response": [r["answer"] for r in rows],
            "retrieved_contexts": [r.get("contexts") or [""] for r in rows],
            "reference": [r.get("ground_truth") or "" for r in rows],
        }
    )
    result = evaluate(ds, metrics=metrics, llm=llm, embeddings=emb, show_progress=False)
    return result.to_pandas().to_dict("records")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--sleep", type=float, default=5.0)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    dataset_path = Path(args.dataset)
    cases = [c for c in load_cases(dataset_path) if c.get("answer", "").strip()]
    if not cases:
        raise SystemExit(f"[ragas] no usable cases in {dataset_path}")

    llm = LangchainLLMWrapper(judge_llm())
    emb = LangchainEmbeddingsWrapper(embeddings())

    per_case: list[dict] = []
    for start in range(0, len(cases), args.batch):
        batch = cases[start : start + args.batch]
        # Metric set is per-batch-uniform, so split each batch by capability.
        for rows, metrics in (
            # Complete contexts: the full reference-free set (+ recall with a reference).
            (
                [c for c in batch if c.get("contexts_complete")],
                None,  # decided below per reference availability
            ),
            # Incomplete contexts: only the context-free metric is honest.
            ([c for c in batch if not c.get("contexts_complete")], [answer_relevancy]),
        ):
            if not rows:
                continue
            if metrics is None:
                with_ref = [c for c in rows if c.get("ground_truth")]
                without_ref = [c for c in rows if not c.get("ground_truth")]
                groups = [
                    (with_ref, [faithfulness, answer_relevancy, context_precision, context_recall]),
                    (without_ref, [faithfulness, answer_relevancy, context_precision]),
                ]
            else:
                groups = [(rows, metrics)]
            for group_rows, group_metrics in groups:
                if not group_rows:
                    continue
                records = run_batch(group_rows, group_metrics, llm, emb)
                for case, record in zip(group_rows, records):
                    per_case.append(
                        {
                            "case_id": case["case_id"],
                            # prod exports use the ai_recommendations uuid as the
                            # case_id; golden cases use a "golden-*" slug with no row.
                            "recommendation_id": None if case["case_id"].startswith("golden-") else case["case_id"],
                            "contexts_complete": bool(case.get("contexts_complete")),
                            "metrics": {
                                k: clean(record.get(k))
                                for k in (
                                    "faithfulness",
                                    "answer_relevancy",
                                    "context_precision",
                                    "context_recall",
                                )
                                if k in record
                            },
                        }
                    )
        done = min(start + args.batch, len(cases))
        print(f"[ragas] {done}/{len(cases)} cases scored")
        if done < len(cases):
            time.sleep(args.sleep)

    # Aggregates: mean over the cases where each metric produced a number.
    aggregate: dict[str, float] = {}
    for key in ("faithfulness", "answer_relevancy", "context_precision", "context_recall"):
        values = [c["metrics"][key] for c in per_case if c["metrics"].get(key) is not None]
        if values:
            aggregate[key] = round(sum(values) / len(values), 4)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = Path(args.out) if args.out else Path("eval/reports") / f"ragas-{stamp}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "framework": "ragas",
        "dataset": dataset_path.stem,
        "dataset_size": len(per_case),
        "config": {"judge_model": JUDGE_MODEL, "embed_model": EMBED_MODEL},
        "aggregate": aggregate,
        "per_case": per_case,
    }
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[ragas] aggregate: {aggregate}")
    print(f"[ragas] report -> {out}")


if __name__ == "__main__":
    main()
