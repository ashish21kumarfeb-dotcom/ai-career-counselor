"""Compare a RAGAS report against the committed golden baseline; fail on
regression.

    python eval/compare_baseline.py --report eval/reports/ragas-<ts>.json
        [--baseline eval/baselines/golden-baseline.json]
        [--threshold 0.05] [--promote]

Exit codes: 0 = no metric dropped more than --threshold (or baseline was just
promoted); 1 = regression. --promote overwrites the baseline with this report's
aggregates — a deliberate act, done after a human has looked at the numbers,
never automatic.
"""

import argparse
import json
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--baseline", default="eval/baselines/golden-baseline.json")
    parser.add_argument("--threshold", type=float, default=0.05)
    parser.add_argument("--promote", action="store_true")
    args = parser.parse_args()

    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    aggregate: dict[str, float] = report.get("aggregate") or {}
    if not aggregate:
        raise SystemExit("[baseline] report carries no aggregate metrics — nothing to compare.")

    baseline_path = Path(args.baseline)
    if args.promote or not baseline_path.exists():
        if not baseline_path.exists():
            print("[baseline] no baseline yet — promoting this report as the first one.")
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(
            json.dumps({"dataset": report.get("dataset"), "aggregate": aggregate}, indent=2),
            encoding="utf-8",
        )
        print(f"[baseline] promoted -> {baseline_path}")
        return

    baseline = json.loads(baseline_path.read_text(encoding="utf-8")).get("aggregate") or {}
    failures = []
    delta = {}
    for metric, base_value in baseline.items():
        current = aggregate.get(metric)
        if current is None:
            failures.append(f"{metric}: missing from report (baseline {base_value})")
            continue
        delta[metric] = round(current - base_value, 4)
        print(f"[baseline] {metric}: {base_value} -> {current} ({delta[metric]:+})")
        if base_value - current > args.threshold:
            failures.append(f"{metric}: dropped {base_value - current:.4f} (> {args.threshold})")

    # Record the deltas back onto the report so eval:ingest persists them.
    report["baseline_delta"] = delta
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")

    if failures:
        print("[baseline] REGRESSION:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("[baseline] no regression.")


if __name__ == "__main__":
    main()
