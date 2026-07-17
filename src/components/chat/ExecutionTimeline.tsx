"use client";

import { useEffect, useState } from "react";

// Vertical execution-timeline card shown while the agent is working. It renders
// the multi-step workflow (plan → retrieve → generate → verify) as a sequential
// timeline: one stage "in progress" at a time, completed stages with a green
// check + execution time, pending stages greyed out.
//
// Source of truth is the `stages` array below. Progression is driven either by
// real backend workflow events (pass the controlled `stage` prop — an index, or
// the length of `STAGES` once everything is done) or, when those aren't
// available, by a simulated sequential fallback based on each stage's `duration`.

type Stage = {
  id: string;
  title: string;
  description: string;
  duration: number; // simulated run time (ms) — also shown as the execution time
};

const STAGES: Stage[] = [
  { id: "planning", title: "Planning", description: "Understanding the query", duration: 800 },
  { id: "retrieving", title: "Retrieving", description: "Fetching verified sources & data", duration: 1500 },
  { id: "generating", title: "Generating", description: "Preparing the response", duration: 1600 },
  { id: "verifying", title: "Verifying", description: "Validating facts and sources", duration: 1100 },
];

type ExecutionTimelineProps = {
  // When provided, controls how many stages are completed (0..STAGES.length).
  // Wire this to real backend progress events. When omitted, the timeline
  // simulates sequential progression from the stage durations.
  stage?: number;
};

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden>
      <path
        d="M5 10.5l3.2 3.2L15 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ExecutionTimeline({ stage }: ExecutionTimelineProps) {
  // Number of completed stages. Controlled by `stage` when given, else simulated.
  const [step, setStep] = useState(stage ?? 0);
  const controlled = stage !== undefined;

  useEffect(() => {
    if (controlled) {
      setStep(Math.max(0, Math.min(STAGES.length, stage)));
      return;
    }
    // Simulated fallback: advance one stage at a time using each duration.
    setStep(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let elapsed = 0;
    STAGES.forEach((s, i) => {
      elapsed += s.duration;
      timers.push(setTimeout(() => setStep(i + 1), elapsed));
    });
    return () => timers.forEach(clearTimeout);
  }, [controlled, stage]);

  const allDone = step >= STAGES.length;

  return (
    <div className="flex justify-start">
      <div className="glass-card w-full max-w-md rounded-2xl p-4 sm:p-5">
        <ol className="relative">
          {STAGES.map((s, i) => {
            const status: "completed" | "active" | "pending" =
              i < step ? "completed" : i === step ? "active" : "pending";
            const isLast = i === STAGES.length - 1;

            return (
              <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0">
                {/* Vertical connector to the next stage */}
                {!isLast ? (
                  <span
                    className={`absolute left-[13px] top-8 h-[calc(100%-1rem)] w-px transition-colors duration-300 ${
                      i < step ? "bg-accent/50" : "bg-slate-600/20"
                    }`}
                    aria-hidden
                  />
                ) : null}

                {/* Node */}
                <span className="relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center">
                  {status === "completed" ? (
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white shadow-[0_0_0_4px_rgba(13,148,136,0.14)] transition-all duration-300">
                      <CheckIcon />
                    </span>
                  ) : status === "active" ? (
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white shadow-[0_0_0_4px_rgba(14,165,233,0.14)] transition-all duration-300">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand/25 border-t-brand motion-reduce:animate-none" />
                    </span>
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-slate-600/30 bg-white/50 transition-all duration-300">
                      <span className="h-2 w-2 rounded-full bg-slate-600/35" />
                    </span>
                  )}
                </span>

                {/* Content */}
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className={`truncate text-sm font-semibold transition-colors duration-300 ${
                        status === "pending" ? "text-slate-500" : "text-heading"
                      }`}
                    >
                      {s.title}
                    </p>
                    {status === "completed" ? (
                      <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent ring-1 ring-accent/20">
                        Completed
                      </span>
                    ) : status === "active" ? (
                      <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold text-brand-strong ring-1 ring-brand/20">
                        In Progress
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-slate-600/10 px-2 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-600/15">
                        Pending
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">{s.description}</p>
                  {status === "completed" ? (
                    <p className="mt-1 text-[11px] font-medium text-accent">{fmt(s.duration)}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>

        {allDone ? (
          <div className="mt-1 flex items-center gap-2 rounded-xl bg-accent/10 px-3 py-2 text-xs font-semibold text-accent ring-1 ring-accent/15 transition-all duration-300">
            <CheckIcon />
            All steps completed successfully.
          </div>
        ) : null}
      </div>
    </div>
  );
}
