"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { ChatPanel } from "./ChatPanel";
import { CareerNavigator } from "./CareerNavigator";
import type { AgentResponse, Turn } from "./types";

// The Career Chat workspace. Starts as a simple centered chat (intro + chips +
// input). After the first successful agent response it transitions into a split
// layout: the conversation stays on the left, and a dynamic Career Navigator
// panel on the right renders the structured sections of the LATEST response.

export function CareerWorkspace() {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The most recent assistant response drives the navigator panel.
  const latest = useMemo<AgentResponse | null>(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant") return t.data;
    }
    return null;
  }, [turns]);

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

  const hasResponse = latest !== null;

  const chat = (
    <ChatPanel
      turns={turns}
      message={message}
      onMessageChange={setMessage}
      onSend={send}
      loading={loading}
      error={error}
    />
  );

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pt-6 pb-6 sm:px-6">
      {/* Header */}
      <section className="mb-5">
        <span className="glass mb-3 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium text-heading">
          <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_2px_rgba(86,197,150,0.7)]" aria-hidden />
          Career Chat
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-heading sm:text-3xl">
          {hasResponse ? "Your career workspace" : "Ask, and the agent plans the answer"}
        </h1>
        {!hasResponse ? (
          <p className="mt-2 max-w-xl text-slate-300">
            A multi-step workflow: it detects intent, pulls your profile and memory, searches verified data, then builds a Career Navigator with only the sections your question needs.
          </p>
        ) : null}
      </section>

      {hasResponse ? (
        // Split workspace: chat left, navigator right (stacks on smaller screens).
        <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex min-w-0 flex-col">{chat}</div>
          <div className="min-w-0">
            <CareerNavigator data={latest} />
          </div>
        </div>
      ) : (
        // Initial simple chat: single centered column.
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">{chat}</div>
      )}
    </main>
  );
}
