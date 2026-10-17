import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

const Body = z.object({
  verdict: z.enum(["right_call", "wrong_call"]),
  suggested_action: z.string().optional().nullable(),
  comment: z.string().optional().nullable(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { verdict, suggested_action, comment } = parsed.data;

  // Require a suggested_action when verdict is wrong_call so Gemini has something to learn from.
  if (verdict === "wrong_call" && !suggested_action?.trim()) {
    return NextResponse.json(
      { error: "Please provide the action it should have taken." },
      { status: 400 },
    );
  }

  const { error } = await supabaseAdmin().from("decision_feedback").insert({
    incident_id: id,
    verdict,
    suggested_action: suggested_action?.trim() || null,
    comment: comment?.trim() || null,
    reviewer_user_id: session.user_id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
