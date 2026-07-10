"use client";

import type { ReactNode } from "react";
import type { AgentResponse, AgencyItem, Evaluation, Sourced, ResourceItem } from "./types";

// The dynamic "Career Navigator" panel. Renders the structured sections of the
// latest agent response — only the sections the plan produced — as a scannable
// workspace: overview, roadmap timeline, course/resource cards, skill chips,
// next steps, agencies (if any), and a compact evaluation scorecard.

const SECTION_LABELS: Record<string, string> = {
  ai_suggestion: "Overview",
  roadmap: "Roadmap",
  resources: "Resources",
  courses: "Courses",
  skill_focus: "Skills to focus",
  agencies: "Agencies",
  next_steps: "Next steps",
};

const RISK_CLASS: Record<string, string> = {
  low: "border-accent/30 bg-accent/10 text-mint-light",
  medium: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  high: "border-danger/30 bg-danger/10 text-danger",
};

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Panel({ icon, title, badge, children }: { icon: string; title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass-card rounded-2xl p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-heading">
          <span aria-hidden>{icon}</span>
          {title}
        </h3>
        {badge}
      </div>
      {children}
    </section>
  );
}

function LinkCards({ section }: { section: Sourced<ResourceItem> }) {
  if (section.items.length === 0) {
    return <p className="text-sm text-slate-400">{section.note ?? "No verified data found."}</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {section.items.map((r, i) => (
        <a
          key={i}
          href={r.url ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-start gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 transition hover:border-accent/40 hover:bg-white/10"
        >
          <span aria-hidden className="mt-0.5 text-accent">↗</span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-slate-100 group-hover:text-heading">{r.title}</span>
            <span className="block truncate text-xs text-slate-400">{hostOf(r.url)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

function AgencyCards({ section }: { section: Sourced<AgencyItem> }) {
  if (section.items.length === 0) {
    return <p className="text-sm text-slate-400">{section.note ?? "No verified agencies found."}</p>;
  }
  return (
    <ul className="space-y-3">
      {section.items.map((a, i) => (
        <li key={i} className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold text-heading">{a.name}</span>
            <span className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-mint-light">
              ✓ Verified
            </span>
          </div>
          {a.location ? <p className="mt-0.5 text-xs text-slate-400">{a.location}</p> : null}
          {a.services ? <p className="mt-2 text-sm leading-6 text-slate-300">{a.services}</p> : null}
          {a.website ? (
            <a
              href={a.website}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              Visit ↗
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function MetricBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>{label}</span>
        <span className="tabular-nums text-slate-300">{value}/10</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(10, value)) * 10}%` }} />
      </div>
    </div>
  );
}

// Compact, secondary evaluation: a one-line summary that expands on demand.
function EvaluationScore({ e }: { e: Evaluation }) {
  return (
    <details className="glass-card group rounded-2xl p-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <span aria-hidden>📈</span> Evaluation
        </span>
        <span className="flex items-center gap-2">
          <span className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-slate-100">
            Overall {e.overall}/10
          </span>
          <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${RISK_CLASS[e.hallucination_risk] ?? RISK_CLASS.low}`}>
            {e.hallucination_risk} risk
          </span>
          <span aria-hidden className="text-slate-500 transition-transform group-open:rotate-180">⌄</span>
        </span>
      </summary>
      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        <MetricBar label="Groundedness" value={e.groundedness} />
        <MetricBar label="Relevance" value={e.relevance} />
        <MetricBar label="Personalization" value={e.personalization} />
        <MetricBar label="Actionability" value={e.actionability} />
        <MetricBar label="Safety" value={e.safety} />
      </div>
      {e.notes ? <p className="mt-3 text-xs text-slate-500">{e.notes}</p> : null}
    </details>
  );
}

export function CareerNavigator({ data }: { data: AgentResponse }) {
  const s = data.sections;
  const v = data.verification;
  const hasAgencies = data.plan.sections.includes("agencies") && !!s.agencies;

  return (
    <div className="space-y-4">
      {/* Header: plan chips */}
      <div className="glass-card rounded-2xl p-4 sm:p-5">
        <h2 className="text-base font-semibold text-heading">Career Navigator</h2>
        <p className="mt-0.5 text-xs text-slate-400">Built from your latest question — {data.plan.reasoning}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {data.plan.sections.map((sec) => (
            <span key={sec} className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-slate-200">
              {SECTION_LABELS[sec] ?? sec}
            </span>
          ))}
        </div>
      </div>

      {/* Overview */}
      {s.ai_suggestion ? (
        <Panel icon="🧭" title="Overview">
          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{s.ai_suggestion}</p>
        </Panel>
      ) : null}

      {/* Roadmap — vertical timeline */}
      {s.roadmap ? (
        <Panel
          icon="🗺️"
          title="Learning roadmap"
          badge={
            s.roadmap.suggested ? (
              <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-300">
                Suggested
              </span>
            ) : undefined
          }
        >
          {s.roadmap.suggested ? (
            <p className="mb-3 text-xs text-slate-400">A general suggested roadmap — guidance, not verified external data.</p>
          ) : null}
          <ol className="relative space-y-4 border-l border-white/10 pl-6">
            {s.roadmap.items.map((step, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-brand/20 text-[11px] font-semibold text-mint-light ring-1 ring-brand/30">
                  {i + 1}
                </span>
                <p className="text-sm leading-6 text-slate-200">{step}</p>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}

      {/* Skills to focus — chips */}
      {s.skill_focus && s.skill_focus.length > 0 ? (
        <Panel icon="🎯" title="Skills to focus on">
          <div className="flex flex-wrap gap-2">
            {s.skill_focus.map((skill, i) => (
              <span key={i} className="rounded-xl border border-brand/25 bg-brand/10 px-3 py-1.5 text-sm text-slate-100">
                {skill}
              </span>
            ))}
          </div>
        </Panel>
      ) : null}

      {/* Courses */}
      {s.courses ? (
        <Panel icon="🎓" title="Recommended courses">
          <LinkCards section={s.courses} />
        </Panel>
      ) : null}

      {/* Resources */}
      {s.resources ? (
        <Panel icon="🔗" title="Useful resources">
          <LinkCards section={s.resources} />
        </Panel>
      ) : null}

      {/* Next steps */}
      {s.next_steps && s.next_steps.length > 0 ? (
        <Panel icon="✅" title="Next steps">
          <ul className="space-y-2">
            {s.next_steps.map((step, i) => (
              <li key={i} className="flex gap-2 text-sm leading-6 text-slate-200">
                <span aria-hidden className="mt-0.5 text-accent">→</span>
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* Agencies — only when the plan produced them */}
      {hasAgencies ? (
        <Panel icon="🏢" title="Verified agencies">
          <AgencyCards section={s.agencies!} />
        </Panel>
      ) : null}

      {/* Evaluation — compact, secondary */}
      {data.evaluation ? <EvaluationScore e={data.evaluation} /> : null}

      {/* Reflection verdict */}
      <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
        <span className={v.grounded ? "text-mint-light" : "text-danger"}>{v.grounded ? "✓ Grounded" : "⚠ Grounding flagged"}</span>
        <span className="text-slate-600">·</span>
        <span className={v.safe ? "text-mint-light" : "text-danger"}>{v.safe ? "✓ Safe" : "⚠ Safety flagged"}</span>
        {v.notes ? <span className="w-full text-slate-500 sm:w-auto">— {v.notes}</span> : null}
      </div>
    </div>
  );
}
