"use client";

import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

// Agentic chat UI: posts to /api/agent-chat (the LangGraph workflow) and renders
// the DYNAMIC sectioned response — only the sections the planner chose. Shows the
// plan and the reflection verdict too, so the agent's reasoning is visible.

type ResourceItem = { title: string; type: string; url: string | null };
type AgencyItem = {
  name: string;
  location: string | null;
  services: string | null;
  website: string | null;
  source: string | null;
};
type Sourced<T> = { items: T[]; note?: string };
type Sections = {
  ai_suggestion?: string;
  roadmap?: { items: string[]; suggested: boolean };
  resources?: Sourced<ResourceItem>;
  courses?: Sourced<ResourceItem>;
  agencies?: Sourced<AgencyItem>;
  next_steps?: string[];
};
type Evaluation = {
  groundedness: number;
  relevance: number;
  personalization: number;
  actionability: number;
  safety: number;
  hallucination_risk: "low" | "medium" | "high";
  notes: string;
  overall: number;
};
type AgentResponse = {
  intent: string;
  plan: { sections: string[]; reasoning: string };
  sections: Sections;
  verification: { grounded: boolean; safe: boolean; notes: string };
  evaluation?: Evaluation | null;
};

const RISK_CLASS: Record<string, string> = {
  low: "border-accent/30 bg-accent/10 text-mint-light",
  medium: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  high: "border-danger/30 bg-danger/10 text-danger",
};

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

