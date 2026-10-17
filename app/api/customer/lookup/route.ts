import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

const Body = z.object({
  order_code: z.string().min(1),
  email: z.string().email(),
});

export async function POST(req: NextRequest) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Order code and email required." }, { status: 400 });
  }

  const code = parsed.data.order_code.trim();
  const email = parsed.data.email.toLowerCase().trim();

  const db = supabaseAdmin();
  const { data: order } = await db
    .from("orders")
    .select("id, order_code, customer_name, customer_email, address, status, deadline, rider_id")
    .eq("order_code", code)
    .maybeSingle();

  if (!order || order.customer_email.toLowerCase().trim() !== email) {
    // Deliberately vague to avoid leaking which half was wrong.
    return NextResponse.json(
      { error: "No order matches that code and email." },
      { status: 404 },
    );
  }

  // Pull their recent incidents + the assigned rider's name.
  const [{ data: incidents }, { data: rider }] = await Promise.all([
    db
      .from("incidents")
      .select("id, source, type, status, description, created_at, resolved_at")
      .eq("order_id", order.id)
      .order("created_at", { ascending: false })
      .limit(10),
    order.rider_id
      ? db.from("riders").select("name").eq("id", order.rider_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return NextResponse.json({
    order: {
      id: order.id,
      order_code: order.order_code,
      customer_name: order.customer_name,
      address: order.address,
      status: order.status,
      deadline: order.deadline,
      rider_name: (rider as { name: string } | null)?.name ?? null,
    },
    incidents: incidents ?? [],
  });
}
