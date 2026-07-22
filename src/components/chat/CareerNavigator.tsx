"use client";

import { useState, type ReactNode } from "react";
import type {
  AgentResponse,
  AgencyItem,
  Evaluation,
  Sourced,
  ResourceItem,
  ExternalResult,
  HiringCompany,
  ToolCall,
} from "./types";

// The dynamic "Career Navigator" panel. Instead of stacking every section, it
// exposes the available sections as clickable TABS and shows only the selected
// one (default: Overview). Tabs appear only for sections the plan actually
// produced with content. The panel can expand to cover the chat area.

type TabKey =
  | "overview"
  | "roadmap"
  | "resources"
  | "courses"
  | "skill_focus"
  | "next_steps"
  | "agencies"
  | "hiring_companies"
  | "career_roadmaps"
  | "market_signals"
  | "industry_articles"
  | "evaluation";

const TAB_META: Record<TabKey, { label: string; icon: string }> = {
  overview: { label: "Overview", icon: "🧭" },
  roadmap: { label: "Roadmap", icon: "🗺️" },
  resources: { label: "Resources", icon: "🔗" },
  courses: { label: "Courses", icon: "🎓" },
  skill_focus: { label: "Skills to focus", icon: "🎯" },
  next_steps: { label: "Next steps", icon: "✅" },
  agencies: { label: "Agencies", icon: "🏢" },
  hiring_companies: { label: "Hiring Companies", icon: "🏗️" },
  career_roadmaps: { label: "Career Roadmaps", icon: "🌐" },
  market_signals: { label: "Market Signals", icon: "📊" },
  industry_articles: { label: "Industry Articles", icon: "📰" },
  evaluation: { label: "Evaluation", icon: "📈" },
};

// Stable tab order. The three EXTERNAL (Tavily) sections sit after the internal
// DB-backed sections and before evaluation.
const TAB_ORDER: TabKey[] = [
  "overview",
  "roadmap",
  "resources",
  "courses",
  "skill_focus",
  "next_steps",
  "agencies",
  // Hiring Companies is the PRIMARY answer for an entity-discovery query, so it leads
  // the external group — ahead of the optional Market Signals / Industry Articles.
  "hiring_companies",
  "career_roadmaps",
  "market_signals",
  "industry_articles",
  "evaluation",
];

