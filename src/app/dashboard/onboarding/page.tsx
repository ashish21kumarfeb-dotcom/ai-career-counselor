import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "../../../lib/auth/session";
import { getProfileByUserId } from "../../../lib/profile/queries";
import { OnboardingForm } from "../../../components/onboarding/OnboardingForm";

// Middleware already guards /dashboard/* for auth. Here we additionally send the
// user straight to the dashboard if they have already completed their profile,
// so onboarding is shown only once.
export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) {
    redirect("/signin");
  }

  const existing = await getProfileByUserId(session.userId);
  if (existing) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
      <div className="glass w-full max-w-5xl overflow-hidden rounded-[28px] md:grid md:grid-cols-2">
        {/* Brand panel (desktop) */}
        <aside className="relative hidden overflow-hidden p-10 md:flex md:flex-col md:justify-between">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand-strong via-brand to-mint"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 h-72 w-72 rounded-full bg-mint-light/40 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-24 -left-12 h-72 w-72 rounded-full bg-mint-pale/40 blur-3xl"
          />

          <Link
            href="/"
            className="relative flex items-center gap-2 font-semibold text-white"
          >
            <span className="text-xl" aria-hidden>
              🧭
            </span>
            <span className="tracking-tight">Career Counsel</span>
          </Link>

          <div className="relative">
            <h2 className="max-w-sm text-3xl font-bold leading-tight text-white">
              Let&apos;s get to know you.
            </h2>
            <p className="mt-4 max-w-sm leading-7 text-white/85">
              A few quick questions so your guidance is personalized from the very
              first conversation.
            </p>
          </div>

          <p className="relative text-xs text-white/70">
            AI Career Counsellor · MVP
          </p>
        </aside>

        {/* Form side */}
        <main className="flex items-center justify-center p-8 sm:p-10">
          <div className="w-full max-w-md">
            <Link
              href="/"
              className="mb-8 flex items-center gap-2 font-semibold text-heading md:hidden"
            >
              <span className="text-xl" aria-hidden>
                🧭
              </span>
              <span className="tracking-tight">Career Counsel</span>
            </Link>

            <h1 className="text-2xl font-bold tracking-tight text-heading">
              Set up your profile
            </h1>
            <p className="mt-1.5 mb-6 text-sm text-slate-400">
              Takes less than a minute. You can refine it anytime later.
            </p>

            <OnboardingForm />
          </div>
        </main>
      </div>
    </div>
  );
}
