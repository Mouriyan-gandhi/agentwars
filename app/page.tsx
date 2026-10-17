import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const session = await getSession();
  if (session?.role === "admin") redirect("/admin");
  if (session?.role === "rider") redirect("/rider");

  return (
    <main className="mx-auto max-w-[1280px] p-6 md:p-10">
      {/* nav */}
      <nav className="mb-10 flex items-center justify-between rounded-full bg-limestone px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-ember" />
          <div className="text-[18px] font-medium">ParcelPilot</div>
          <span className="hidden text-caption text-obsidian/60 md:inline">
            Autonomous Delivery Exception Resolution
          </span>
        </div>
        <div className="hidden gap-2 md:flex">
          <Link href="/login/rider" className="btn-ghost text-sm">Rider login</Link>
          <Link href="/login/admin" className="btn-primary text-sm">Admin login</Link>
        </div>
      </nav>

      {/* hero */}
      <section className="mb-14 grid grid-cols-1 gap-8 md:grid-cols-[1fr_480px]">
        <div className="flex flex-col justify-between">
          <h1 className="text-[80px] leading-[0.95] tracking-[0.02em] uppercase">
            One agent.<br/>Three portals.<br/>Zero stuck deliveries.
          </h1>
          <p className="mt-6 max-w-xl text-body text-obsidian/70">
            Riders file an issue in seconds. The agent reads it, emails the customer, resumes on their reply, writes the fix back to the order — and reassigns to another rider when needed. Pick a portal to begin.
          </p>
        </div>
        <div className="halftone min-h-[320px]" />
      </section>

      {/* three portal cards */}
      <section className="grid gap-6 md:grid-cols-3">
        <PortalCard
          title="Rider"
          blurb="See your assigned orders. File an incident when something blocks the delivery. Watch the agent resolve it."
          creds={[
            { email: "arjun@parcelpilot.dev", password: "rider123" },
            { email: "priya@parcelpilot.dev", password: "rider123" },
            { email: "rohan@parcelpilot.dev", password: "rider123" },
          ]}
          href="/login/rider"
          cta="Rider login →"
        />
        <PortalCard
          title="Admin"
          blurb="Watch the agent in action: Gemini extraction, auto-sent emails, customer replies, reassignment decisions, execution timeline — all live."
          creds={[{ email: "admin@parcelpilot.dev", password: "admin123" }]}
          href="/login/admin"
          cta="Admin login →"
          featured
        />
        <PortalCard
          title="Customer"
          blurb="Look up your order with the order code and email. See its status and file a complaint directly — damaged, not delivered, wrong item."
          creds={[{ email: "gandhimouriyan1234@gmail.com", password: "PP-1001" }]}
          href="/customer"
          cta="Customer portal →"
        />
      </section>
    </main>
  );
}

function PortalCard({
  title,
  blurb,
  creds,
  href,
  cta,
  featured = false,
  disabled = false,
}: {
  title: string;
  blurb: string;
  creds: { email: string; password: string }[];
  href: string;
  cta: string;
  featured?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      className="rounded-[40px] p-10"
      style={{
        background: featured ? "var(--color-ember)" : "var(--color-limestone)",
        color: featured ? "var(--color-chalk)" : "var(--color-obsidian)",
      }}
    >
      <h3 className="text-heading uppercase" style={{ color: "inherit" }}>{title}</h3>
      <p
        className="mt-3 text-body-sm"
        style={{ color: featured ? "rgba(255,255,255,0.92)" : "rgba(7,6,7,0.75)" }}
      >
        {blurb}
      </p>
      {creds.length > 0 && (
        <div className="mt-5 space-y-1 font-mono text-caption">
          <div style={{ color: featured ? "rgba(255,255,255,0.78)" : "rgba(7,6,7,0.6)" }}>
            Demo credentials
          </div>
          {creds.map((c) => (
            <div key={c.email}>
              <span style={{ color: featured ? "var(--color-chalk)" : "var(--color-obsidian)" }}>
                {c.email}
              </span>
              <span style={{ color: featured ? "rgba(255,255,255,0.75)" : "rgba(7,6,7,0.6)" }}>
                {" "}
                · {c.password}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-6">
        {disabled ? (
          <span
            className="inline-block rounded-full px-5 py-2 text-body-sm"
            style={{
              border: featured ? "1.5px solid rgba(255,255,255,0.4)" : "1.5px solid rgba(7,6,7,0.3)",
              color: featured ? "rgba(255,255,255,0.8)" : "rgba(7,6,7,0.6)",
            }}
          >
            {cta}
          </span>
        ) : (
          <Link
            href={href}
            className="inline-flex items-center gap-2 rounded-full px-5 py-2 text-body-sm font-medium"
            style={{
              background: featured ? "var(--color-chalk)" : "var(--color-ember)",
              color: "var(--color-obsidian)",
            }}
          >
            {cta}
          </Link>
        )}
      </div>
    </div>
  );
}
