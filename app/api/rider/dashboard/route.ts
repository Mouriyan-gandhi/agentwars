import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "rider") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!session.rider_id) {
    return NextResponse.json({ orders: [], incidents: [] });
  }

  const db = supabaseAdmin();
  const [{ data: orders }, { data: incidents }] = await Promise.all([
    db.from("orders").select("*").eq("rider_id", session.rider_id).order("deadline", { ascending: true }),
    // Show incidents the rider either filed or is currently assigned to.
    db
      .from("incidents")
      .select("*")
      .or(`reported_by_user_id.eq.${session.user_id},rider_id.eq.${session.rider_id}`)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  return NextResponse.json({ orders: orders ?? [], incidents: incidents ?? [] });
}
