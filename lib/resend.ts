import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM_EMAIL || "ParcelPilot <onboarding@resend.dev>";

let _client: Resend | null = null;
function client(): Resend {
  if (!apiKey) throw new Error("RESEND_API_KEY missing");
  if (!_client) _client = new Resend(apiKey);
  return _client;
}

export type SendArgs = {
  to: string;
  subject: string;
  html: string;
  idempotencyKey?: string;
};

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  try {
    const res = await client().emails.send(
      { from, to: args.to, subject: args.subject, html: args.html },
      args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined,
    );
    if (res.error) return { ok: false, error: res.error.message || JSON.stringify(res.error) };
    if (!res.data?.id) return { ok: false, error: "Resend returned no message id" };
    return { ok: true, id: res.data.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export function clarificationEmailHtml(opts: {
  orderCode: string;
  customerName: string;
  summary: string;
  missing: string[];
  formUrl: string;
}): string {
  const bullets = opts.missing
    .map((m) => `<li style="margin-bottom:6px">${escapeHtml(m)}</li>`)
    .join("");
  return `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
      <h2 style="margin:0 0 12px 0">Help us complete your delivery</h2>
      <p>Hi ${escapeHtml(opts.customerName)},</p>
      <p>We ran into a snag delivering order <b>${escapeHtml(opts.orderCode)}</b>.</p>
      <p><b>What happened:</b> ${escapeHtml(opts.summary)}</p>
      <p>Could you share these details so we can finish the delivery today?</p>
      <ul>${bullets}</ul>
      <p style="margin:24px 0">
        <a href="${opts.formUrl}" style="background:#fc5000;color:#fff;padding:12px 24px;border-radius:800px;text-decoration:none;font-weight:600;display:inline-block">Update delivery details</a>
      </p>
      <p style="font-size:12px;color:#666">This link expires in 24 hours. If you didn't expect this message, ignore it.</p>
      <p style="font-size:12px;color:#666">— ParcelPilot Operations</p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
