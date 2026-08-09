import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard, SignInForm } from "@/components/AuthForm";
import { currentAccount } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await currentAccount()) redirect("/");

  const raw = (await searchParams).next;
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  // Only same-site paths, or the `next` parameter becomes an open redirect.
  const next = candidate && /^\/(?!\/)/.test(candidate) ? candidate : "/";

  return (
    <AuthCard
      title="Sign in"
      intro="History Bee Trainer is private. Sign in to see your practice."
      footer={
        <>
          No account yet?{" "}
          <Link href="/register" className="text-honey-300 hover:underline">
            Request one
          </Link>
        </>
      }
    >
      <SignInForm next={next} />
    </AuthCard>
  );
}
