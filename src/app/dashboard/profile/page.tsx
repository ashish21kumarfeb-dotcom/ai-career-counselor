import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "../../../lib/auth/session";
import { getProfileByUserId } from "../../../lib/profile/queries";
import { unmapProfileToAnswers } from "../../../lib/profile/fields";
import { OnboardingForm } from "../../../components/onboarding/OnboardingForm";

// Profile edit. Reuses the onboarding wizard in "edit" mode, prefilled from the
// user's existing profile. A user with no profile yet is sent to onboarding
// (the first-run flow); the /api/profile upsert handles both create and update.
export default async function EditProfilePage() {
  const session = await getSession();
  if (!session) {
    redirect("/signin");
  }

  const profile = await getProfileByUserId(session.userId);
  if (!profile) {
    redirect("/dashboard/onboarding");
  }

  const { userType, answers } = unmapProfileToAnswers(profile);

  return (
    <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
      <div className="glass w-full max-w-lg rounded-[28px] p-8 sm:p-10">
        <Link
          href="/dashboard"
          className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-slate-400 hover:text-heading"
        >
          <span aria-hidden>←</span> Back to dashboard
        </Link>

        <h1 className="text-2xl font-bold tracking-tight text-heading">
          Update your profile
        </h1>
        <p className="mt-1.5 mb-6 text-sm text-slate-400">
          Change anything below — your guidance updates to match.
        </p>

        <OnboardingForm
          mode="edit"
          initialUserType={userType}
          initialAnswers={answers}
        />
      </div>
    </div>
  );
}
