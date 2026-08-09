import { NextResponse } from "next/server";
import { approve, createSetPasswordToken, listAccounts, reject } from "@/lib/auth";
import { invitationEmail, sendMail } from "@/lib/mail";
import { requireAdmin } from "@/lib/users";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Admins only." }, { status: 403 });
  }
  return NextResponse.json({ accounts: listAccounts() });
}

/**
 * Approve, decline, or re-issue an invite.
 *
 * Approving mints a single-use link and emails it. The link comes back in the
 * response too, because without SMTP configured the email lands in
 * `data/outbox/` and the admin has to pass it on by hand.
 */
export async function POST(request: Request) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Admins only." }, { status: 403 });
  }

  const { id, action } = (await request.json()) as {
    id?: number;
    action?: "approve" | "reject" | "resend";
  };
  if (!id || !action) return NextResponse.json({ error: "Missing id or action." }, { status: 400 });

  if (action === "reject") {
    if (id === admin.id) {
      return NextResponse.json({ error: "You cannot decline your own account." }, { status: 400 });
    }
    reject(id);
    return NextResponse.json({ ok: true });
  }

  const { account, token } =
    action === "approve"
      ? approve(id)
      : { account: listAccounts().find((a) => a.id === id)!, token: createSetPasswordToken(id) };

  if (!account) return NextResponse.json({ error: "No such account." }, { status: 404 });

  const message = invitationEmail(account.name, token);
  const outcome = await sendMail({ ...message, to: account.email ?? "" });

  return NextResponse.json({
    ok: true,
    account,
    // Shown to the admin so approval works before SMTP is set up.
    link: `/set-password/${token}`,
    mail: outcome,
  });
}
