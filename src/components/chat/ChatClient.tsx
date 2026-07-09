"use client";

import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";

// Minimal first chat slice: single-turn, non-streaming. Each send posts only the
// current message to /api/chat; prior turns are shown locally for context but are
// NOT sent back to the server yet (no multi-turn memory in this phase).

type Turn = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "What career paths fit my profile?",
  "How do I move into data analytics?",
  "What skills should I learn next?",
];

export function ChatClient() {
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
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });

      if (res.status === 401) {
        router.push("/signin");
        return;
      }

      const data = await res.json().catch(() => ({}));

      if (res.status === 200 && data.answer) {
        setTurns((prev) => [...prev, { role: "assistant", content: data.answer }]);
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
      {/* Messages */}
      <div className="flex-1 space-y-4">
        {isEmpty ? (
          <div className="glass-card rounded-3xl p-6 sm:p-8">
            <h2 className="text-lg font-semibold text-heading">Ask your career question</h2>
            <p className="mt-1 text-sm text-slate-400">
              Personalized to your profile. Advice is honest — no guaranteed jobs or salaries.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="btn-ghost rounded-full px-3.5 py-1.5 text-sm"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => (
            <div
              key={i}
              className={t.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={
                  t.role === "user"
                    ? "max-w-[85%] rounded-2xl bg-brand/15 px-4 py-3 text-sm leading-6 text-slate-100 ring-1 ring-brand/20"
                    : "glass-card max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 text-slate-100"
                }
              >
                {t.content}
              </div>
            </div>
          ))
        )}

        {loading ? (
          <div className="flex justify-start">
            <div className="glass-card rounded-2xl px-4 py-3 text-sm text-slate-400">
              Thinking…
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

      {/* Composer */}
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
