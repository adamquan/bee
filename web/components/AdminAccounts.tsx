"use client";

import { useState } from "react";
import type { Account } from "@/lib/auth";

interface Issued {
  link: string;
  mail: { delivered: boolean; via: string; reason?: string; file?: string };
}

/** Approve, decline, or re-invite. */
export default function AdminAccounts({
  accounts,
  siteUrl,
  smtpConfigured,
}: {
  accounts: Account[];
  siteUrl: string;
  smtpConfigured: boolean;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Record<number, Issued>>({});
  const [confirming, setConfirming] = useState<number | null>(null);

  async function act(id: number, action: "approve" | "reject" | "resend") {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const body = (await response.json()) as { error?: string } & Partial<Issued>;
      if (!response.ok) throw new Error(body.error ?? "That didn't work.");
      if (body.link && body.mail) {
        setIssued((prev) => ({ ...prev, [id]: { link: body.link!, mail: body.mail! } }));
      }
      setConfirming(null);
      // Re-render the server component so statuses and counts are current.
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  }

  const pending = accounts.filter((a) => a.status === "pending");
  const rest = accounts.filter((a) => a.status !== "pending");

  return (
    <div className="space-y-8">
      {!smtpConfigured && (
        <p className="card border-warn-400/40 p-4 text-sm text-ink-300">
          <span className="text-warn-400">Email is not configured.</span> Approving still works —
          the message is written to <code>data/outbox/</code> and the invite link is shown here for
          you to pass on. Set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>,{" "}
          <code>SMTP_USER</code>, <code>SMTP_PASS</code>, <code>SMTP_FROM</code> and{" "}
          <code>BEE_SITE_URL</code> to have it sent.
        </p>
      )}

      <section>
        <h2 className="mb-3 font-display text-xl">
          Waiting for approval{pending.length > 0 && ` (${pending.length})`}
        </h2>
        {pending.length === 0 ? (
          <p className="card p-5 text-sm text-ink-400">Nothing waiting.</p>
        ) : (
          <div className="card divide-y divide-ink-800">
            {pending.map((account) => (
              <div key={account.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{account.name}</p>
                    <p className="truncate text-xs text-ink-400">{account.email}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      className="btn-primary px-4 py-1.5 text-sm"
                      disabled={busy === account.id}
                      onClick={() => act(account.id, "approve")}
                    >
                      Approve
                    </button>
                    {confirming === account.id ? (
                      <>
                        <button
                          type="button"
                          className="btn-primary bg-bad-600 px-3 py-1.5 text-sm text-white hover:bg-bad-400"
                          disabled={busy === account.id}
                          onClick={() => act(account.id, "reject")}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="btn-ghost px-3 py-1.5 text-sm"
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost px-4 py-1.5 text-sm text-bad-400"
                        disabled={busy === account.id}
                        onClick={() => setConfirming(account.id)}
                      >
                        Decline
                      </button>
                    )}
                  </div>
                </div>
                <InviteLink issued={issued[account.id]} siteUrl={siteUrl} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-display text-xl">Accounts</h2>
        <div className="card divide-y divide-ink-800">
          {rest.map((account) => (
            <div key={account.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {account.name}
                    {account.role === "admin" && (
                      <span className="ml-2 chip border-honey-500/60 text-honey-300">admin</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-ink-400">
                    {account.email ?? "no email — cannot sign in"} ·{" "}
                    {account.status === "rejected"
                      ? "declined"
                      : account.hasPassword
                        ? "active"
                        : "awaiting password"}
                  </p>
                </div>
                {account.status === "approved" && !account.hasPassword && account.email && (
                  <button
                    type="button"
                    className="btn-ghost shrink-0 px-3 py-1.5 text-sm"
                    disabled={busy === account.id}
                    onClick={() => act(account.id, "resend")}
                  >
                    Send a new link
                  </button>
                )}
              </div>
              <InviteLink issued={issued[account.id]} siteUrl={siteUrl} />
            </div>
          ))}
        </div>
      </section>

      {error && <p className="text-sm text-bad-400">{error}</p>}
    </div>
  );
}

function InviteLink({ issued, siteUrl }: { issued?: Issued; siteUrl: string }) {
  if (!issued) return null;
  const full = `${siteUrl}${issued.link}`;
  return (
    <div className="mt-3 rounded-lg border border-ink-700 bg-ink-950/40 p-3 text-xs">
      <p className={issued.mail.delivered ? "text-good-400" : "text-warn-400"}>
        {issued.mail.delivered
          ? "Invite emailed."
          : `Not emailed — ${issued.mail.reason} Saved to data/outbox/${issued.mail.file}.`}
      </p>
      <p className="mt-2 text-ink-400">Single-use, expires in 48 hours:</p>
      <code className="mt-1 block break-all text-honey-300">{full}</code>
    </div>
  );
}
