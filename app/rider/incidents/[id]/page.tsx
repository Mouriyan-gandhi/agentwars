import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/session";
import type { Incident } from "@/lib/types";
import RiderIncidentView from "./RiderIncidentView";

export const dynamic = "force-dynamic";

export default async function RiderIncidentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = (await getSession())!;

  const { data: inc } = await supabaseAdmin()
    .from("incidents")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!inc) notFound();
  // scope: only the rider who filed it or who's currently assigned.
  if ((inc as Incident).reported_by_user_id !== session.user_id &&
      (inc as Incident).rider_id !== session.rider_id) {
    return (
      <main className="mx-auto max-w-xl p-10">
        <Link href="/rider" className="btn-ghost text-sm">← Dashboard</Link>
        <div className="card mt-6">
          <h2 className="text-heading uppercase">Not available</h2>
          <p className="mt-3 text-body text-obsidian/70">
            This incident is for another rider.
          </p>
        </div>
      </main>
    );
  }

  return <RiderIncidentView incidentId={id} />;
}
