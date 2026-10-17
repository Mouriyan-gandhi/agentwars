"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ResumeButton({
  incidentId,
  currentStatus,
}: {
  incidentId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const terminal = ["resolved", "escalated", "failed"].includes(currentStatus);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/incidents/${incidentId}/run`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {err && <span className="text-caption text-ember">{err}</span>}
      <button
        onClick={run}
        disabled={busy || terminal}
        className="btn-secondary disabled:opacity-50"
      >
        {busy ? "Running…" : terminal ? "Workflow complete" : "Resume workflow"}
      </button>
      <button onClick={() => router.refresh()} className="btn-ghost text-sm">
        Refresh
      </button>
    </div>
  );
}
