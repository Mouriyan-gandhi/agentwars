"use client";

import Link from "next/link";
import { useState } from "react";
import IssueReporter, { CUSTOMER_CATEGORIES } from "@/app/components/IssueReporter";

type Order = {
  id: string;
  order_code: string;
  customer_name: string;
  address: string;
  status: string;
  deadline: string | null;
  rider_name: string | null;
};

type IncidentSummary = {
  id: string;
  source: string;
  type: string | null;
  status: string;
  description: string | null;
  created_at: string;
  resolved_at: string | null;
};

export default function CustomerLookupPage() {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [reporting, setReporting] = useState(false);
  const [filedId, setFiledId] = useState<string | null>(null);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/customer/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order_code: code.trim(), email: email.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Lookup failed");
      setOrder(json.order);
      setIncidents(json.incidents ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setOrder(null);
      setIncidents([]);
    } finally {
      setBusy(false);
    }
  }

  if (!order) {
    return (
      <main className="mx-auto max-w-[520px] p-6 md:p-10">
        <div className="mb-8">
          <Link href="/" className="btn-ghost text-sm">← Home</Link>
        </div>
        <h1 className="text-[48px] leading-none uppercase">Your delivery</h1>
        <p className="mt-3 text-body text-obsidian/70">
          Look up an order to see its status or file a complaint.
        </p>
        <form onSubmit={lookup} className="card mt-8 space-y-5">
          <div>
            <label className="mb-2 block text-caption uppercase tracking-wide text-obsidian/60">
              Order code
            </label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="PP-1001"
              className="input"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="mb-2 block text-caption uppercase tracking-wide text-obsidian/60">
              Email on the order
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              required
            />
          </div>
          {err && (
            <div className="rounded-[24px] bg-ember/10 p-4 text-body-sm text-ember">{err}</div>
          )}
          <button type="submit" disabled={busy} className="btn-primary disabled:opacity-50">
            {busy ? "Looking up…" : "Look up order →"}
          </button>
        </form>

        <div className="mt-6 rounded-[24px] bg-limestone p-4 text-caption text-obsidian/60">
          <div className="font-mono">
            Demo: PP-1001 · gandhimouriyan1234@gmail.com
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[720px] p-6 md:p-10">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/" className="btn-ghost text-sm">← Home</Link>
        <button
          onClick={() => {
            setOrder(null);
            setIncidents([]);
            setCode("");
            setEmail("");
          }}
          className="btn-ghost text-sm"
        >
          Look up another
        </button>
      </div>

      <div className="mb-6">
        <div className="tag mb-3">{order.status.replace("_", " ")}</div>
        <h1 className="text-[48px] leading-none uppercase">Order {order.order_code}</h1>
      </div>

      <div className="card mb-6">
        <h3 className="mb-3 text-caption uppercase tracking-wide text-obsidian/60">Delivery</h3>
        <div className="space-y-2 text-body-sm">
          <div className="text-body font-medium">{order.customer_name}</div>
          <div className="text-obsidian/80">{order.address}</div>
          {order.deadline && (
            <div className="text-caption text-obsidian/60">
              Expected by {new Date(order.deadline).toLocaleString()}
            </div>
          )}
          {order.rider_name && (
            <div className="text-caption text-obsidian/60">
              Rider: {order.rider_name}
            </div>
          )}
        </div>
      </div>

      {filedId && (
        <div className="card mb-6 bg-ember text-chalk">
          <h3 className="text-heading uppercase">We've got it</h3>
          <p className="mt-3 text-body">
            Your complaint is now with our AI operations agent. It will investigate and get back to you by email.
          </p>
          <div className="mt-2 font-mono text-caption text-chalk/80">
            Reference: {filedId.slice(0, 8)}
          </div>
        </div>
      )}

      {incidents.length > 0 && (
        <div className="card mb-6">
          <h3 className="mb-3 text-caption uppercase tracking-wide text-obsidian/60">
            Past issues on this order
          </h3>
          <div className="space-y-3">
            {incidents.map((i) => (
              <div key={i.id} className="rounded-[16px] bg-pumice p-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{i.type ?? "incident"}</div>
                  <span
                    className={
                      "rounded-full px-3 py-1 text-caption font-medium " +
                      (i.status === "resolved"
                        ? "bg-ember text-chalk"
                        : i.status === "escalated"
                        ? "bg-obsidian text-chalk"
                        : "bg-sulfur text-obsidian")
                    }
                  >
                    {i.status.replace("_", " ")}
                  </span>
                </div>
                {i.description && (
                  <div className="mt-1 text-body-sm text-obsidian/70">{i.description}</div>
                )}
                <div className="mt-1 text-caption text-obsidian/50">
                  {new Date(i.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!reporting ? (
        <button onClick={() => setReporting(true)} className="btn-primary">
          Something's wrong — file a complaint →
        </button>
      ) : (
        <IssueReporter
          title="File a complaint"
          subtitle="Our AI agent will investigate and reply by email."
          categories={CUSTOMER_CATEGORIES}
          source="customer_complaint"
          orderCode={order.order_code}
          customerEmail={email}
          onCancel={() => setReporting(false)}
          onFiled={(id) => {
            setReporting(false);
            setFiledId(id);
          }}
        />
      )}
    </main>
  );
}
