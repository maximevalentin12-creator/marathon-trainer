"use client";

import { usePathname } from "next/navigation";
import SignOutButton from "@/components/SignOutButton";

const TABS = [
  {
    href: "/",
    label: "Aujourd'hui",
    match: (p: string) => p === "/",
    icon: <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  },
  {
    href: "/plan",
    label: "Plan",
    match: (p: string) => p.startsWith("/plan"),
    icon: <path d="M4 5h16M4 12h16M4 19h10" />,
  },
  {
    href: "/carnet",
    label: "Carnet",
    match: (p: string) => p.startsWith("/carnet") || p.startsWith("/historique") || p.startsWith("/log"),
    icon: <path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6zM9 7h6M9 11h6" />,
  },
  {
    href: "/plus",
    label: "Plus",
    match: (p: string) =>
      ["/plus", "/shoes", "/profil", "/trends", "/onboarding"].some((x) => p.startsWith(x)),
    icon: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3} />,
  },
] as const;

/** Bottom tab bar on phones; a plain top navigation on wider screens. */
export default function TabBar() {
  const pathname = usePathname() ?? "/";

  return (
    <>
      <nav
        aria-label="Navigation principale"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="flex">
          {TABS.map((t) => {
            const active = t.match(pathname);
            return (
              <li key={t.href} className="flex-1">
                <a
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex flex-col items-center justify-center gap-0.5 min-h-[56px] text-[11px] ${
                    active ? "text-accent font-semibold" : "text-gray-500"
                  }`}
                >
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    {t.icon}
                  </svg>
                  {t.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <nav aria-label="Navigation principale" className="hidden md:block border-b border-gray-200 bg-white/70">
        <ul className="max-w-3xl mx-auto px-4 flex items-center gap-6 h-12 text-sm">
          <li className="font-semibold tracking-tight mr-2">Marathon Trainer</li>
          {TABS.map((t) => (
            <li key={t.href}>
              <a href={t.href} className={t.match(pathname) ? "text-accent font-semibold" : "text-gray-600 hover:text-gray-900"}>
                {t.label}
              </a>
            </li>
          ))}
          <li className="ml-auto">
            <SignOutButton className="text-gray-500 hover:text-gray-900 disabled:opacity-50" />
          </li>
        </ul>
      </nav>
    </>
  );
}
