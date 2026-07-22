"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { ChatPanel } from "./ChatPanel";
import { CareerNavigator } from "./CareerNavigator";
import type { AgentResponse, Turn } from "./types";

// The Career Chat workspace. Starts as a simple centered chat (intro + chips +
// input). After the first successful agent response it transitions into a split
// layout: the conversation on the left, and a dynamic Career Navigator panel on
// the right that shows one section at a time (tabs). The navigator can expand to
// cover the chat area; "New chat" resets back to the initial simple state.

export function CareerWorkspace() {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // The server-side thread. Null until the first response comes back with an id;
  // sending it on every subsequent message is what makes those messages part of
  // the same conversation. The client no longer sends the turns themselves — the
  // server owns the history and reads it from this id.
  const [conversationId, setConversationId] = useState<string | null>(null);

  // The most recent assistant response drives the navigator panel.
  const latest = useMemo<AgentResponse | null>(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant") return t.data;
    }
    return null;
  }, [turns]);

  // Number of assistant responses so far — used to remount the navigator on each
  // new response so its selected tab resets to Overview.
  const responseCount = useMemo(
    () => turns.reduce((n, t) => (t.role === "assistant" ? n + 1 : n), 0),
    [turns]
  );

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
        // Omitted on the first message: the server creates the thread and returns
        // its id below.
        body: JSON.stringify(
          conversationId ? { message: trimmed, conversationId } : { message: trimmed }
        ),
      });

      if (res.status === 401) {
        router.push("/signin");
        return;
      }

      const data = await res.json().catch(() => ({}));

      if (res.status === 200 && data.sections) {
        if (typeof data.conversationId === "string") setConversationId(data.conversationId);
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

  // New chat: clear the conversation and navigator, return to the initial state.
  function startNewChat() {
    setTurns([]);
    // Dropping the id is what makes the next message start a NEW thread rather
    // than continue the previous one — the old thread stays in the database.
    setConversationId(null);
    setMessage("");
    setError(null);
    setExpanded(false);
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

  const navigator = latest ? (
    <CareerNavigator
      key={responseCount}
      data={latest}
      expanded={expanded}
      onToggleExpand={() => setExpanded((e) => !e)}
    />
  ) : null;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 pt-6 pb-6 sm:px-6">
      {/* Header */}
      <section className="mb-5 flex items-start justify-between gap-3">
        <div>
          <span className="glass mb-3 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold text-heading">
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
        </div>
        {turns.length > 0 ? (
          <button
            type="button"
            onClick={startNewChat}
            className="btn-ghost inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium"
          >
            <span aria-hidden>＋</span> New chat
          </button>
        ) : null}
      </section>

      {!hasResponse ? (
        // Initial simple chat: single centered column.
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">{chat}</div>
      ) : expanded ? (
        // Expanded: navigator covers the chat area (sidebar stays; it's outside).
        <div className="flex-1">{navigator}</div>
      ) : (
        // Split workspace: chat left, navigator right (stacks on smaller screens).
        <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex min-w-0 flex-col">{chat}</div>
          <div className="min-w-0">{navigator}</div>
        </div>
      )}
    </main>
  );
}
