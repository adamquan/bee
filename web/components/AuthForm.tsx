"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";

/**
 * A password box with a reveal toggle.
 *
 * The toggle flips `type` between `password` and `text`. It is a `type="button"`
 * so pressing Enter in the field still submits the form rather than unmasking
 * it, and it carries `aria-pressed` so a screen reader announces the current
 * state — a change of icon alone says nothing.
 *
 * Revealing is per field: on the set-password form you may want to check what
 * you typed without also exposing the confirmation.
 */
function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  minLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
}) {
  const [revealed, setRevealed] = useState(false);
  const hintId = useId();

  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={revealed ? "text" : "password"}
          autoComplete={autoComplete}
          required
          minLength={minLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hintId}
          // Room for the button, so a long password never runs underneath it.
          className="field pr-16"
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-pressed={revealed}
          aria-controls={id}
          className="absolute inset-y-0 right-0 flex items-center rounded-r-xl px-3 text-xs font-medium text-ink-400 hover:text-ink-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-honey-400"
        >
          {revealed ? "Hide" : "Show"}
        </button>
      </div>
      <span id={hintId} className="sr-only">
        {revealed ? "Password is visible." : "Password is hidden."}
      </span>
    </div>
  );
}

/** Shared shell for the three unauthenticated forms. */
export function AuthCard({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto mt-12 w-full max-w-md">
      <div className="card p-7">
        <h1 className="font-display text-2xl tracking-tight">{title}</h1>
        {intro && <div className="mt-2 text-sm text-ink-300">{intro}</div>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <p className="mt-4 text-center text-sm text-ink-400">{footer}</p>}
    </div>
  );
}

export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not sign in.");
      window.location.assign(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="email" className="label">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="field"
        />
      </div>
      <PasswordField
        id="password"
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      {error && <p className="text-sm text-bad-400">{error}</p>}
      <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function RegisterForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not register.");
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-3 text-sm text-ink-300">
        <p className="text-good-400">Thanks — your request has been sent.</p>
        <p>
          The admin has to approve it. Once they do, you&apos;ll get an email with a link to
          choose your password.
        </p>
        <Link href="/login" className="btn-ghost mt-2 inline-flex">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="name" className="label">
          Your name
        </label>
        <input
          id="name"
          required
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="field"
          placeholder="Alex Kim"
        />
      </div>
      <div>
        <label htmlFor="reg-email" className="label">
          Email
        </label>
        <input
          id="reg-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="field"
        />
      </div>
      {error && <p className="text-sm text-bad-400">{error}</p>}
      <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
        {busy ? "Sending…" : "Request an account"}
      </button>
    </form>
  );
}

export function SetPasswordForm({ token, name }: { token: string; name: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = (await response.json()) as { error?: string; signedIn?: boolean };
      if (!response.ok) throw new Error(body.error ?? "Could not set the password.");
      window.location.assign(body.signedIn ? "/" : "/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-ink-300">
        Welcome, {name}. Choose a password — at least 10 characters.
      </p>
      <PasswordField
        id="new-password"
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        minLength={10}
      />
      <PasswordField
        id="confirm-password"
        label="Confirm password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
      {error && <p className="text-sm text-bad-400">{error}</p>}
      <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
        {busy ? "Saving…" : "Set password and sign in"}
      </button>
    </form>
  );
}
