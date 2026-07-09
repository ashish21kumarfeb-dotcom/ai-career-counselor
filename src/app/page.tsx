import Link from "next/link";
import { getSession } from "../lib/auth/session";
import { SignOutButton } from "../components/auth/SignOutButton";
import { SketchRocket } from "../components/decor/SketchRocket";

const features = [
  {
    icon: "🧭",
    title: "Guidance that fits you",
    body: "Advice shaped by your profile, goals, and past conversations — not generic tips.",
  },
  {
    icon: "📚",
    title: "Backed by real sources",
    body: "Recommendations grounded in career data and verified records, never invented.",
  },
  {
    icon: "✨",
    title: "Honest, never hype",
    body: "Clear next steps and skill gaps, with no fake job promises or salary guarantees.",
  },
];

export default async function Home() {
  const session = await getSession();

  return (
    <div className="flex flex-1 flex-col">
      {/* Floating frosted nav */}
      <header className="sticky top-0 z-20 px-4 pt-4 sm:px-6">
        <div className="glass-nav mx-auto flex w-full max-w-6xl items-center justify-between rounded-2xl px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold text-heading">
            <span className="text-xl" aria-hidden>
              🧭
            </span>
            <span className="tracking-tight">Career Counsel</span>
          </Link>
          <nav className="flex items-center gap-1.5 sm:gap-2.5">
            {session ? (
              <>
                <Link
                  href="/dashboard"
                  className="btn-primary inline-flex h-9 items-center justify-center rounded-full px-4 text-sm font-semibold"
                >
                  Dashboard
                </Link>
                <SignOutButton />
              </>
            ) : (
              <>
                <Link
                  href="/signin"
                  className="rounded-full px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:text-heading"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="btn-primary inline-flex h-9 items-center justify-center rounded-full px-4 text-sm font-semibold"
                >
                  Get started
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col">
        <section className="relative isolate mx-auto flex w-full max-w-4xl flex-col items-center px-6 pt-20 pb-20 text-center sm:pt-28">
          <SketchRocket className="[mask-image:radial-gradient(120%_90%_at_50%_46%,transparent_30%,black_66%)]" />
          <span className="glass mb-7 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium text-heading">
            <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_2px_rgba(86,197,150,0.7)]" aria-hidden />
            AI-powered career guidance
          </span>

          <h1 className="max-w-3xl text-4xl font-bold leading-[1.1] tracking-tight text-heading sm:text-6xl">
            Find your next career move,{" "}
            <span className="bg-gradient-to-r from-brand via-mint to-mint-light bg-clip-text text-transparent">
              with a little help from AI.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-8 text-slate-300">
            Personalized, source-backed advice for students, freshers, and professionals
            ready to switch. No hype — just clear, honest next steps.
          </p>

          <div className="mt-9 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
            {session ? (
              <Link
                href="/dashboard"
                className="btn-primary inline-flex h-12 items-center justify-center rounded-full px-8 text-sm font-semibold"
              >
                Go to dashboard
              </Link>
            ) : (
              <>
                <Link
                  href="/signup"
                  className="btn-primary inline-flex h-12 items-center justify-center rounded-full px-8 text-sm font-semibold"
                >
                  Get started free
                </Link>
                <Link
                  href="/signin"
                  className="btn-ghost inline-flex h-12 items-center justify-center rounded-full px-8 text-sm font-semibold"
                >
                  I already have an account
                </Link>
              </>
            )}
          </div>
        </section>

        {/* Feature cards */}
        <section className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-5 px-6 pb-28 sm:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="glass-card glass-card-hover rounded-3xl p-6"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-xl ring-1 ring-brand/15">
                <span aria-hidden>{f.icon}</span>
              </div>
              <h3 className="text-base font-semibold text-heading">{f.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-300">{f.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-white/10 py-8 text-center text-sm text-slate-400">
        Built to prove a complete AI counseling flow — guidance only, not a job or salary guarantee.
      </footer>
    </div>
  );
}
