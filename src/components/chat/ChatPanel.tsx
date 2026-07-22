"use client";

import { useRef, useEffect, type FormEvent, type KeyboardEvent } from "react";
import { ExecutionTimeline } from "./ExecutionTimeline";
import type { Turn } from "./types";

// The conversation + input column. Presentational: all state lives in the parent
// CareerWorkspace. Assistant turns render as a compact summary bubble (the full
// structured answer lives in the Career Navigator panel), so the chat stays a
// lightweight conversation surface.

const SUGGESTIONS = [
  "What career path fits me?",
  "Roadmap and courses to become a data analyst",
  "Any career counsellor for switching to analytics?",
  "Show me agencies in Delhi",
];

function summarize(text: string, max = 160): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()}…`;
}

type ChatPanelProps = {
  turns: Turn[];
  message: string;
  onMessageChange: (v: string) => void;
  onSend: (text: string) => void;
  loading: boolean;
  error: string | null;
  // Index of the turn whose response is currently shown in the Career Navigator,
  // and a setter to pin a different one. Clicking an assistant bubble's pointer
  // restores that turn's stored response into the navigator.
  activeIndex: number;
  onSelectResponse: (index: number) => void;
};

export function ChatPanel({
  turns,
  message,
  onMessageChange,
  onSend,
  loading,
  error,
  activeIndex,
  onSelectResponse,
}: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, loading]);

  const isEmpty = turns.length === 0;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSend(message);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend(message);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 space-y-4">
        {isEmpty ? (
          <div className="glass-card rounded-3xl p-6 sm:p-8">
            <h2 className="text-lg font-semibold text-heading">Ask anything about your career</h2>
            <p className="mt-1 text-sm text-slate-400">
              The agent plans which parts to answer — overview, roadmap, courses, skills, resources, and verified agencies — and builds a Career Navigator from your question.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTIONS.map((sug) => (
                <button
                  key={sug}
                  type="button"
                  onClick={() => onSend(sug)}
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
            ) : "data" in t ? (
              // Assistant turn with a full envelope — live this session or restored
              // from its render snapshot. Its pointer is a button: clicking it pins
              // this turn's stored response into the navigator (no refetch). The
              // active turn shows a "Showing" label instead.
              <div key={i} className="flex justify-start">
                <div className="glass-card max-w-[90%] rounded-2xl px-4 py-3">
                  {t.data.sections.ai_suggestion ? (
                    <p className="text-sm leading-6 text-slate-200">{summarize(t.data.sections.ai_suggestion)}</p>
                  ) : (
                    <p className="text-sm leading-6 text-slate-200">Here&apos;s what I found for you.</p>
                  )}
                  <button
                    type="button"
                    onClick={() => onSelectResponse(i)}
                    aria-pressed={i === activeIndex}
                    className={`mt-2 text-xs font-medium transition-colors ${
                      i === activeIndex
                        ? "text-accent"
                        : "text-slate-400 hover:text-accent"
                    }`}
                  >
                    {i === activeIndex
                      ? "Showing in Career Navigator"
                      : t.rehydrated
                        ? "Career Navigator restored →"
                        : "Career Navigator updated →"}
                  </button>
                </div>
              </div>
            ) : (
              // Legacy rehydrated assistant turn: stored before render snapshots
              // existed, so only summary text survives — no navigator pointer,
              // there is no envelope behind it.
              <div key={i} className="flex justify-start">
                <div className="glass-card max-w-[90%] rounded-2xl px-4 py-3">
                  <p className="text-sm leading-6 text-slate-200">{summarize(t.content)}</p>
                </div>
              </div>
            )
          )
        )}

        {loading ? <ExecutionTimeline /> : null}

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
            onChange={(e) => onMessageChange(e.target.value)}
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