function EvaluationView({ e }: { e: Evaluation }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Evaluation</h4>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-slate-100">
            Overall {e.overall}/10
          </span>
          <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${RISK_CLASS[e.hallucination_risk] ?? RISK_CLASS.low}`}>
            Hallucination: {e.hallucination_risk}
          </span>
        </div>
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

type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; data: AgentResponse };

const SUGGESTIONS = [
  "What career path fits me?",
  "Roadmap and courses to become a data analyst",
  "Any career counsellor for switching to analytics?",
  "Show me agencies in Delhi",
];

const SECTION_LABELS: Record<string, string> = {
  ai_suggestion: "Suggestion",
  roadmap: "Roadmap",
  resources: "Resources",
  courses: "Courses",
  agencies: "Agencies",
  next_steps: "Next steps",
};

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function LinkList({ section }: { section: Sourced<ResourceItem> }) {
  if (section.items.length === 0) {
    return <p className="text-sm text-slate-400">{section.note ?? "No verified data found."}</p>;
  }
  return (
    <ul className="space-y-2">
      {section.items.map((r, i) => (
        <li key={i}>
          <a
            href={r.url ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-start gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 transition hover:border-accent/40 hover:bg-white/10"
          >
            <span aria-hidden className="mt-0.5 text-accent">↗</span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-100 group-hover:text-heading">{r.title}</span>
              <span className="block truncate text-xs text-slate-400">{hostOf(r.url)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function AgencyList({ section }: { section: Sourced<AgencyItem> }) {
  if (section.items.length === 0) {
    return <p className="text-sm text-slate-400">{section.note ?? "No verified agencies found."}</p>;
  }
  return (
    <ul className="space-y-3">
      {section.items.map((a, i) => (
        <li key={i} className="rounded-2xl border border-white/10 bg-white/5 p-4">
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

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h4>
      {children}
    </div>
  );
}

function AgentResponseView({ data }: { data: AgentResponse }) {
  const s = data.sections;
  const v = data.verification;
  return (
    <div className="glass-card w-full space-y-4 rounded-2xl p-4 sm:p-5">
      {/* Plan chips — shows the agent decided which sections to include */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">Planned</span>
        {data.plan.sections.map((sec) => (
          <span key={sec} className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-slate-200">
            {SECTION_LABELS[sec] ?? sec}
          </span>
        ))}
      </div>

      {s.ai_suggestion ? (
        <SectionCard title="Suggestion">
          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{s.ai_suggestion}</p>
        </SectionCard>
      ) : null}

      {s.roadmap ? (
        <SectionCard title={s.roadmap.suggested ? "Roadmap · Suggested" : "Roadmap"}>
          {s.roadmap.suggested ? (
            <p className="mb-2 text-xs text-slate-400">A general suggested roadmap — guidance, not verified external data.</p>
          ) : null}
          <ol className="space-y-1.5">
            {s.roadmap.items.map((step, i) => (
              <li key={i} className="flex gap-2 text-sm leading-6 text-slate-200">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[11px] font-semibold text-mint-light">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </SectionCard>
      ) : null}

      {s.resources ? (
        <SectionCard title="Resources"><LinkList section={s.resources} /></SectionCard>
      ) : null}

      {s.courses ? (
        <SectionCard title="Courses"><LinkList section={s.courses} /></SectionCard>
      ) : null}

      {s.agencies ? (
        <SectionCard title="Agencies"><AgencyList section={s.agencies} /></SectionCard>
      ) : null}

      {s.next_steps && s.next_steps.length > 0 ? (
        <SectionCard title="Next steps">
          <ul className="space-y-1.5">
            {s.next_steps.map((step, i) => (
              <li key={i} className="flex gap-2 text-sm leading-6 text-slate-200">
                <span aria-hidden className="mt-0.5 text-accent">→</span>
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {/* Evaluation scorecard — surfaces the evaluate node (SRS §8) */}
      {data.evaluation ? <EvaluationView e={data.evaluation} /> : null}

      {/* Reflection verdict — surfaces the verify node */}
      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3 text-xs">
        <span className={v.grounded ? "text-mint-light" : "text-danger"}>{v.grounded ? "✓ Grounded" : "⚠ Grounding flagged"}</span>
        <span className="text-slate-600">·</span>
        <span className={v.safe ? "text-mint-light" : "text-danger"}>{v.safe ? "✓ Safe" : "⚠ Safety flagged"}</span>
        {v.notes ? <span className="w-full text-slate-500 sm:w-auto">— {v.notes}</span> : null}
      </div>
    </div>
  );
}

export function AgentChatClient() {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, loading]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setError(null);
    setMessage("");
    setTurns((prev) => [...prev, { role: "user", content: trimmed }]);
    setLoading(true);

    try {
      const res = await fetch("/api/agent-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });

      if (res.status === 401) {
        router.push("/signin");
        return;
      }

      const data = await res.json().catch(() => ({}));

      if (res.status === 200 && data.sections) {
        setTurns((prev) => [...prev, { role: "assistant", data: data as AgentResponse }]);
      } else {
        setError(data.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send(message);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(message);
    }
  }

  const isEmpty = turns.length === 0;

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 space-y-4">
        {isEmpty ? (
          <div className="glass-card rounded-3xl p-6 sm:p-8">
            <h2 className="text-lg font-semibold text-heading">Ask anything about your career</h2>
            <p className="mt-1 text-sm text-slate-400">
              The agent plans which parts to answer — suggestion, roadmap, resources, courses, or verified agencies — and shows only what your question needs.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTIONS.map((sug) => (
                <button
                  key={sug}
                  type="button"
                  onClick={() => void send(sug)}
                  className="btn-ghost rounded-full px-3.5 py-1.5 text-sm"
                >
                  {sug}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-brand/15 px-4 py-3 text-sm leading-6 text-slate-100 ring-1 ring-brand/20">
                  {t.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <AgentResponseView data={t.data} />
              </div>
            )
          )
        )}

        {loading ? (
          <div className="flex justify-start">
            <div className="glass-card rounded-2xl px-4 py-3 text-sm text-slate-400">
              Planning → retrieving → generating → verifying…
            </div>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div ref={endRef} />
      </div>

      <form onSubmit={handleSubmit} className="sticky bottom-4 mt-4">
        <div className="glass-card flex items-end gap-2 rounded-2xl p-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            maxLength={4000}
            placeholder="Ask about your next career move…"
            className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading || message.trim().length === 0}
            className="btn-primary flex h-10 shrink-0 items-center justify-center rounded-xl px-5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
