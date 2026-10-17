import { NextRequest, NextResponse } from "next/server";
import { runWorkflow } from "@/lib/workflow";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runWorkflow(id);
    return NextResponse.json({
      incident: result.incident,
      decision: result.decision ?? null,
      message: result.message ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
