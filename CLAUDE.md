@AGENTS.md

# AI Career Counselor — Project Instructions

## Purpose
An AI Career Counselor that guides students, freshers, working professionals, and job switchers with source-backed, personalized career advice. The primary goal of this MVP is to prove a complete AI engineering flow — not to ship a commercial product.

## MVP Scope
Core AI flow to implement end to end:
`User input → intent extraction → context (memory + RAG) → guardrails → planner agent → execution loop (multi-agent + tools) → reflection → memory update → evaluation → final answer`

Rules that apply to all AI output:
- Advice must be **source-backed** (RAG) where possible.
- Answers must be **safe**: no fake job/salary guarantees, no invented consulting agencies, no overconfident claims. Separate opinions from facts.
- Answers must be **personalized** using the user's profile and memory.
- Agency data comes **only** from the database — never generate agency names.

## Tech Stack
- Next.js (App Router) — this is a customized Next.js; read `node_modules/next/dist/docs/` before writing Next.js code (see AGENTS.md).
- Neon PostgreSQL (`@neondatabase/serverless`, neon-http driver)
- Drizzle ORM + drizzle-kit
- DB client: `src/db/index.ts`; schema: `src/db/schema.ts`; config: `drizzle.config.ts`

## Build Order

App flow: `signup/login → profile onboarding → dashboard → AI chat`.

1. **Data foundation (schema only):** `user_profiles`, `ai_recommendations`, `documents`, `memory`, `consulting_agencies` (`users` is done).
2. **Profile onboarding (thin):** step-by-step profile form → `POST /api/profile` → write one `user_profiles` row per user (enforced by the unique constraint on `user_id`). Keep it minimal — a few sequential steps collecting the `user_profiles` fields (user_type, education, current_role, skills, interests, career_goal, location), nothing more. Use only the generic concept of step-by-step profile collection; do not copy any specific product's onboarding.
3. **Core vertical slice (chat):** chat API route (input → LLM answer) → minimal `/chat` UI → **inject the user's `user_profiles` row into the prompt for personalization** → add intent extraction → add guardrails → log every answer to `ai_recommendations`.
4. **Context engineering:** RAG from `documents`; memory read/write.
5. **Tools & agents:** agency search tool (DB-only), resume upload + parse, multi-agent structure (Profile / Career Data / Recommendation / Verification), reflection.
6. **Evaluation:** custom evaluator first (RAGAS/DeepEval later); store scores on `ai_recommendations`.

Profile onboarding comes before AI chat: the chat slice reads the user's `user_profiles` row and injects it as context so advice is personalized. Build the thinnest working slice of each phase first before layering intent, guardrails, RAG, and agents. Do not build the whole project at once.

## Database Rules
- Every schema change goes in `src/db/schema.ts`, then `npx drizzle-kit generate` and `npx drizzle-kit migrate`. Never hand-edit generated SQL in `drizzle/`.
- UUID primary keys with `defaultRandom()`; `created_at`/`updated_at` timestamps `notNull().defaultNow()`.
- Use pgEnum for fixed value sets.
- `user_role` enum is `["user", "admin", "agency_owner"]` only. Student/fresher/employee/job-switcher are **profile types** (stored in `user_profiles` later), NOT roles.

## Coding Rules
- Make only the changes requested; do not modify unrelated files.
- Match existing conventions and file structure.
- Keep changes incremental and phase-by-phase; confirm before large multi-file work.
- Email/password authentication (signup/signin) is approved (2026-07-03) — build it per the approved auth plan. Other auth methods (OAuth, SSO, etc.) still require explicit request.

## Initial Modules / Pages
- **Career Chat** (`/chat`) — core feature.
- **Profile form** (`/profile`) — education, current role, skills, interests, career goal, location.
- **Resume/profile upload** — file or pasted text → stored as a document.
- **Backend AI pipeline** — API routes (the engine, not a page).
- **Agency search** — internal DB-only tool.

## Initial Database Tables
- `users` ✅ (id, name, email, role, created_at)
- `user_profiles` — user_id, education, current_role, skills, interests, career_goal, location
- `documents` — id, user_id, type (`resume | career_data | blog_post | industry_article | agency_record`), content, source_url, created_at
- `memory` — user_id, memory_key, memory_value, updated_at
- `consulting_agencies` — id, name, location, services, website, verification_status, source_url, last_verified
- `ai_recommendations` — id, user_id, query, intent, final_answer, sources_used, evaluation_score, created_at

## Do NOT Build Yet
- No landing page first — build profile onboarding before the chat + AI pipeline (`signup/login → profile onboarding → dashboard → AI chat`).
- No `user_profiles` table until Phase 1 begins (and no other tables ahead of their phase).
- Do not build the full multi-agent pipeline before the basic chat slice works.

## Future Features (Deferred)
- Consulting company / agency self-registration and dashboards.
- Full RAGAS/DeepEval evaluation harness.
- Advanced Agentic RAG (multi-hop retrieval).
- MCP tool integrations and A2A agent communication beyond the minimal structure.
- Production concerns: commercial platform features, billing, scaling.
