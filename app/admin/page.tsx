import { supabaseAdmin } from "@/lib/supabase";
import type { Incident, Order, Rider } from "@/lib/types";
import AdminDashboard from "./AdminDashboard";

export const dynamic = "force-dynamic";

async function loadInitial() {
  const db = supabaseAdmin();
  const [{ data: incidents }, { data: orders }, { data: riders }] = await Promise.all([
    db.from("incidents").select("*").order("created_at", { ascending: false }).limit(50),
    db.from("orders").select("*").order("created_at", { ascending: false }).limit(20),
    db.from("riders").select("*").order("name"),
  ]);
  return {
    incidents: (incidents ?? []) as Incident[],
    orders: (orders ?? []) as Order[],
    riders: (riders ?? []) as Rider[],
  };
}

export default async function AdminHome() {
  const { incidents, orders, riders } = await loadInitial();
  return <AdminDashboard initialIncidents={incidents} initialOrders={orders} initialRiders={riders} />;
}
