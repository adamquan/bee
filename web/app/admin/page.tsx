import { redirect } from "next/navigation";
import AdminAccounts from "@/components/AdminAccounts";
import { listAccounts } from "@/lib/auth";
import { siteUrl, smtpConfigured } from "@/lib/mail";
import { currentAccount } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const account = await currentAccount();
  if (!account) redirect("/login?next=/admin");
  // Members get sent home rather than shown a 403 they can do nothing about.
  if (account.role !== "admin") redirect("/");

  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-3xl tracking-tight">Accounts</h1>
        <p className="mt-2 max-w-2xl text-ink-300">
          Anyone can request an account. Approving one emails a single-use link through which they
          set their own password — no password is ever chosen for someone else.
        </p>
      </section>
      <AdminAccounts
        accounts={listAccounts()}
        siteUrl={siteUrl()}
        smtpConfigured={smtpConfigured()}
      />
    </div>
  );
}
