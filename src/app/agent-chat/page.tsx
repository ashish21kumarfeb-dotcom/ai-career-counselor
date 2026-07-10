import { redirect } from "next/navigation";

// The agentic chat was consolidated into the single Career Chat at /chat.
// Keep this path as a permanent redirect so old links/bookmarks still work.
export default function AgentChatPage() {
  redirect("/chat");
}
