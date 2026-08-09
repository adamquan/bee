import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard, RegisterForm } from "@/components/AuthForm";
import { currentAccount } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await currentAccount()) redirect("/");

  return (
    <AuthCard
      title="Request an account"
      intro="Accounts are approved by hand. Once yours is, you'll get an email with a link to choose a password."
      footer={
        <>
          Already have one?{" "}
          <Link href="/login" className="text-honey-300 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthCard>
  );
}
