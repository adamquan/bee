import type { Metadata } from "next";
import Link from "next/link";
import AccountMenu from "@/components/AccountMenu";
import { db } from "@/lib/db";
import { currentAccount } from "@/lib/users";
import "./globals.css";

export const metadata: Metadata = {
  title: "History Bee Trainer",
  description: "Buzzer and multiple-choice practice for History Bee, History Bowl, and history exams.",
};

const NAV = [
  { href: "/", label: "Practice" },
  { href: "/dashboard", label: "Dashboard" },
  // Admin-only, so it is filtered out below rather than offered and refused.
  { href: "/library", label: "Library", adminOnly: true },
];

// The header names the current profile, which comes from a cookie, so the
// layout cannot be statically rendered.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Null on the sign-in, register, and set-password pages — the only ones the
  // middleware lets through unauthenticated.
  const account = await currentAccount();
  const pending =
    account?.role === "admin"
      ? (db().prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").get() as {
          n: number;
        }).n
      : 0;

  return (
    <html lang="en">
      <body>
        <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-5">
          <header className="flex items-center justify-between py-6">
            <Link href="/" className="group flex items-center gap-2.5">
              <span
                aria-hidden
                className="grid h-9 w-9 place-items-center rounded-xl bg-honey-400 text-lg text-ink-950"
              >
                🐝
              </span>
              <span className="font-display text-lg tracking-tight">
                History Bee <span className="text-honey-400">Trainer</span>
              </span>
            </Link>
            {account && (
              <nav className="flex items-center gap-1">
                {NAV.filter((item) => !item.adminOnly || account.role === "admin").map((item) => (
                  <Link key={item.href} href={item.href} className="btn-quiet">
                    {item.label}
                  </Link>
                ))}
                <span className="ml-1.5">
                  <AccountMenu
                    name={account.name}
                    email={account.email}
                    role={account.role}
                    pendingCount={pending}
                  />
                </span>
              </nav>
            )}
          </header>

          <main className="flex-1 pb-16">{children}</main>

          <footer className="border-t border-ink-800 py-6 text-xs text-ink-400">
            Practice tool for personal study. Official questions remain the property of their
            publishers.
          </footer>
        </div>
      </body>
    </html>
  );
}
