import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "../../lib/auth/session";
import { getProfileByUserId } from "../../lib/profile/queries";
import { SignOutButton } from "../../components/auth/SignOutButton";
import { ChatClient } from "../../components/chat/ChatClient";

export default async function ChatPage() {
  const session = await getSession();
  if (!session) {
    redirect("/signin");
  }

  // Chat is personalized by the user's profile, so gate on it like the dashboard.
  const profile = await getProfileByUserId(session.userId);
  if (!profile) {
    redirect("/dashboard/onboarding");
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Frosted top nav */}
      <header className="sticky top-0 z-20 px-4 pt-4 sm:px-6">
        <div className="glass-nav mx-auto flex w-full max-w-3xl items-center justify-between rounded-2xl px-4 py-3 sm:px-6">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-heading">
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

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 pt-8 pb-6">
        <section className="mb-6">
          <span className="glass mb-4 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium text-heading">
            <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_2px_rgba(86,197,150,0.7)]" aria-hidden />
            Career Chat
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-heading sm:text-3xl">
            Let&apos;s talk about your career
          </h1>
        </section>

        <ChatClient />
      </main>
    </div>
  );
}
