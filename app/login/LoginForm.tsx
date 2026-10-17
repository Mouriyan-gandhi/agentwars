"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginForm({
  role,
  title,
  blurb,
  demo,
}: {
  role: "admin" | "rider";
  title: string;
  blurb: string;
  demo: { email: string; password: string }[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, role }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Login failed");
      router.push(json.redirect ?? "/");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function usePreset(c: { email: string; password: string }) {
    setEmail(c.email);
    setPassword(c.password);
  }

  return (
    <main className="mx-auto max-w-[520px] p-6 md:p-10">
      <div className="mb-8">
        <Link href="/" className="btn-ghost text-sm">← Home</Link>
      </div>

      <h1 className="text-[48px] leading-none uppercase">{title}</h1>
      <p className="mt-3 text-body text-obsidian/70">{blurb}</p>

      <form onSubmit={submit} className="card mt-8 space-y-5">
        <div>
          <label className="mb-2 block text-caption uppercase tracking-wide text-obsidian/60">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={demo[0]?.email}
            className="input"
            autoFocus
            required
          />
        </div>
        <div>
          <label className="mb-2 block text-caption uppercase tracking-wide text-obsidian/60">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
            required
          />
        </div>

        {err && (
          <div className="rounded-[24px] bg-ember/10 p-4 text-body-sm text-ember">{err}</div>
        )}

        <button type="submit" disabled={busy} className="btn-primary disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in →"}
        </button>

        {demo.length > 0 && (
          <div className="mt-6 border-t border-obsidian/10 pt-5">
            <div className="mb-2 text-caption uppercase tracking-wide text-obsidian/60">
              Demo credentials (click to fill)
            </div>
            <div className="space-y-2">
              {demo.map((c) => (
                <button
                  key={c.email}
                  type="button"
                  onClick={() => usePreset(c)}
                  className="block w-full rounded-[16px] bg-pumice px-4 py-3 text-left font-mono text-caption hover:bg-obsidian/5"
                >
                  <span className="text-obsidian">{c.email}</span>
                  <span className="text-obsidian/60"> · {c.password}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </main>
  );
}
