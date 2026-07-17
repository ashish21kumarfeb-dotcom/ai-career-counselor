// Intent-driven CORPUS selection for external (Tavily) search.
//
// The external search layer used to hardcode a corpus PER LANE — Market Signals and
// Industry Articles always searched Tavily's NEWS index. That assumption is wrong
// for most career questions: "hiring demand for X", "salary for Y", "roadmap to Z"
// are answered by EVERGREEN web content (job boards, guides, salary/skills pages),
// not by recent news. Forcing the news corpus starved those queries and returned
// near-zero-relevance general-business filler (evidence: max Tavily score ~0.05).
//
// This module makes the corpus a function of the QUERY'S SEARCH INTENT instead of
// the lane. It is a DATA TABLE, not a branch tree: each intent declares how to
// detect itself and which Tavily strategy it implies. Adding a new intent = adding a
// row — the Tavily wrappers never change. The DEFAULT is the evergreen/general
// corpus, so anything not explicitly time-sensitive stays on the corpus that answers
// career questions well; only genuinely breaking intents (layoffs, funding, M&A,
// announcements, breaking news) opt INTO the news corpus, with a recency window.
//
// Deliberately technology-agnostic: no rule mentions any role, language, or stack,
// so it works for Backend, Frontend, Java, Python, Data, AI, DevOps, Security, QA,
// Product, UX, and any future domain without change.

export type Corpus = "general" | "news";

export interface SearchStrategy {
  // Which Tavily index to search. "general" = evergreen web; "news" = recent news.
  corpus: Corpus;
  // Recency window in days. Only meaningful for the news corpus (tavilySearch
  // applies `days` only when topic === "news"); undefined for the evergreen corpus.
  days?: number;
}

export interface SearchIntent {
  name: string;
  // Higher wins when a query matches several intents: a time-sensitive signal must
  // override an evergreen one — "recent layoffs in data engineering" is news, even
  // though it also mentions a role/field.
  priority: number;
  // Matched against the lowercased query. Generic — never technology-specific.
  pattern: RegExp;
  strategy: SearchStrategy;
}

// The evergreen default: the corpus that answers demand / salary / skills / roadmap
// / analysis questions. Everything falls back here unless a higher-priority
// time-sensitive intent matches, so an UNRECOGNIZED query still searches the corpus
// that serves career questions well — never the starved news index.
export const DEFAULT_STRATEGY: SearchStrategy = { corpus: "general" };
export const DEFAULT_INTENT = "evergreen_default";

// Intent registry. Selection is by PRIORITY (see resolveSearchStrategy), so array
// order only breaks ties. Extend the layer by adding a row here — no wrapper or
// control-flow change. Two priority bands today:
//   100  time-sensitive  -> news corpus (+ recency window)
//    50  evergreen        -> general corpus
export const SEARCH_INTENTS: SearchIntent[] = [
  // --- Time-sensitive -> NEWS corpus. High-precision triggers ONLY: the generic
  // recency words "current" / "latest" / "recent" are intentionally absent, because
  // "current hiring demand" and "latest in-demand skills" are evergreen questions. ---
  {
    name: "layoffs",
    priority: 100,
    pattern: /\b(layoffs?|lay[- ]?offs?|job cuts?|redundanc\w*|hiring freeze|downsiz\w*|workforce reduction)\b/,
    strategy: { corpus: "news", days: 60 },
  },
  {
    name: "funding",
    priority: 100,
    pattern: /\b(funding round|series [a-e]\b|seed round|raised \$?\d|venture round|\bipo\b|valuation)\b/,
    strategy: { corpus: "news", days: 90 },
  },
  {
    name: "acquisition",
    priority: 100,
    pattern: /\b(acquisitions?|acquir\w*|mergers?|merg\w*|takeovers?|buyouts?)\b/,
    strategy: { corpus: "news", days: 90 },
  },
  {
    name: "announcement",
    priority: 100,
    pattern: /\b(announc\w*|unveil\w*|press release|newly launched|breaking news|latest news|recent news|in the news)\b/,
    strategy: { corpus: "news", days: 30 },
  },

  // --- Evergreen -> GENERAL corpus. Named for observability and extensibility:
  // they all resolve to the general corpus today (same as the default), but naming
  // each intent lets a future strategy refine ONE of them (e.g. a salary-specific
  // domain set, or a certifications recency window) without touching the wrappers. ---
  {
    name: "hiring_demand",
    priority: 50,
    pattern: /\b(hiring|in[- ]?demand|demand for|job outlook|employment outlook|job market|market outlook|company hiring|hiring trends?)\b/,
    strategy: { corpus: "general" },
  },
  {
    name: "salary",
    priority: 50,
    pattern: /\b(salar\w*|pay|compensation|wages?|earnings?)\b/,
    strategy: { corpus: "general" },
  },
  {
    name: "skills",
    priority: 50,
    pattern: /\b(skills?|upskill\w*|competenc\w*|proficienc\w*)\b/,
    strategy: { corpus: "general" },
  },
  {
    name: "certifications",
    priority: 50,
    pattern: /\b(certif\w*|credential\w*|licen[sc]e\w*)\b/,
    strategy: { corpus: "general" },
  },
  {
    name: "roadmap",
    priority: 50,
    pattern: /\b(roadmap|learning path|career path|pathway|how (do|to|can).*(become|get into|break into|start))\b/,
    strategy: { corpus: "general" },
  },
  {
    name: "learning_resources",
    priority: 50,
    pattern: /\b(courses?|tutorials?|bootcamps?|learn\w*|training|study|resources?|materials?)\b/,
    strategy: { corpus: "general" },
  },
  {
    name: "industry_analysis",
    priority: 50,
    pattern: /\b(industry analysis|market analysis|landscape|state of|overview|trends?|analysis|adoption|technology adoption|widely used|market share)\b/,
    strategy: { corpus: "general" },
  },
];

export interface ResolvedStrategy {
  intent: string;
  strategy: SearchStrategy;
}

// Resolve a query to its search strategy. Scans the registry, keeps the HIGHEST-
// priority match (first-declared wins a tie), and falls back to the evergreen
// default when nothing matches. Pure and deterministic — no LLM, no network — so a
// lane wrapper can call it inline before every Tavily request.
export function resolveSearchStrategy(query: string): ResolvedStrategy {
  const q = query.toLowerCase();
  let best: SearchIntent | undefined;
  for (const intent of SEARCH_INTENTS) {
    if (intent.pattern.test(q) && (best === undefined || intent.priority > best.priority)) {
      best = intent;
    }
  }
  return best
    ? { intent: best.name, strategy: best.strategy }
    : { intent: DEFAULT_INTENT, strategy: DEFAULT_STRATEGY };
}
