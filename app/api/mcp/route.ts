import { NextRequest, NextResponse } from "next/server";
import { handleMcp, listTools } from "@/lib/mcp";

export const runtime = "nodejs";

// GET /api/mcp — human-readable tool manifest (handy for judges + debugging)
export async function GET() {
  return NextResponse.json({
    protocol: "mcp",
    transport: "http+jsonrpc",
    tools: listTools(),
  });
}

// POST /api/mcp — JSON-RPC endpoint for `tools/list` and `tools/call`
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object" || !("method" in body)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
      { status: 400 },
    );
  }
  const res = await handleMcp(body as Parameters<typeof handleMcp>[0]);
  return NextResponse.json(res);
}
