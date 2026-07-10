"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "../auth/SignOutButton";

// Slim left navigation rail for the career workspace. Icon-only on small screens,
// icon + label from lg. Active item is derived from the current path.
type NavItem = { href: string; icon: string; label: string; soon?: boolean };

const ITEMS: NavItem[] = [
  { href: "/chat", icon: "💬", label: "Career Chat" },
  { href: "/dashboard", icon: "📊", label: "Dashboard" },
  { href: "/dashboard/onboarding", icon: "🧑‍💼", label: "Profile" },
  { href: "#", icon: "📄", label: "Resume", soon: true },
];

export function SideNav({ email }: { email: string }) {
  const pathname = usePathname();

  return (
    <aside className="glass-nav sticky top-0 z-20 flex h-dvh w-16 shrink-0 flex-col rounded-none border-y-0 border-l-0 border-r border-white/10 px-2 py-4 lg:w-60 lg:px-4">
      {/* Brand */}
      <Link href="/dashboard" className="mb-6 flex items-center gap-2 px-1.5 font-semibold text-heading lg:px-1">
        <span className="text-xl" aria-hidden>🧭</span>
        <span className="hidden tracking-tight lg:inline">Career Counsel</span>
      </Link>

      {/* Nav items */}
      <nav className="flex flex-1 flex-col gap-1">
        {ITEMS.map((item) => {
          const active = item.href === pathname;
          const base =
            "group flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-sm font-medium transition-colors lg:px-3";
          if (item.soon) {
            return (
              <span
                key={item.label}
                title="Coming soon"
                className={`${base} cursor-default text-slate-500`}
              >
                <span className="text-lg" aria-hidden>{item.icon}</span>
                <span className="hidden items-center gap-2 lg:flex">
                  {item.label}
                  <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                    soon
                  </span>
                </span>
              </span>
            );
          }
          return (
            <Link
              key={item.label}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`${base} ${
                active
                  ? "bg-brand/15 text-heading ring-1 ring-brand/25"
                  : "text-slate-300 hover:bg-white/5 hover:text-heading"
              }`}
            >
              <span className="text-lg" aria-hidden>{item.icon}</span>
              <span className="hidden lg:inline">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* User + sign out */}
      <div className="mt-4 border-t border-white/10 pt-4">
        <div className="flex items-center gap-2 px-1 lg:gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/20 text-sm font-semibold text-mint-light ring-1 ring-brand/25">
            {email.charAt(0).toUpperCase()}
          </span>
          <span className="hidden min-w-0 flex-col lg:flex">
            <span className="truncate text-xs text-slate-300" title={email}>{email}</span>
          </span>
        </div>
        <div className="mt-2 hidden lg:block">
          <SignOutButton />
        </div>
      </div>
    </aside>
  );
}
