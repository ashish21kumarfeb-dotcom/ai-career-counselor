import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "../../lib/auth/session";
import { getProfileByUserId } from "../../lib/profile/queries";
import { SignOutButton } from "../../components/auth/SignOutButton";
import { SketchRocket } from "../../components/decor/SketchRocket";
import { USER_TYPE_LABELS, detailEntries } from "../../lib/profile/fields";

// Quick-action cards. Cards with an `href` link to a live feature; the rest are
// flagged "coming soon" until their phase is built.
type Action = {
  icon: string;
  title: string;
  body: string;
  href?: string;
  soon?: boolean;
};

const actions: Action[] = [
  {
    icon: "💬",
    title: "Career Chat",
    body: "A multi-step agent that plans your answer — suggestions, roadmaps, courses, and verified agencies, only when your question needs them.",
    href: "/chat",
  },
  {
    icon: "📄",
    title: "Resume & documents",
    body: "Upload your resume (PDF, DOCX, or TXT) to personalize your recommendations.",
    href: "/resume",
  },
  {
    icon: "🏢",
    title: "Agency search",
    body: "Explore verified consulting agencies pulled straight from our records.",
    soon: true,
  },
];

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) {
    redirect("/signin");
  }

  // Gate the dashboard behind profile onboarding: a user with no profile row is
  // sent to complete it first.
  const profile = await getProfileByUserId(session.userId);
  if (!profile) {
    redirect("/dashboard/onboarding");
  }

  // For a parent/guardian the common columns describe their CHILD, so relabel
  // them (see the child-framing note in lib/profile/fields.ts).
  const isParent = profile.userType === "parent_guardian";
  const profileFields = [
    { label: "Stage", value: USER_TYPE_LABELS[profile.userType] ?? profile.userType },
    { label: isParent ? "Child's education" : "Education", value: profile.education },
    { label: "Current role", value: profile.currentRole },
    { label: "Years of experience", value: profile.yearsExperience != null ? String(profile.yearsExperience) : null },
    { label: "Location", value: profile.location },
    { label: "Skills", value: profile.skills },
    { label: isParent ? "Child's interests" : "Interests", value: profile.interests },
    { label: isParent ? "Your concern" : "Career goal", value: profile.careerGoal },
    // Type-specific answers stored in the `details` jsonb column.
    ...detailEntries(profile.userType, profile.details as Record<string, unknown> | null),
  ].filter((f) => f.value && String(f.value).trim().length > 0);

  return (
    <div className="flex flex-1 flex-col">
      {/* Frosted top nav */}
      <header className="sticky top-0 z-20 px-4 pt-4 sm:px-6">
        <div className="glass-nav mx-auto flex w-full max-w-6xl items-center justify-between rounded-2xl px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold text-heading">
            <span className="text-xl" aria-hidden>
              🧭
            </span>
            <span className="tracking-tight">Career Counsel</span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-300 sm:inline">{session.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="relative isolate mx-auto w-full max-w-6xl flex-1 px-6 pt-10 pb-20">
        <SketchRocket className="[mask-image:linear-gradient(to_bottom,black_35%,transparent_75%)]" />
        {/* Welcome */}
        <section className="mb-8">
          <span className="glass mb-4 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold text-heading">
            <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_2px_rgba(86,197,150,0.7)]" aria-hidden />
            Dashboard
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-heading sm:text-4xl">
            Welcome back 👋
          </h1>
          <p className="mt-2 max-w-xl text-slate-300">
            Your profile is set up. Here&apos;s where your career guidance will live.
          </p>
        </section>

        {/* Action cards */}
        <section className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          {actions.map((a) => {
            const inner = (
              <>
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/10 text-xl ring-1 ring-brand/15">
                    <span aria-hidden>{a.icon}</span>
                  </div>
                  {a.soon ? (
                    <span className="rounded-full border border-slate-900/12 bg-slate-900/[0.03] px-2.5 py-1 text-[11px] font-semibold text-slate-300">
                      Coming soon
                    </span>
                  ) : a.href ? (
                    <span className="text-slate-400" aria-hidden>
                      →
                    </span>
                  ) : null}
                </div>
                <h3 className="text-base font-semibold text-heading">{a.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-300">{a.body}</p>
              </>
            );

            return a.href ? (
              <Link
                key={a.title}
                href={a.href}
                className="glass-card glass-card-hover block rounded-3xl p-6"
              >
                {inner}
              </Link>
            ) : (
              <div key={a.title} className="glass-card glass-card-hover rounded-3xl p-6">
                {inner}
              </div>
            );
          })}
        </section>

        {/* Profile summary */}
        <section className="mt-6">
          <div className="glass-card rounded-3xl p-6 sm:p-8">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-heading">Your profile</h2>
                <p className="mt-1 text-sm text-slate-400">
                  This is what personalizes your guidance.
                </p>
              </div>
              <Link
                href="/dashboard/profile"
                className="btn-ghost inline-flex h-9 shrink-0 items-center justify-center rounded-full px-4 text-sm font-medium"
              >
                Edit
              </Link>
            </div>

            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {profileFields.map((f) => (
                <div
                  key={f.label}
                  className="rounded-2xl border border-slate-900/10 bg-slate-900/[0.03] p-5"
                >
                  <dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    {f.label}
                  </dt>
                  <dd className="mt-1 text-sm text-slate-100">{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>
    </div>
  );
}
