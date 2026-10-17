import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ingestCustomerResponse, runWorkflow } from "@/lib/workflow";
import { hashToken } from "@/lib/token";

export const runtime = "nodejs";

const Body = z.object({
  address: z.string().optional(),
  address_notes: z.string().optional(),
  customer_phone: z.string().optional(),
  preferred_window: z.string().optional(),
  additional_notes: z.string().optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const hash = hashToken(token);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = Body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Reject if all fields are blank.
  const hasAny = Object.values(parsed.data).some((v) => typeof v === "string" && v.trim().length > 0);
  if (!hasAny) {
    return NextResponse.json({ error: "Please fill in at least one field" }, { status: 400 });
  }

  const result = await ingestCustomerResponse(hash, parsed.data);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Resume the workflow to apply the fix and resolve.
  const run = await runWorkflow(result.incidentId);

  return NextResponse.json({
    ok: true,
    incident_id: result.incidentId,
    status: run.incident.status,
  });
}
