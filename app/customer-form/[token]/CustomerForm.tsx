"use client";

import { useState } from "react";

export default function CustomerForm({ token }: { token: string }) {
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [phone, setPhone] = useState("");
  const [window_, setWindow] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/customer-response/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address,
          address_notes: notes,
          customer_phone: phone,
          preferred_window: window_,
          additional_notes: extra,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Submission failed");
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card bg-ember text-chalk">
        <h2 className="text-heading uppercase">Thanks!</h2>
        <p className="mt-3 text-body">
          Your delivery details have been forwarded to the rider. You can close this page.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Corrected address">
        <textarea
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          rows={3}
          placeholder="Flat / building / street / city / pincode"
          className="textarea"
        />
      </Field>
      <Field label="Landmark / notes for the rider">
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Opposite the metro station, ring bell twice"
          className="input"
        />
      </Field>
      <Field label="Phone to call">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91 ..."
          className="input"
        />
      </Field>
      <Field label="Preferred delivery window">
        <input
          value={window_}
          onChange={(e) => setWindow(e.target.value)}
          placeholder="Today 5–7pm"
          className="input"
        />
      </Field>
      <Field label="Anything else">
        <textarea
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          rows={2}
          className="textarea"
        />
      </Field>

      {err && (
        <div className="rounded-[24px] bg-ember/10 p-4 text-body-sm text-ember">
          {err}
        </div>
      )}

      <button type="submit" disabled={busy} className="btn-primary disabled:opacity-50">
        {busy ? "Submitting…" : "Submit →"}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-2 text-caption uppercase tracking-wide text-obsidian/60">{label}</div>
      {children}
    </label>
  );
}
