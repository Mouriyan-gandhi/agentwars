import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = supabaseAdmin();
  const [{ data: incidents }, { data: orders }, { data: riders }] = await Promise.all([
    db.from("incidents").select("*").order("created_at", { ascending: false }).limit(50),
    db.from("orders").select("*").order("created_at", { ascending: false }).limit(20),
    db.from("riders").select("*").order("name"),
  ]);
  return NextResponse.json({ incidents: incidents ?? [], orders: orders ?? [], riders: riders ?? [] });
}
