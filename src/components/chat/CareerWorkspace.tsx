"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  const searchParams = useSearchParams();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Which assistant response drives the navigator. `null` means "follow the
  // latest" — the default and what every new message resets to. A number pins the
  // navigator to that turn index, letting the user revisit an earlier response
  // (its stored envelope is reused as-is — never refetched or regenerated).
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // The server-side thread. Null until the first response comes back with an id;
  // sending it on every subsequent message is what makes those messages part of
  // the same conversation. The client no longer sends the turns themselves — the
  // server owns the history and reads it from this id.
  const [conversationId, setConversationId] = useState<string | null>(null);

  // Resume a thread from the URL (`/chat?c=<id>`). The id lives in the URL so a
  // reloaded — or shared — link restores the same conversation. Read once: the
  // ref stops React Strict Mode's double-invoke (and any later render) from
  // re-fetching or clobbering turns the user has since added.
  const initialConvId = searchParams.get("c");
  const rehydratedRef = useRef(false);

  useEffect(() => {
    if (rehydratedRef.current || !initialConvId) return;
    rehydratedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/conversations/${initialConvId}/messages`);
        if (res.status === 401) {
          router.push("/signin");
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        const messages: Array<{
          role: "user" | "assistant";
          content: string;
          // The render snapshot, present on assistant turns stored with full
          // fidelity. Null for user turns and for legacy assistant turns written
          // before snapshots existed.
          response?: AgentResponse | null;
        }> = Array.isArray(data.messages) ? data.messages : [];

        // Empty means the id is stale, foreign, or unwritten (the route returns []
        // for a thread that is not this user's — see the ownership note there).
        // Drop the param and fall back to a fresh chat rather than resuming nothing.
        if (messages.length === 0) {
          router.replace("/chat");
          return;
        }

        // Full-fidelity rehydration: an assistant turn carrying its stored
        // `response` envelope restores as a LIVE-shaped turn (`data`), so the Career
        // Navigator rebuilds exactly as first generated — sections, external
        // signals, tools, verification, and evaluation. A turn without a snapshot
        // (legacy row) falls back to text-only; user turns are plain text.
        setTurns(
          messages.map((m): Turn => {
            if (m.role === "user") return { role: "user", content: m.content };
            if (m.response) return { role: "assistant", data: m.response, rehydrated: true };
            return { role: "assistant", content: m.content };
          })
        );
        setConversationId(initialConvId);
      } catch {
        // Network failure: leave the empty state and keep the URL id so a manual
        // reload can retry, rather than silently discarding the thread.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialConvId, router]);

  // Index of the most recent assistant turn carrying an envelope. Every assistant
  // turn with `data` qualifies — live this session or rehydrated from its stored
  // snapshot. -1 when there is none yet.
  const latestIndex = useMemo<number>(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant" && "data" in t) return i;
    }
    return -1;
  }, [turns]);

  // The turn index the navigator is currently showing: the pinned one if it still
  // points at a valid envelope, otherwise the latest. A pinned index that no
  // longer resolves (e.g. after "New chat") falls back to latest.
  const displayedIndex = useMemo<number>(() => {
    if (activeIndex !== null) {
      const t = turns[activeIndex];
      if (t && t.role === "assistant" && "data" in t) return activeIndex;
    }
    return latestIndex;
  }, [activeIndex, turns, latestIndex]);

  // The response that drives the navigator panel — the displayed turn's stored
  // envelope. Reused directly; nothing is refetched when revisiting an old one.
  const displayed = useMemo<AgentResponse | null>(() => {
    const t = turns[displayedIndex];
    return t && t.role === "assistant" && "data" in t ? t.data : null;
  }, [turns, displayedIndex]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setError(null);
    setMessage("");
    // Unpin: a new message always makes the newest response active again.
    setActiveIndex(null);
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
        if (typeof data.conversationId === "string") {
          setConversationId(data.conversationId);
          // First message of a new thread: put its id in the URL so a reload or a
          // shared link resumes it. `replace`, not `push`, so the id-less empty
          // state is not left on the back stack. Subsequent messages already have
          // the id and skip this.
          if (!conversationId) {
            router.replace(`/chat?c=${data.conversationId}`);
          }
        }
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
    setActiveIndex(null);
    // Clear `?c=` so a reload after "New chat" doesn't resume the old thread.
    router.replace("/chat");
  }

  const hasResponse = displayed !== null;

  const chat = (
    <ChatPanel
      turns={turns}
      message={message}
      onMessageChange={setMessage}
      onSend={send}
      loading={loading}
      error={error}
      activeIndex={displayedIndex}
      onSelectResponse={setActiveIndex}
    />
  );

  const navigator = displayed ? (
    // Keyed by the displayed turn so switching to another response (or a new one
    // arriving) remounts the navigator and resets its tab to Overview.
    <CareerNavigator
      key={displayedIndex}
      data={displayed}
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
