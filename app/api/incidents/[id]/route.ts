import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/session";
import type { Incident } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = supabaseAdmin();
  const [{ data: incident, error: incErr }, { data: logs }, { data: notifications }, { data: responses }] =
    await Promise.all([
      db.from("incidents").select("*").eq("id", id).single(),
      db.from("action_logs").select("*").eq("incident_id", id).order("created_at", { ascending: true }),
      db.from("notifications").select("*").eq("incident_id", id).order("created_at", { ascending: true }),
      db.from("customer_responses").select("*").eq("incident_id", id).order("created_at", { ascending: true }),
    ]);

  if (incErr || !incident) {
    return NextResponse.json({ error: incErr?.message ?? "not found" }, { status: 404 });
  }

  const inc = incident as Incident;
  if (session.role === "rider") {
    const ownsReport = inc.reported_by_user_id === session.user_id;
    const ownsAssignment = inc.rider_id === session.rider_id;
    if (!ownsReport && !ownsAssignment) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  let order = null;
  if (inc.order_id) {
    const { data } = await db.from("orders").select("*").eq("id", inc.order_id).maybeSingle();
    order = data;
  }

  return NextResponse.json({
    incident: inc,
    order,
    action_logs: logs ?? [],
    notifications: notifications ?? [],
    customer_responses: responses ?? [],
  });
}
