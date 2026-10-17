import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/session";
import type { Incident, Order } from "@/lib/types";
import RiderDashboard from "./RiderDashboard";

export const dynamic = "force-dynamic";

async function loadData(userId: string, riderId: string | null) {
  if (!riderId) return { orders: [], incidents: [] };
  const db = supabaseAdmin();
  const [{ data: orders }, { data: incidents }] = await Promise.all([
    db.from("orders").select("*").eq("rider_id", riderId).order("deadline", { ascending: true }),
    db
      .from("incidents")
      .select("*")
      .or(`reported_by_user_id.eq.${userId},rider_id.eq.${riderId}`)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  return {
    orders: (orders ?? []) as Order[],
    incidents: (incidents ?? []) as Incident[],
  };
}

export default async function RiderHome() {
  const session = (await getSession())!;
  const { orders, incidents } = await loadData(session.user_id, session.rider_id);

  return (
    <RiderDashboard
      displayName={session.display_name}
      riderId={session.rider_id}
      initialOrders={orders}
      initialIncidents={incidents}
    />
  );
}
