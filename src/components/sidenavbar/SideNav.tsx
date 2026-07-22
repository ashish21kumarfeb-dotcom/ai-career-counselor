"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "../auth/SignOutButton";

// Slim left navigation rail for the career workspace. Icon-only on small screens,
// icon + label from lg. Active item is derived from the current path.
//
// From lg the rail is collapsible: a toggle at the top shrinks it to an
// icon-only rail (labels hidden, tooltips on hover) and the collapsed state is
// persisted in localStorage so it survives a refresh. Below lg the rail is
// already an icon-only drawer-style rail, so the toggle is hidden and the
// existing responsive behavior is untouched.
type NavItem = { href: string; icon: string; label: string; soon?: boolean };

const ITEMS: NavItem[] = [
  { href: "/chat", icon: "💬", label: "Career Chat" },
  { href: "/dashboard", icon: "📊", label: "Dashboard" },
  { href: "/dashboard/onboarding", icon: "🧑‍💼", label: "Profile" },
  { href: "/resume", icon: "📄", label: "Resume" },
];

const STORAGE_KEY = "sidenav:collapsed";

export function SideNav({ email }: { email: string }) {
  const pathname = usePathname();

  // Start expanded to match server render, then restore the persisted choice on
  // mount. Restoring in an effect (not the initializer) keeps SSR/first paint
  // consistent and avoids a hydration mismatch; the width transition makes the
  // one-time restore read as a deliberate animation rather than a flash.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // Private mode / storage disabled: fall back to expanded.
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Ignore persistence failures; state still updates for this session.
      }
      return next;
    });
  }

  // Label visibility: from lg, labels show only when expanded. Collapsed keeps
  // them hidden at every width. Below lg, labels are always hidden (icon rail).
  const labelCls = collapsed ? "hidden" : "hidden lg:inline";
  const labelFlexCls = collapsed ? "hidden" : "hidden lg:flex";

  return (
    <aside
      className={`glass-nav sticky top-0 z-20 flex h-dvh w-16 shrink-0 flex-col rounded-none border-y-0 border-l-0 border-r border-slate-900/10 px-2 py-4 transition-[width] duration-200 ease-in-out ${
        collapsed ? "lg:w-16 lg:px-2" : "lg:w-60 lg:px-4"
      }`}
    >
      {/* Toggle (lg+ only — the mobile rail is already icon-only) */}
      <div className={`mb-3 hidden lg:flex ${collapsed ? "justify-center" : "justify-end"}`}>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-slate-900/5 hover:text-heading"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden
          >
            {collapsed ? (
              // Chevron right — expand
              <path d="m9 6 6 6-6 6" />
            ) : (
              // Chevron left — collapse
              <path d="m15 6-6 6 6 6" />
            )}
          </svg>
        </button>
      </div>

      {/* Brand */}
      <Link
        href="/"
        title={collapsed ? "Career Counsel" : undefined}
        className={`mb-6 flex items-center gap-2 px-1.5 font-semibold text-heading ${collapsed ? "lg:justify-center lg:px-0" : "lg:px-1"}`}
      >
        <span className="text-xl" aria-hidden>🧭</span>
        <span className={`tracking-tight ${labelCls}`}>Career Counsel</span>
      </Link>

      {/* Nav items */}
      <nav className="flex flex-1 flex-col gap-1">
        {ITEMS.map((item) => {
          const active = item.href === pathname;
          const base = `group flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-sm font-semibold transition-colors ${
            collapsed ? "lg:justify-center lg:px-2.5" : "lg:px-3"
          }`;
          if (item.soon) {
            return (
              <span
                key={item.label}
                title={collapsed ? `${item.label} — Coming soon` : "Coming soon"}
                className={`${base} cursor-default text-slate-500`}
              >
                <span className="text-lg" aria-hidden>{item.icon}</span>
                <span className={`items-center gap-2 ${labelFlexCls}`}>
                  {item.label}
                  <span className="rounded-full border border-slate-900/12 bg-slate-900/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
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
              title={collapsed ? item.label : undefined}
              className={`${base} ${
                active
                  ? "bg-brand/15 text-heading ring-1 ring-brand/25"
                  : "text-slate-300 hover:bg-slate-900/5 hover:text-heading"
              }`}
            >
              <span className="text-lg" aria-hidden>{item.icon}</span>
              <span className={labelCls}>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* User + sign out */}
      <div className="mt-4 border-t border-slate-900/10 pt-4">
        <div className={`flex items-center gap-2 px-1 ${collapsed ? "lg:justify-center lg:px-0" : "lg:gap-3"}`}>
          <span
            title={collapsed ? email : undefined}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/20 text-sm font-semibold text-mint-light ring-1 ring-brand/25"
          >
            {email.charAt(0).toUpperCase()}
          </span>
          <span className={`min-w-0 flex-col ${labelFlexCls}`}>
            <span className="truncate text-xs text-slate-300" title={email}>{email}</span>
          </span>
        </div>
        <div className={`mt-2 ${collapsed ? "hidden" : "hidden lg:block"}`}>
          <SignOutButton />
        </div>
      </div>
    </aside>
  );
}
