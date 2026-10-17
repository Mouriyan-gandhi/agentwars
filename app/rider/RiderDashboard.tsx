"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Incident, Order } from "@/lib/types";
import IssueReporter, { RIDER_CATEGORIES } from "@/app/components/IssueReporter";

type Props = {
  displayName: string;
  riderId: string | null;
  initialOrders: Order[];
  initialIncidents: Incident[];
};

export default function RiderDashboard({
  displayName,
  riderId,
  initialOrders,
  initialIncidents,
}: Props) {
  const [orders, setOrders] = useState(initialOrders);
  const [incidents, setIncidents] = useState(initialIncidents);
  const [reportingFor, setReportingFor] = useState<Order | null>(null);
  const [lastSync, setLastSync] = useState<Date>(new Date());
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function tick() {
      try {
        const res = await fetch("/api/rider/dashboard", { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json();
        setOrders(d.orders ?? []);
        setIncidents(d.incidents ?? []);
        setLastSync(new Date());
      } catch {
        /* ignore */
      }
    }
    polling.current = setInterval(tick, 3000);
    return () => {
      if (polling.current) clearInterval(polling.current);
    };
  }, [riderId]);

  const openIncidents = incidents.filter(
    (i) => !["resolved", "escalated", "failed"].includes(i.status),
  );

  return (
    <main className="mx-auto max-w-[1120px] p-6 md:p-10">
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <div className="tag mb-3">Live · updates every 3s</div>
          <h1 className="text-[64px] leading-none uppercase">Hi {displayName.split(" ")[0]}</h1>
          <p className="mt-3 text-body text-obsidian/70">
            {orders.length} assigned {orders.length === 1 ? "order" : "orders"}
            {openIncidents.length > 0
              ? ` · ${openIncidents.length} active incident${openIncidents.length === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        <div className="text-caption text-obsidian/50">
          Synced {lastSync.toLocaleTimeString()}
        </div>
      </div>

      <section className="mb-10">
        <h2 className="mb-5 text-[32px] leading-none uppercase">Your orders</h2>
        {orders.length === 0 ? (
          <div className="card">
            <p className="text-body text-obsidian/70">
              No orders assigned right now. If one gets reassigned to you, it will appear here within a few seconds.
            </p>
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            {orders.map((o) => {
              const openIncident = openIncidents.find((i) => i.order_id === o.id);
              return (
                <div key={o.id} className="card-sm">
                  <div className="flex items-center justify-between">
                    <div className="tag">{o.status.replace("_", " ")}</div>
                    {openIncident && (
                      <span className="rounded-full bg-plasma-violet px-3 py-1 text-caption text-chalk">
                        Agent working: {openIncident.status.replace("_", " ")}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 font-mono text-caption text-obsidian/60">{o.order_code}</div>
                  <div className="mt-1 text-subheading font-display uppercase leading-none tracking-[0.02em]">
                    {o.customer_name}
                  </div>
                  <div className="mt-2 text-body-sm text-obsidian/70">{o.address}</div>
                  {o.address_notes && (
                    <div className="mt-1 text-body-sm text-obsidian/60">Notes: {o.address_notes}</div>
                  )}
                  <div className="mt-2 text-caption text-obsidian/60">
                    {o.customer_phone} · deadline {o.deadline ? new Date(o.deadline).toLocaleString() : "—"}
                  </div>

                  <div className="mt-5 flex items-center gap-3">
                    {openIncident ? (
                      <Link
                        href={`/rider/incidents/${openIncident.id}`}
                        className="btn-secondary text-sm"
                      >
                        See agent progress →
                      </Link>
                    ) : (
                      <button
                        onClick={() => setReportingFor(o)}
                        className="btn-primary text-sm"
                      >
                        Report issue →
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-5 text-[32px] leading-none uppercase">Recent incidents</h2>
        {incidents.length === 0 ? (
          <div className="card-sm text-body-sm text-obsidian/60">You haven't filed anything yet.</div>
        ) : (
          <div className="space-y-3">
            {incidents.map((i) => (
              <Link
                key={i.id}
                href={`/rider/incidents/${i.id}`}
                className="card-sm block hover:bg-obsidian/5"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-caption text-obsidian/60">
                      {new Date(i.created_at).toLocaleString()}
                    </div>
                    <div className="mt-1 text-body font-medium">{i.description ?? i.raw_input ?? "—"}</div>
                  </div>
                  <StatusPill status={i.status} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {reportingFor && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-obsidian/60 p-6"
          onClick={() => setReportingFor(null)}
        >
          <div className="my-10 w-full max-w-[720px]" onClick={(e) => e.stopPropagation()}>
            <IssueReporter
              title={`Report issue · ${reportingFor.order_code}`}
              subtitle={`${reportingFor.customer_name} — ${reportingFor.address}`}
              categories={RIDER_CATEGORIES}
              source="rider_report"
              orderCode={reportingFor.order_code}
              onCancel={() => setReportingFor(null)}
              onFiled={(incidentId) => {
                setReportingFor(null);
                location.href = `/rider/incidents/${incidentId}`;
              }}
            />
          </div>
        </div>
      )}
    </main>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    received: "bg-obsidian/10 text-obsidian",
    analyzing: "bg-plasma-violet text-chalk",
    awaiting_customer: "bg-sulfur text-obsidian",
    response_received: "bg-plasma-violet text-chalk",
    ready_for_recovery: "bg-plasma-violet text-chalk",
    recovery_pending: "bg-plasma-violet text-chalk",
    resolved: "bg-ember text-chalk",
    escalated: "bg-obsidian text-chalk",
    failed: "bg-obsidian text-chalk",
  };
  const cls = map[status] ?? "bg-obsidian/10 text-obsidian";
  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-caption font-medium ${cls}`}>
      {status.replace("_", " ")}
    </span>
  );
}

