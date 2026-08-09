import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";

/**
 * Outgoing email.
 *
 * SMTP is used when it is configured. When it is not, the message is written
 * to `data/outbox/` and the caller is told so — approving an account still
 * works, the admin just hands the link over themselves. Silently dropping the
 * mail would leave a new member locked out with nothing to show why.
 */

export const OUTBOX_DIR = process.env.BEE_OUTBOX_DIR ?? path.join(DATA_DIR, "outbox");

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type MailOutcome =
  | { delivered: true; via: "smtp" }
  | { delivered: false; via: "outbox"; file: string; reason: string };

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function writeToOutbox(message: MailMessage, reason: string): MailOutcome {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTo = message.to.replace(/[^a-zA-Z0-9._@-]/g, "_");
  const file = path.join(OUTBOX_DIR, `${stamp}-${safeTo}.txt`);
  fs.writeFileSync(
    file,
    `To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`,
    "utf8",
  );
  return { delivered: false, via: "outbox", file: path.basename(file), reason };
}

export async function sendMail(message: MailMessage): Promise<MailOutcome> {
  if (!smtpConfigured()) {
    return writeToOutbox(
      message,
      "SMTP is not configured (set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM).",
    );
  }

  try {
    // Imported lazily so an install that never sends mail does not pay for it.
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(process.env.SMTP_PORT ?? 587);
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return { delivered: true, via: "smtp" };
  } catch (error) {
    // Keep the message rather than losing it to a transient SMTP failure.
    return writeToOutbox(message, `SMTP send failed: ${String(error)}`);
  }
}

/** Absolute base URL for links in email. */
export function siteUrl(): string {
  return (process.env.BEE_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function invitationEmail(name: string, token: string): MailMessage {
  const link = `${siteUrl()}/set-password/${token}`;
  return {
    to: "",
    subject: "Your History Bee Trainer account is ready",
    text: [
      `Hi ${name},`,
      "",
      "Your account has been approved. Choose a password using the link below,",
      "then sign in with your email address.",
      "",
      link,
      "",
      "The link works once and expires in 48 hours. If it has expired, ask the",
      "admin to send a new one.",
      "",
      "If you did not request an account, ignore this message.",
    ].join("\n"),
  };
}
