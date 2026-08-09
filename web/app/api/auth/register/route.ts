import { NextResponse } from "next/server";
import { RegistrationError, register } from "@/lib/auth";
import { sendMail, siteUrl } from "@/lib/mail";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { name, email } = (await request.json()) as { name?: string; email?: string };

  try {
    const account = register(name ?? "", email ?? "");

    // Tell the admin there is something to approve. Best effort: a mail
    // failure must not lose the registration, which is already recorded.
    const admin = db()
      .prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL LIMIT 1")
      .get() as { email: string } | undefined;
    if (admin) {
      void sendMail({
        to: admin.email,
        subject: `History Bee Trainer: ${account.name} is waiting for approval`,
        text: [
          `${account.name} <${account.email}> has registered and is waiting for approval.`,
          "",
          `Approve or decline: ${siteUrl()}/admin`,
        ].join("\n"),
      });
    }

    return NextResponse.json({ ok: true, name: account.name });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: error instanceof RegistrationError ? 400 : 500 },
    );
  }
}
