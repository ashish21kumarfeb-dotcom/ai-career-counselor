"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Posts to the existing signout route, then refreshes so the server components
// (e.g. the landing page nav) re-render in their logged-out state.
export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    try {
      await fetch("/api/auth/signout", { method: "POST" });
      router.refresh();
    } catch {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={loading}
      className="rounded-full px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:text-heading disabled:opacity-60"
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
