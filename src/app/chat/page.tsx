import { redirect } from "next/navigation";
import { getSession } from "../../lib/auth/session";
import { getProfileByUserId } from "../../lib/profile/queries";
import { SideNav } from "../../components/shell/SideNav";
import { CareerWorkspace } from "../../components/chat/CareerWorkspace";

// Career Chat — the single chat surface, in a split "career workspace" shell.
// Starts as a simple chat and expands into chat + a dynamic Career Navigator
// panel once the agent returns a structured response. Consumes /api/agent-chat
// (the LangGraph workflow). Gated on auth + profile like the dashboard.
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
    <div className="flex min-h-dvh flex-1">
      <SideNav email={session.email} />
      <div className="flex min-w-0 flex-1 flex-col">
        <CareerWorkspace />
      </div>
    </div>
  );
}