const RISK_CLASS: Record<string, string> = {
  low: "border-accent/30 bg-accent/10 text-mint-light",
  medium: "border-amber-400/30 bg-amber-400/10 text-amber-700",
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

// Which tabs are available for THIS response (non-empty / planned). Link and
// text sections hide when empty; agencies show whenever the plan asked for them
// (so an explicit "any agencies?" still gets an answer, even if none verified).
function availableTabs(data: AgentResponse): TabKey[] {
  const s = data.sections;
  const planned = data.plan.sections;
  const ext = data.external;
  const has: Record<TabKey, boolean> = {
    overview: !!s.ai_suggestion && s.ai_suggestion.trim().length > 0,
    roadmap: !!s.roadmap && s.roadmap.items.length > 0,
    resources: !!s.resources && s.resources.items.length > 0,
    courses: !!s.courses && s.courses.items.length > 0,
    skill_focus: !!s.skill_focus && s.skill_focus.length > 0,
    next_steps: !!s.next_steps && s.next_steps.length > 0,
    agencies: planned.includes("agencies") && !!s.agencies,
    // External sections show only when the tool actually returned sourced results
    // (empty when external search is disabled or nothing matched) — no empty tabs.
    hiring_companies: (ext?.hiringCompanies?.length ?? 0) > 0,
    career_roadmaps: (ext?.roadmaps.length ?? 0) > 0,
    market_signals: (ext?.marketSignals.length ?? 0) > 0,
    industry_articles: (ext?.industryArticles.length ?? 0) > 0,
    evaluation: !!data.evaluation,
  };
  return TAB_ORDER.filter((t) => has[t]);
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
          className="group flex items-start gap-2 rounded-xl border border-slate-900/10 bg-slate-900/[0.03] px-3 py-2.5 transition hover:border-accent/40 hover:bg-slate-900/[0.06]"
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

// External (Tavily) sourced results. Same card affordance as LinkCards, plus the
// provenance the external tools carry: source host, publish date, relevance score,
// and a short snippet. `caption` lets the market-signals tab add its non-guarantee
// note without a separate component.
function ExternalCards({ items, caption }: { items: ExternalResult[]; caption?: string }) {
  if (items.length === 0) {
    return <p className="text-sm text-slate-400">No verified external results found for this query.</p>;
  }
  return (
    <div className="space-y-3">
      {caption ? <p className="text-xs text-slate-400">{caption}</p> : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {items.map((r, i) => (
          <a
            key={i}
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex flex-col rounded-xl border border-slate-900/10 bg-slate-900/[0.03] px-3 py-2.5 transition hover:border-accent/40 hover:bg-slate-900/[0.06]"
          >
            <span className="flex items-start gap-2">
              <span aria-hidden className="mt-0.5 text-accent">↗</span>
              <span className="min-w-0 text-sm font-medium text-slate-100 group-hover:text-heading">{r.title}</span>
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-6 text-xs text-slate-400">
              <span className="truncate">{r.source || hostOf(r.url)}</span>
              {r.publishedDate ? (
                <>
                  <span aria-hidden className="text-slate-600">·</span>
                  <span>{r.publishedDate.slice(0, 10)}</span>
                </>
              ) : null}
              {typeof r.score === "number" ? (
                <>
                  <span aria-hidden className="text-slate-600">·</span>
                  <span className="tabular-nums">score {r.score.toFixed(2)}</span>
                </>
              ) : null}
            </span>
            {r.snippet ? (
              <span className="mt-1 line-clamp-2 pl-6 text-xs leading-5 text-slate-500">{r.snippet}</span>
            ) : null}
          </a>
        ))}
      </div>
    </div>
  );
}

// Structured company entities for an entity/company-discovery query. Unlike the raw
// ExternalCards, this renders one card per REAL company with the fields the discovery
// flow extracts: name, why it matched, hiring roles, location, official careers site,
// and the source it was found in. Every company carries a real sourced link.
function HiringCompanyCards({ items }: { items: HiringCompany[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-slate-400">No hiring companies found for this query.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Real companies surfaced from live web search — sourced, not guaranteed. Verify roles and openings on each company&apos;s careers page.
      </p>
      <ul className="space-y-3">
        {items.map((c, i) => (
          <li key={i} className="rounded-xl border border-slate-900/10 bg-slate-900/[0.03] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-heading">{c.name}</span>
              {c.location ? (
                <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                  <span aria-hidden>📍</span>
                  {c.location}
                </span>
              ) : null}
            </div>
            {c.whyMatched ? (
              <p className="mt-1.5 text-sm leading-6 text-slate-300">{c.whyMatched}</p>
            ) : null}
            {c.roles.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.roles.map((role, r) => (
                  <span
                    key={r}
                    className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-slate-100"
                  >
                    {role}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {c.website ? (
                <a
                  href={c.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                >
                  Careers ↗ <span className="text-slate-400">{hostOf(c.website)}</span>
                </a>
              ) : null}
              <a
                href={c.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-slate-400 hover:text-heading hover:underline"
              >
                Source: {c.sourceName || hostOf(c.sourceUrl)} ↗
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Compact MCP provenance strip: which retrieval tools ran this turn and over which
// transport (MCP protocol vs. direct fallback). Skipped tools are omitted. A
// degraded call carries its reason in the tooltip.
function ToolsUsed({ tools }: { tools: ToolCall[] }) {
  const ran = tools.filter((t) => t.transport !== "skipped");
  if (ran.length === 0) return null;
  const mcpCount = ran.filter((t) => t.transport === "mcp").length;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-900/10 px-4 py-3 text-xs sm:px-5">
      <span className="font-semibold text-slate-300">Tools used (MCP):</span>
      {ran.map((t, i) => (
        <span
          key={i}
          title={t.degradedReason ?? undefined}
          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
            t.transport === "mcp"
              ? "border-accent/30 bg-accent/10 text-mint-light"
              : "border-amber-400/30 bg-amber-400/10 text-amber-700"
          }`}
        >
          {t.tool} · {t.transport === "mcp" ? "MCP" : "direct"}
        </span>
      ))}
      <span className="text-slate-500">— {mcpCount}/{ran.length} over the protocol</span>
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
        <li key={i} className="rounded-xl border border-slate-900/10 bg-slate-900/[0.03] p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold text-heading">{a.name}</span>
            <span className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold text-mint-light">
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
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-900/10">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(10, value)) * 10}%` }} />
      </div>
    </div>
  );
}

function EvaluationView({ e }: { e: Evaluation }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-semibold text-slate-100">
          Overall {e.overall}/10
        </span>
        <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${RISK_CLASS[e.hallucination_risk] ?? RISK_CLASS.low}`}>
          {e.hallucination_risk} hallucination risk
        </span>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        <MetricBar label="Groundedness" value={e.groundedness} />
        <MetricBar label="Relevance" value={e.relevance} />
        <MetricBar label="Personalization" value={e.personalization} />
        <MetricBar label="Actionability" value={e.actionability} />
        <MetricBar label="Safety" value={e.safety} />
      </div>
      {e.notes ? <p className="mt-3 text-xs text-slate-500">{e.notes}</p> : null}
    </div>
  );
}

// Renders the single selected section's content.
function SectionContent({ tab, data }: { tab: TabKey; data: AgentResponse }) {
  const s = data.sections;
  switch (tab) {
    case "overview":
      return <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{s.ai_suggestion}</p>;
    case "roadmap":
      return (
        <>
          {s.roadmap!.suggested ? (
            <p className="mb-3 text-xs text-slate-400">A general suggested roadmap — guidance, not verified external data.</p>
          ) : null}
          <ol className="relative space-y-4 border-l border-slate-900/10 pl-6">
            {s.roadmap!.items.map((step, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[31px] flex h-6 w-6 items-center justify-center rounded-full bg-brand/20 text-[11px] font-semibold text-mint-light ring-1 ring-brand/30">
                  {i + 1}
                </span>
                <p className="text-sm leading-6 text-slate-200">{step}</p>
              </li>
            ))}
          </ol>
        </>
      );
    case "resources":
      return <LinkCards section={s.resources!} />;
    case "courses":
      return <LinkCards section={s.courses!} />;
    case "skill_focus":
      return (
        <div className="flex flex-wrap gap-2">
          {s.skill_focus!.map((skill, i) => (
            <span key={i} className="rounded-xl border border-brand/25 bg-brand/10 px-3 py-1.5 text-sm text-slate-100">
              {skill}
            </span>
          ))}
        </div>
      );
    case "next_steps":
      return (
        <ul className="space-y-2">
          {s.next_steps!.map((step, i) => (
            <li key={i} className="flex gap-2 text-sm leading-6 text-slate-200">
              <span aria-hidden className="mt-0.5 text-accent">→</span>
              <span>{step}</span>
            </li>
          ))}
        </ul>
      );
    case "agencies":
      return <AgencyCards section={s.agencies!} />;
    case "hiring_companies":
      return <HiringCompanyCards items={data.external!.hiringCompanies ?? []} />;
    case "career_roadmaps":
      return <ExternalCards items={data.external!.roadmaps} />;
    case "market_signals":
      return (
        <ExternalCards
          items={data.external!.marketSignals}
          caption="Sourced market signals — descriptive of the cited source, not a guarantee of jobs, salary, or outcomes."
        />
      );
    case "industry_articles":
      return <ExternalCards items={data.external!.industryArticles} />;
    case "evaluation":
      return <EvaluationView e={data.evaluation!} />;
    default:
      return null;
  }
}

// A section may carry a "Suggested" badge (roadmap only) next to its heading.
function contentBadge(tab: TabKey, data: AgentResponse): ReactNode {
  if (tab === "roadmap" && data.sections.roadmap?.suggested) {
    return (
      <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
        Suggested
      </span>
    );
  }
  return null;
}

export function CareerNavigator({
  data,
  expanded,
  onToggleExpand,
}: {
  data: AgentResponse;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const tabs = availableTabs(data);
  // Default to Overview when present, otherwise the first available tab.
  const initial: TabKey = tabs.includes("overview") ? "overview" : tabs[0] ?? "overview";
  const [selected, setSelected] = useState<TabKey>(initial);
  // Guard: if the selected tab isn't available for this response, fall back.
  const active: TabKey = tabs.includes(selected) ? selected : initial;
  const v = data.verification;

  return (
    <div className="glass-card flex flex-col rounded-2xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-900/10 p-4 sm:p-5">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-heading">Career Navigator</h2>
          <p className="mt-0.5 truncate text-xs text-slate-400" title={data.plan.reasoning}>
            Built from your latest question
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className="btn-ghost hidden shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium lg:inline-flex"
          aria-pressed={expanded}
        >
          {expanded ? (
            <>
              <span aria-hidden>←</span> Back to chat
            </>
          ) : (
            <>
              <span aria-hidden>⤢</span> Expand
            </>
          )}
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1.5 overflow-x-auto border-b border-slate-900/10 px-3 py-2.5" role="tablist" aria-label="Career Navigator sections">
        {tabs.map((t) => {
          const on = t === active;
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setSelected(t)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                on
                  ? "bg-brand/20 text-heading ring-1 ring-brand/30"
                  : "text-slate-300 hover:bg-slate-900/5 hover:text-heading"
              }`}
            >
              <span aria-hidden>{TAB_META[t].icon}</span>
              {TAB_META[t].label}
            </button>
          );
        })}
      </div>

      {/* Selected section content */}
      <div className="min-h-[8rem] p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-heading">
            <span aria-hidden>{TAB_META[active].icon}</span>
            {TAB_META[active].label}
          </h3>
          {contentBadge(active, data)}
        </div>
        <SectionContent tab={active} data={data} />
      </div>

      {/* MCP provenance — which tools ran and over which transport */}
      <ToolsUsed tools={data.tools ?? []} />

      {/* Reflection verdict — persistent trust signal */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-900/10 px-4 py-3 text-xs sm:px-5">
        <span className={v.grounded ? "text-mint-light" : "text-danger"}>{v.grounded ? "✓ Grounded" : "⚠ Grounding flagged"}</span>
        <span className="text-slate-600">·</span>
        <span className={v.safe ? "text-mint-light" : "text-danger"}>{v.safe ? "✓ Safe" : "⚠ Safety flagged"}</span>
        {v.notes ? <span className="w-full text-slate-500 sm:w-auto">— {v.notes}</span> : null}
      </div>
    </div>
  );
}
