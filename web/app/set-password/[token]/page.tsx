import Link from "next/link";
import { AuthCard, SetPasswordForm } from "@/components/AuthForm";
import { accountById, checkSetPasswordToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const check = checkSetPasswordToken(token);

  if (!check.ok || !check.userId) {
    return (
      <AuthCard title="This link doesn't work">
        <p className="text-sm text-ink-300">{check.reason}</p>
        <Link href="/login" className="btn-ghost mt-5 inline-flex">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  const account = accountById(check.userId)!;
  return (
    <AuthCard title="Choose a password">
      <SetPasswordForm token={token} name={account.name} />
    </AuthCard>
  );
}
