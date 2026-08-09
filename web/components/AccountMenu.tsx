"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/** Who is signed in, with the way out. */
export default function AccountMenu({
  name,
  email,
  role,
  pendingCount,
}: {
  name: string;
  email: string | null;
  role: "admin" | "member";
  pendingCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    // Full navigation, so nothing rendered for the old account survives.
    window.location.assign("/login");
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="btn-ghost gap-2"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden
          className="grid h-6 w-6 place-items-center rounded-full bg-honey-400/20 text-xs font-semibold text-honey-300"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="max-w-[10rem] truncate">{name}</span>
        {role === "admin" && pendingCount > 0 && (
          <span className="rounded-full bg-honey-400 px-1.5 text-xs font-semibold text-ink-950">
            {pendingCount}
          </span>
        )}
        <span aria-hidden className="text-ink-400">
          ▾
        </span>
      </button>

      {open && (
        <div role="menu" className="card absolute right-0 z-20 mt-2 w-64 p-1.5 shadow-xl">
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium">{name}</p>
            {email && <p className="truncate text-xs text-ink-400">{email}</p>}
            <p className="mt-1 text-xs uppercase tracking-wider text-ink-500">{role}</p>
          </div>

          <div className="my-1 border-t border-ink-800" />

          {role === "admin" && (
            <Link
              href="/admin"
              role="menuitem"
              className="flex items-center justify-between rounded-lg px-2.5 py-2 text-sm hover:bg-ink-800"
              onClick={() => setOpen(false)}
            >
              Manage accounts
              {pendingCount > 0 && (
                <span className="rounded-full bg-honey-400 px-1.5 text-xs font-semibold text-ink-950">
                  {pendingCount}
                </span>
              )}
            </Link>
          )}

          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={signOut}
            className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-50"
          >
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
