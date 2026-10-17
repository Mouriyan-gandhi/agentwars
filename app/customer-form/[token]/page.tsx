import { hashToken } from "@/lib/token";
import { supabaseAdmin } from "@/lib/supabase";
import CustomerForm from "./CustomerForm";
import type { AgentDecision } from "@/lib/types";

export const dynamic = "force-dynamic";

async function loadContext(token: string) {
  const hash = hashToken(token);
  const { data: row } = await supabaseAdmin()
    .from("customer_responses")
    .select("*, incidents(*, orders(*))")
    .eq("token_hash", hash)
    .maybeSingle();

  if (!row) return { error: "This link is invalid." };
  if (row.used_at) return { error: "This link has already been used." };
  if (new Date(row.expires_at).getTime() < Date.now()) return { error: "This link has expired." };

  const inc = row.incidents as {
    analysis?: AgentDecision | null;
    orders?: { order_code: string; customer_name: string } | null;
  } | null;
  const order = inc?.orders;
  const decision = inc?.analysis ?? null;
  return { token, order, decision };
}

export default async function CustomerFormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const ctx = await loadContext(token);

  if ("error" in ctx) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="h-7 w-7 rounded-full bg-ember" />
          <div className="text-body font-medium">ParcelPilot</div>
        </div>
        <div className="card">
          <h2 className="text-heading uppercase">Link unavailable</h2>
          <p className="mt-3 text-body text-obsidian/70">{ctx.error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="h-7 w-7 rounded-full bg-ember" />
        <div className="text-body font-medium">ParcelPilot</div>
      </div>

      <h1 className="text-[48px] leading-none uppercase">Help us complete your delivery</h1>
      {ctx.order && (
        <p className="mt-3 text-body text-obsidian/70">
          Order <span className="font-mono">{ctx.order.order_code}</span> for{" "}
          <span className="font-medium text-obsidian">{ctx.order.customer_name}</span>
        </p>
      )}

      {ctx.decision?.summary && (
        <div className="mt-6 card-sm bg-sulfur">
          <div className="text-caption uppercase tracking-wide">What happened</div>
          <div className="mt-2 text-body-sm text-obsidian/80">{ctx.decision.summary}</div>
          {ctx.decision.missingInformation?.length ? (
            <ul className="mt-3 ml-5 list-disc text-body-sm text-obsidian/80">
              {ctx.decision.missingInformation.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          ) : null}
        </div>
      )}

      <div className="mt-8">
        <CustomerForm token={ctx.token!} />
      </div>
    </main>
  );
}
