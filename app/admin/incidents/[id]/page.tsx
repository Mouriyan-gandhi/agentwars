import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import type {
  ActionLog,
  Incident,
  Notification,
  Order,
  CustomerResponse,
  AgentDecision,
  DecisionFeedback,
  AgentTraceStep,
  AgentEvaluationRow,
} from "@/lib/types";
import ResumeButton from "./ResumeButton";
import FeedbackPanel from "./FeedbackPanel";
import AgentChainPanel from "./AgentChainPanel";

export const dynamic = "force-dynamic";

async function loadIncident(id: string) {
  const db = supabaseAdmin();
  const [
    { data: incident },
    { data: logs },
    { data: notifications },
    { data: responses },
    { data: feedback },
    { data: trace },
    { data: evaluations },
  ] = await Promise.all([
    db.from("incidents").select("*").eq("id", id).single(),
    db.from("action_logs").select("*").eq("incident_id", id).order("created_at", { ascending: true }),
    db.from("notifications").select("*").eq("incident_id", id).order("created_at", { ascending: true }),
    db.from("customer_responses").select("*").eq("incident_id", id).order("created_at", { ascending: true }),
    db.from("decision_feedback").select("*").eq("incident_id", id).order("created_at", { ascending: false }),
    db.from("agent_trace").select("*").eq("incident_id", id).order("step_index", { ascending: true }),
    db.from("agent_evaluations").select("*").eq("incident_id", id).order("attempt", { ascending: false }),
  ]);
  let order: Order | null = null;
  if (incident?.order_id) {
    const { data } = await db.from("orders").select("*").eq("id", incident.order_id).maybeSingle();
    order = (data as Order) ?? null;
  }
  return {
    incident: (incident ?? null) as Incident | null,
    order,
    logs: (logs ?? []) as ActionLog[],
    notifications: (notifications ?? []) as Notification[],
    responses: (responses ?? []) as CustomerResponse[],
    feedback: (feedback ?? []) as DecisionFeedback[],
    trace: (trace ?? []) as AgentTraceStep[],
    evaluations: (evaluations ?? []) as AgentEvaluationRow[],
  };
}

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { incident, order, logs, notifications, responses, feedback, trace, evaluations } =
    await loadIncident(id);

  if (!incident) {
    return (
      <main className="mx-auto max-w-3xl p-6 md:p-10">
        <Link href="/admin" className="btn-ghost text-sm">← Dashboard</Link>
        <div className="mt-8 card">
          <h2 className="text-heading uppercase">Not found</h2>
          <p className="mt-3 text-body text-obsidian/70">That incident does not exist.</p>
        </div>
      </main>
    );
  }

  const decision = incident.analysis as AgentDecision | null;

  return (
    <main className="mx-auto max-w-[1120px] p-6 md:p-10">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/admin" className="btn-ghost text-sm">← Dashboard</Link>
        <ResumeButton incidentId={incident.id} currentStatus={incident.status} />
      </div>

      <div className="mb-8">
        <div className="mb-3 flex items-center gap-2">
          <span className="tag">{incident.input_type.replace("_", " ")}</span>
          <span
            className={
              "rounded-full px-3 py-1 text-caption font-medium " +
              (incident.source === "customer_complaint"
                ? "bg-plasma-violet text-chalk"
                : "bg-obsidian/10 text-obsidian")
            }
          >
            {incident.source === "customer_complaint" ? "Customer complaint" : "Rider report"}
          </span>
          {incident.issue_category && (
            <span className="rounded-full bg-obsidian/10 px-3 py-1 text-caption text-obsidian">
              {incident.issue_category.replace(/_/g, " ")}
            </span>
          )}
        </div>
        <h1 className="text-[64px] leading-none uppercase">Incident {incident.id.slice(0, 8)}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-body-sm">
          <StatusPill status={incident.status} />
          <span className="text-obsidian/60">Attempts: {incident.attempt_count}</span>
          {incident.last_error && (
            <span className="rounded-full bg-ember/10 px-3 py-1 text-ember">
              ⚠ {incident.last_error}
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <Panel title="Report">
          <div className="text-caption uppercase tracking-wide text-obsidian/60">{incident.input_type}</div>
          <div className="mt-3 whitespace-pre-wrap text-body-sm text-obsidian/80">{incident.raw_input ?? "—"}</div>
          {incident.image_url && (
            <div className="mt-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={incident.image_url} alt="incident" className="max-h-64 rounded-[24px] border border-obsidian/10" />
            </div>
          )}
          {incident.audio_url && (
            <div className="mt-4">
              <div className="text-caption uppercase tracking-wide text-obsidian/60">
                Voice note
              </div>
              <audio controls src={incident.audio_url} className="mt-2 w-full" />
            </div>
          )}
        </Panel>

        <Panel title="Planner decision (ADK)">
          {decision ? (
            <div className="space-y-3 text-body-sm">
              <KV label="Type" value={decision.incidentType} />
              <KV label="Order" value={decision.orderCode ?? "—"} />
              <KV label="Summary" value={decision.summary} />
              <div>
                <div className="text-caption uppercase tracking-wide text-obsidian/60">Missing info</div>
                <ul className="ml-5 mt-1 list-disc text-obsidian/80">
                  {decision.missingInformation.map((m, i) => <li key={i}>{m}</li>)}
                </ul>
              </div>
              <KV label="Recommended action" value={decision.recommendedAction} />
              <KV label="Urgency" value={decision.urgency} />
              <div>
                <div className="text-caption uppercase tracking-wide text-obsidian/60">Reasoning</div>
                <div className="mt-1 text-obsidian/70">{decision.reasoning}</div>
              </div>
            </div>
          ) : (
            <div className="text-body-sm text-obsidian/60">Not analyzed yet.</div>
          )}
        </Panel>

        <Panel title="Order">
          {order ? (
            <div className="space-y-2 text-body-sm">
              <div className="tag">{order.status.replace("_", " ")}</div>
              <div className="pt-2 font-mono text-caption text-obsidian/60">{order.order_code}</div>
              <div className="text-subheading font-display uppercase leading-none tracking-[0.02em]">{order.customer_name}</div>
              <div className="text-obsidian/70">{order.customer_email}</div>
              <div className="text-obsidian/70">{order.customer_phone ?? "—"}</div>
              <div className="pt-2 text-obsidian/80">{order.address}</div>
              {order.address_notes && (
                <div className="text-obsidian/60">Notes: {order.address_notes}</div>
              )}
            </div>
          ) : (
            <div className="text-body-sm text-obsidian/60">No linked order.</div>
          )}
        </Panel>

        <Panel title="Customer communication">
          {notifications.length === 0 ? (
            <div className="text-body-sm text-obsidian/60">No emails sent yet.</div>
          ) : (
            <ul className="space-y-3 text-body-sm">
              {notifications.map((n) => (
                <li key={n.id} className="rounded-[24px] bg-pumice p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">{n.subject}</div>
                    <NotifBadge status={n.status} />
                  </div>
                  <div className="mt-1 text-caption text-obsidian/60">to {n.recipient}</div>
                  {n.email_id && (
                    <div className="mt-1 text-caption text-obsidian/60">Resend id: {n.email_id}</div>
                  )}
                  {n.error && <div className="mt-2 text-caption text-ember">{n.error}</div>}
                </li>
              ))}
            </ul>
          )}

          {responses.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 text-caption uppercase tracking-wide text-obsidian/60">Customer form</div>
              {responses.map((r) => (
                <div key={r.id} className="rounded-[24px] bg-pumice p-4 text-body-sm">
                  <div className="text-caption text-obsidian/60">
                    {r.submitted_at ? `Submitted ${new Date(r.submitted_at).toLocaleString()}` : "Pending"}
                  </div>
                  {r.response_data && (
                    <pre className="mt-2 whitespace-pre-wrap text-caption text-obsidian/80">
                      {JSON.stringify(r.response_data, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <section className="mt-10">
        <AgentChainPanel
          trace={trace}
          evaluations={evaluations}
          maskedInput={incident.masked_input}
          rawInput={incident.raw_input}
          piiMap={incident.pii_map}
          healAttempts={incident.heal_attempts ?? 0}
          totalTokensIn={incident.total_tokens_in ?? 0}
          totalTokensOut={incident.total_tokens_out ?? 0}
          totalCostUsd={Number(incident.total_cost_usd ?? 0)}
          totalLatencyMs={incident.total_latency_ms ?? 0}
          piiLeakDetected={!!incident.pii_leak_detected}
        />
      </section>

      <section className="mt-10">
        <FeedbackPanel
          incidentId={incident.id}
          currentStatus={incident.status}
          existing={feedback}
        />
      </section>

      <section className="mt-10">
        <h2 className="mb-5 text-[48px] leading-none uppercase">Execution timeline</h2>
        <ol className="space-y-3">
          {logs.map((l) => (
            <li key={l.id} className="card-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="font-mono text-caption text-obsidian/60">
                  {new Date(l.created_at).toLocaleString()}
                </div>
                <LogBadge status={l.status} />
              </div>
              <div className="mt-2 text-body font-medium">{l.action}</div>
              {l.message && <div className="mt-1 text-body-sm text-obsidian/70">{l.message}</div>}
              {l.result && Object.keys(l.result).length > 0 && (
                <pre className="mt-3 overflow-x-auto rounded-[16px] bg-pumice p-3 text-caption text-obsidian/80">
                  {JSON.stringify(l.result, null, 2)}
                </pre>
              )}
            </li>
          ))}
          {logs.length === 0 && (
            <li className="text-body-sm text-obsidian/60">No actions yet.</li>
          )}
        </ol>
      </section>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3 className="mb-4 text-caption uppercase tracking-wide text-obsidian/60">{title}</h3>
      {children}
    </div>
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

function NotifBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    sent: "bg-ember text-chalk",
    opened: "bg-ember text-chalk",
    queued: "bg-obsidian/10 text-obsidian",
    failed: "bg-obsidian text-chalk",
    bounced: "bg-obsidian text-chalk",
  };
  const cls = map[status] ?? "bg-obsidian/10 text-obsidian";
  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-caption font-medium ${cls}`}>
      {status}
    </span>
  );
}
