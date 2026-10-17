"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ActionLog, Incident, Notification, Order, AgentDecision } from "@/lib/types";

type Payload = {
  incident: Incident;
  order: Order | null;
  action_logs: ActionLog[];
  notifications: Notification[];
  customer_responses: unknown[];
};

const STEP_LABELS: Record<string, string> = {
  received: "Received your report",
  analyzing: "Gemini is reading the report",
  awaiting_customer: "Emailed the customer, waiting for reply",
  response_received: "Customer replied, applying the fix",
  ready_for_recovery: "Preparing the fix",
  recovery_pending: "Applying the fix",
  resolved: "Resolved",
  escalated: "Escalated to ops",
  failed: "Something went wrong",
};

export default function RiderIncidentView({ incidentId }: { incidentId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function fetchIt() {
      try {
        const res = await fetch(`/api/incidents/${incidentId}`, { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to load");
        const d = await res.json();
        if (alive) {
          setData(d);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    }
    fetchIt();
    const t = setInterval(fetchIt, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [incidentId]);

  if (err) {
    return (
      <main className="mx-auto max-w-xl p-6 md:p-10">
        <Link href="/rider" className="btn-ghost text-sm">← Dashboard</Link>
        <div className="card mt-6">
          <h2 className="text-heading uppercase">Error</h2>
          <p className="mt-3 text-body text-obsidian/70">{err}</p>
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="mx-auto max-w-xl p-6 md:p-10">
        <div className="card">
          <p className="text-body text-obsidian/70">Loading…</p>
        </div>
      </main>
    );
  }

  const { incident, order, action_logs, notifications } = data;
  const decision = incident.analysis as AgentDecision | null;
  const terminal = ["resolved", "escalated", "failed"].includes(incident.status);

  return (
    <main className="mx-auto max-w-[920px] p-6 md:p-10">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/rider" className="btn-ghost text-sm">← Dashboard</Link>
        <span className="text-caption text-obsidian/50">Live · updates every 3s</span>
      </div>

      <div className="mb-6">
        <div className="tag mb-3">{order?.order_code ?? "No order"}</div>
        <h1 className="text-[48px] leading-none uppercase">
          {STEP_LABELS[incident.status] ?? incident.status}
        </h1>
      </div>

      {incident.status === "resolved" && (
        <div className="card mb-6 bg-ember text-chalk">
          <h3 className="text-heading uppercase">Resolved</h3>
          <p className="mt-3 text-body">
            The customer gave us the info we needed. Head out to the new address below.
          </p>
          {order && (
            <div className="mt-5 rounded-[24px] bg-chalk p-5 text-obsidian">
              <div className="text-caption uppercase tracking-wide text-obsidian/60">New address</div>
              <div className="mt-1 text-body">{order.address}</div>
              {order.address_notes && (
                <div className="mt-2 text-body-sm text-obsidian/70">Notes: {order.address_notes}</div>
              )}
              <div className="mt-2 text-body-sm text-obsidian/70">
                Phone {order.customer_phone}
              </div>
            </div>
          )}
        </div>
      )}

      {incident.status === "escalated" && order && order.rider_id !== null && (
        <div className="card mb-6 bg-plasma-violet text-chalk">
          <h3 className="text-heading uppercase">Reassigned</h3>
          <p className="mt-3 text-body">
            This order has been reassigned to another rider. It is no longer on your list.
          </p>
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <div className="card">
          <h3 className="mb-3 text-caption uppercase tracking-wide text-obsidian/60">Your report</h3>
          <div className="text-caption uppercase tracking-wide text-obsidian/60">{incident.input_type}</div>
          <div className="mt-2 whitespace-pre-wrap text-body-sm text-obsidian/80">{incident.raw_input ?? "—"}</div>
        </div>

        <div className="card">
          <h3 className="mb-3 text-caption uppercase tracking-wide text-obsidian/60">Agent's take</h3>
          {decision ? (
            <div className="space-y-2 text-body-sm">
              <KV label="Problem" value={decision.incidentType.replace("_", " ")} />
              <KV label="Plan" value={decision.recommendedAction.replace("_", " ")} />
              <KV label="Summary" value={decision.summary} />
            </div>
          ) : (
            <div className="text-body-sm text-obsidian/60">Still analyzing…</div>
          )}
        </div>
      </div>

      <section className="mt-8">
        <h2 className="mb-4 text-[32px] leading-none uppercase">Timeline</h2>
        <ol className="space-y-3">
          {action_logs.map((l) => (
            <li key={l.id} className="card-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="font-mono text-caption text-obsidian/60">
                  {new Date(l.created_at).toLocaleTimeString()}
                </div>
                <LogBadge status={l.status} />
              </div>
              <div className="mt-2 text-body font-medium">{humanAction(l.action)}</div>
              {l.message && <div className="mt-1 text-body-sm text-obsidian/70">{l.message}</div>}
            </li>
          ))}
          {action_logs.length === 0 && (
            <li className="text-body-sm text-obsidian/60">No activity yet.</li>
          )}
        </ol>
      </section>

      {notifications.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 text-[32px] leading-none uppercase">Emails sent</h2>
          <div className="space-y-3">
            {notifications.map((n) => (
              <div key={n.id} className="card-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium">{n.subject}</div>
                  <span
                    className={
                      "rounded-full px-3 py-1 text-caption font-medium " +
                      (n.status === "sent"
                        ? "bg-ember text-chalk"
                        : n.status === "failed"
                        ? "bg-obsidian text-chalk"
                        : "bg-obsidian/10 text-obsidian")
                    }
                  >
                    {n.status}
                  </span>
                </div>
                <div className="mt-1 text-caption text-obsidian/60">to {n.recipient}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!terminal && (
        <p className="mt-10 text-body-sm text-obsidian/60">
          No action needed from you — the agent will keep working. This page refreshes automatically.
        </p>
      )}
    </main>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-caption uppercase tracking-wide text-obsidian/60">{label}</div>
      <div className="mt-1">{value}</div>
    </div>
  );
}

function LogBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    success: "bg-ember text-chalk",
    failed: "bg-obsidian text-chalk",
    retrying: "bg-sulfur text-obsidian",
    started: "bg-obsidian/10 text-obsidian",
  };
  const cls = map[status] ?? "bg-obsidian/10 text-obsidian";
  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-caption font-medium ${cls}`}>
      {status}
    </span>
  );
}

function humanAction(a: string): string {
  const map: Record<string, string> = {
    analyze: "Agent read your report",
    send_email: "Agent emailed the customer",
    customer_response: "Customer replied",
    apply_fix: "Updated the delivery details",
    propose_reassignment: "Reassigned to another rider",
    escalate: "Escalated to ops",
  };
  return map[a] ?? a;
}
