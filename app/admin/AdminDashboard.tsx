"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Incident, Order, Rider } from "@/lib/types";

type Props = {
  initialIncidents: Incident[];
  initialOrders: Order[];
  initialRiders: Rider[];
};

export default function AdminDashboard({
  initialIncidents,
  initialOrders,
  initialRiders,
}: Props) {
  const [incidents, setIncidents] = useState(initialIncidents);
  const [orders, setOrders] = useState(initialOrders);
  const [riders, setRiders] = useState(initialRiders);
  const [lastSync, setLastSync] = useState(new Date());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function tick() {
      try {
        const res = await fetch("/api/admin/dashboard", { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json();
        setIncidents(d.incidents ?? []);
        setOrders(d.orders ?? []);
        setRiders(d.riders ?? []);
        setLastSync(new Date());
      } catch {
        /* ignore */
      }
    }
    timer.current = setInterval(tick, 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const open = incidents.filter((i) => !["resolved", "escalated", "failed"].includes(i.status)).length;
  const awaiting = incidents.filter((i) => i.status === "awaiting_customer").length;
  const recovery = incidents.filter((i) => ["ready_for_recovery", "recovery_pending", "response_received"].includes(i.status)).length;
  const resolved = incidents.filter((i) => i.status === "resolved").length;

  const ridersById = new Map(riders.map((r) => [r.id, r]));

  return (
    <main className="mx-auto max-w-[1280px] p-6 md:p-10 pt-0">
      <div className="mb-10 flex items-end justify-between">
        <div>
          <div className="tag mb-3">Live · updates every 3s</div>
          <h1 className="text-[64px] leading-none uppercase">Admin dashboard</h1>
        </div>
        <div className="text-caption text-obsidian/50">Synced {lastSync.toLocaleTimeString()}</div>
      </div>

      <section className="mb-10 grid grid-cols-2 gap-5 md:grid-cols-4">
        <Stat label="Open incidents" value={open} />
        <Stat label="Awaiting customer" value={awaiting} />
        <Stat label="Recovery actions" value={recovery} />
        <Stat label="Verified resolutions" value={resolved} featured />
      </section>

      <section className="mb-10">
        <h2 className="mb-5 text-[48px] leading-none uppercase">Recent incidents</h2>
        <div className="overflow-hidden rounded-[40px] bg-limestone">
          {incidents.length === 0 ? (
            <div className="p-10 text-center text-body text-obsidian/70">No incidents yet.</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-left text-caption uppercase tracking-wide text-obsidian/60">
                  <th className="px-6 py-5">Created</th>
                  <th className="px-6 py-5">Type</th>
                  <th className="px-6 py-5">Description</th>
                  <th className="px-6 py-5">Status</th>
                  <th className="px-6 py-5"></th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id} className="border-t border-obsidian/5">
                    <td className="px-6 py-5 text-body-sm text-obsidian/70">
                      {new Date(i.created_at).toLocaleString()}
                    </td>
                    <td className="px-6 py-5 text-body-sm">{i.type ?? "—"}</td>
                    <td className="max-w-md truncate px-6 py-5 text-body-sm">
                      {i.description ?? i.raw_input ?? "—"}
                    </td>
                    <td className="px-6 py-5"><StatusBadge status={i.status} /></td>
                    <td className="px-6 py-5 text-right">
                      <Link href={`/admin/incidents/${i.id}`} className="btn-ghost text-sm underline">
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-5 text-[48px] leading-none uppercase">Orders & assignments</h2>
        <div className="grid gap-5 md:grid-cols-3">
          {orders.map((o) => {
            const rider = o.rider_id ? ridersById.get(o.rider_id) : null;
            return (
              <div key={o.id} className="card-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="tag">{o.status.replace("_", " ")}</div>
                  {rider && (
                    <span className="rounded-full bg-pumice px-3 py-1 text-caption text-obsidian/70">
                      {rider.name}
                    </span>
                  )}
                </div>
                <div className="mt-3 font-mono text-caption text-obsidian/60">{o.order_code}</div>
                <div className="mt-1 text-subheading font-display uppercase leading-none tracking-[0.02em]">
                  {o.customer_name}
                </div>
                <div className="mt-2 text-body-sm text-obsidian/70">{o.customer_email}</div>
                <div className="mt-2 text-body-sm text-obsidian/70">{o.address}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-5 text-[32px] leading-none uppercase">Rider fleet</h2>
        <div className="grid gap-5 md:grid-cols-3">
          {riders.map((r) => (
            <div key={r.id} className="card-sm">
              <div className="flex items-center justify-between">
                <div className="text-subheading font-display uppercase leading-none tracking-[0.02em]">
                  {r.name}
                </div>
                <span
                  className={
                    "rounded-full px-3 py-1 text-caption font-medium " +
                    (r.status === "available"
                      ? "bg-ember text-chalk"
                      : r.status === "busy"
                      ? "bg-sulfur text-obsidian"
                      : "bg-obsidian/20 text-obsidian")
                  }
                >
                  {r.status}
                </span>
              </div>
              <div className="mt-2 text-body-sm text-obsidian/60">{r.phone}</div>
              <div className="mt-1 text-caption text-obsidian/60">capacity {r.capacity}</div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value, featured = false }: { label: string; value: number; featured?: boolean }) {
  return (
    <div className={"rounded-[40px] p-8 " + (featured ? "bg-ember text-chalk" : "bg-limestone text-obsidian")}>
      <div className={"text-caption uppercase tracking-wide " + (featured ? "text-chalk" : "text-obsidian/60")}>
        {label}
      </div>
      <div className="mt-6 font-display text-[64px] leading-none tracking-[0.02em]">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
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
