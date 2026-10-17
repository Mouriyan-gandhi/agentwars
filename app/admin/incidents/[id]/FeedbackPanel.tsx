"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Feedback = {
  id: string;
  verdict: "right_call" | "wrong_call";
  suggested_action: string | null;
  comment: string | null;
  created_at: string;
};

type Props = {
  incidentId: string;
  currentStatus: string;
  existing: Feedback[];
};

export default function FeedbackPanel({ incidentId, currentStatus, existing }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "wrong">("idle");
  const [suggestion, setSuggestion] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const terminal = ["resolved", "escalated", "failed"].includes(currentStatus);
  const alreadyFiled = existing.length > 0 || done;

  async function send(verdict: "right_call" | "wrong_call") {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/incidents/${incidentId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          verdict,
          suggested_action: verdict === "wrong_call" ? suggestion.trim() : null,
          comment: comment.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setDone(true);
      setMode("idle");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!terminal) {
    return (
      <div className="card">
        <h3 className="mb-2 text-caption uppercase tracking-wide text-obsidian/60">
          Reviewer feedback
        </h3>
        <p className="text-body-sm text-obsidian/60">
          Available once the agent reaches a terminal state (resolved / escalated / failed).
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h3 className="mb-2 text-caption uppercase tracking-wide text-obsidian/60">
        Reviewer feedback
      </h3>

      {existing.length > 0 && (
        <div className="mb-4 space-y-2">
          {existing.map((f) => (
            <div key={f.id} className="rounded-[24px] bg-pumice p-4 text-body-sm">
              <div className="flex items-center justify-between">
                <span
                  className={
                    "rounded-full px-3 py-1 text-caption font-medium " +
                    (f.verdict === "right_call"
                      ? "bg-ember text-chalk"
                      : "bg-obsidian text-chalk")
                  }
                >
                  {f.verdict === "right_call" ? "Right call" : "Wrong call"}
                </span>
                <span className="text-caption text-obsidian/50">
                  {new Date(f.created_at).toLocaleString()}
                </span>
              </div>
              {f.suggested_action && (
                <div className="mt-2">
                  <span className="text-caption uppercase tracking-wide text-obsidian/60">
                    Should have been:
                  </span>{" "}
                  <span className="font-mono text-caption">{f.suggested_action}</span>
                </div>
              )}
              {f.comment && (
                <div className="mt-1 text-obsidian/70">{f.comment}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {alreadyFiled ? (
        <p className="text-caption text-obsidian/60">
          Thanks. Future Gemini decisions will see this feedback as a correction example.
        </p>
      ) : mode === "idle" ? (
        <div className="flex items-center gap-3">
          <button
            onClick={() => send("right_call")}
            disabled={busy}
            className="btn-primary disabled:opacity-50"
          >
            ✓ Right call
          </button>
          <button
            onClick={() => setMode("wrong")}
            disabled={busy}
            className="btn-secondary"
          >
            ✗ Wrong call
          </button>
          {err && <span className="text-caption text-ember">{err}</span>}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="mb-2 block text-caption uppercase tracking-wide text-obsidian/60">
              What should the agent have done?
            </label>
            <input
              value={suggestion}
              onChange={(e) => setSuggestion(e.target.value)}
              placeholder="e.g. offer_refund_or_reship, propose_reassignment, escalate"
              className="input"
            />
          </div>
          <div>
            <label className="mb-2 block text-caption uppercase tracking-wide text-obsidian/60">
              Short why (optional)
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              className="textarea"
              placeholder="Give one line future-you (or future-Gemini) will understand."
            />
          </div>
          {err && (
            <div className="rounded-[24px] bg-ember/10 p-4 text-body-sm text-ember">{err}</div>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={() => send("wrong_call")}
              disabled={busy || !suggestion.trim()}
              className="btn-primary disabled:opacity-50"
            >
              {busy ? "Saving…" : "Submit correction →"}
            </button>
            <button
              onClick={() => setMode("idle")}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
