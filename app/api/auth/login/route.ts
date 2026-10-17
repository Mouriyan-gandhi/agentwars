import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { newSessionPayload, setSession } from "@/lib/session";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  role: z.enum(["admin", "rider"]).optional(),
});

export async function POST(req: NextRequest) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 400 });
  }

  const { email, password, role } = parsed.data;

  const { data: user, error } = await supabaseAdmin()
    .from("users")
    .select("id, email, password, role, display_name, rider_id")
    .eq("email", email.toLowerCase().trim())
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!user || user.password !== password) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }
  if (role && user.role !== role) {
    return NextResponse.json(
      { error: `This account is a ${user.role}, not a ${role}` },
      { status: 403 },
    );
  }

  await setSession(
    newSessionPayload({
      user_id: user.id,
      email: user.email,
      role: user.role,
      display_name: user.display_name,
      rider_id: user.rider_id,
    }),
  );

  const redirect = user.role === "admin" ? "/admin" : "/rider";
  return NextResponse.json({ ok: true, redirect, role: user.role });
}
