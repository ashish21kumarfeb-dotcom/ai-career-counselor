import { redirect } from "next/navigation";
import { getSession } from "../../lib/auth/session";
import { getProfileByUserId } from "../../lib/profile/queries";
import { SideNav } from "../../components/sidenavbar/SideNav";
import { ResumeUploader } from "../../components/resume/ResumeUploader";

// Resume & documents page. Upload a resume (PDF/DOCX/TXT) — it is parsed, stored
// as a user-owned document (available only to this user's RAG grounding), and
// used to personalize career guidance. Gated on auth + profile like the rest of
// the workspace.
export default async function ResumePage() {
  const session = await getSession();
  if (!session) {
    redirect("/signin");
  }
  const profile = await getProfileByUserId(session.userId);
  if (!profile) {
    redirect("/dashboard/onboarding");
  }

  return (
    <div className="flex min-h-dvh flex-1">
      <SideNav email={session.email} />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-6 pb-6 sm:px-6">
          <section className="mb-5">
            <span className="glass mb-3 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold text-heading">
              <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_2px_rgba(86,197,150,0.7)]" aria-hidden />
              Resume &amp; documents
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-heading sm:text-3xl">Add your resume</h1>
            <p className="mt-2 max-w-xl text-slate-300">
              Upload your resume and your career guidance will draw on your real experience and skills. It stays private to your account.
            </p>
          </section>

          <ResumeUploader />
        </main>
      </div>
    </div>
  );
}
