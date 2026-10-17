/**
 * Minimal Model Context Protocol server + in-process client.
 *
 * Why this exists: the ADK multi-agent brain plans the recovery action but
 * the actual side effects (reading orders, reassigning riders, sending email,
 * updating status) happen in Next.js. We expose those side effects as MCP
 * tools so:
 *   1. The brain can call them over an open protocol (JSON-RPC-ish `tools/call`
 *      requests) rather than bespoke Next.js REST routes.
 *   2. Our own Executor module calls the exact same tool table in-process,
 *      so there's one shared contract between "agent asks for action" and
 *      "we actually do it".
 *   3. Judges can hit `/api/mcp` with `tools/list` and see a real MCP surface.
 *
 * This is intentionally not the full MCP spec — we implement the two
 * primitives that matter (list + call) with the JSON-RPC envelope MCP uses.
 */

import { supabaseAdmin } from "./supabase";
import { sendEmail, clarificationEmailHtml } from "./resend";

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [k: string]: JSONValue };

export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (args: Record<string, unknown>) => Promise<JSONValue>;
};

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
const tools: McpTool[] = [
  {
    name: "get_order_by_code",
    description: "Fetch an order row by its public order_code (e.g. PP-1001).",
    inputSchema: {
      type: "object",
      properties: { order_code: { type: "string" } },
      required: ["order_code"],
    },
    handler: async (args) => {
      const code = String(args.order_code ?? "");
      const { data } = await supabaseAdmin()
        .from("orders")
        .select("*")
        .eq("order_code", code)
        .maybeSingle();
      return (data ?? null) as JSONValue;
    },
  },
  {
    name: "find_available_rider",
    description:
      "Return one available rider, optionally excluding a specific rider id. Used by reassignment.",
    inputSchema: {
      type: "object",
      properties: { exclude_rider_id: { type: "string" } },
    },
    handler: async (args) => {
      let q = supabaseAdmin().from("riders").select("*").eq("status", "available").limit(1);
      if (args.exclude_rider_id) q = q.neq("id", String(args.exclude_rider_id));
      const { data } = await q.maybeSingle();
      return (data ?? null) as JSONValue;
    },
  },
  {
    name: "reassign_order",
    description:
      "Move an order to a new rider. Marks the previous rider available and the new rider busy.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        new_rider_id: { type: "string" },
        previous_rider_id: { type: "string" },
      },
      required: ["order_id", "new_rider_id"],
    },
    handler: async (args) => {
      const db = supabaseAdmin();
      await db
        .from("orders")
        .update({ rider_id: String(args.new_rider_id) })
        .eq("id", String(args.order_id));
      if (args.previous_rider_id) {
        await db
          .from("riders")
          .update({ status: "available" })
          .eq("id", String(args.previous_rider_id));
      }
      await db
        .from("riders")
        .update({ status: "busy" })
        .eq("id", String(args.new_rider_id));
      return { ok: true } as JSONValue;
    },
  },
  {
    name: "update_order_status",
    description: "Patch an order's status (and optional address/notes/phone).",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        status: { type: "string" },
        address: { type: "string" },
        address_notes: { type: "string" },
        customer_phone: { type: "string" },
      },
      required: ["order_id"],
    },
    handler: async (args) => {
      const patch: Record<string, unknown> = {};
      if (args.status) patch.status = args.status;
      if (args.address) patch.address = args.address;
      if (args.address_notes !== undefined) patch.address_notes = args.address_notes;
      if (args.customer_phone) patch.customer_phone = args.customer_phone;
      if (Object.keys(patch).length === 0) return { ok: true, noop: true } as JSONValue;
      await supabaseAdmin().from("orders").update(patch).eq("id", String(args.order_id));
      return { ok: true, patched: patch as JSONValue } as JSONValue;
    },
  },
  {
    name: "send_clarification_email",
    description:
      "Send the standard clarification email to the customer, logged as a notification row.",
    inputSchema: {
      type: "object",
      properties: {
        incident_id: { type: "string" },
        to: { type: "string" },
        order_code: { type: "string" },
        customer_name: { type: "string" },
        summary: { type: "string" },
        missing: { type: "array", items: { type: "string" } },
        form_url: { type: "string" },
        subject: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: [
        "incident_id",
        "to",
        "order_code",
        "customer_name",
        "summary",
        "form_url",
      ],
    },
    handler: async (args) => {
      const html = clarificationEmailHtml({
        orderCode: String(args.order_code),
        customerName: String(args.customer_name),
        summary: String(args.summary),
        missing:
          Array.isArray(args.missing) && args.missing.length > 0
            ? (args.missing as string[])
            : ["Please confirm your delivery details"],
        formUrl: String(args.form_url),
      });
      const subject =
        (args.subject as string | undefined) ??
        `Action needed for order ${args.order_code}`;
      const db = supabaseAdmin();
      const { data: notif } = await db
        .from("notifications")
        .insert({
          incident_id: String(args.incident_id),
          recipient: String(args.to),
          subject,
          body: html,
          status: "queued",
        })
        .select("id")
        .single();
      const result = await sendEmail({
        to: String(args.to),
        subject,
        html,
        idempotencyKey: (args.idempotency_key as string | undefined) ?? undefined,
      });
      if (!result.ok) {
        await db
          .from("notifications")
          .update({ status: "failed", error: result.error })
          .eq("id", notif!.id);
        return { ok: false, error: result.error } as JSONValue;
      }
      await db
        .from("notifications")
        .update({
          status: "sent",
          email_id: result.id,
          sent_at: new Date().toISOString(),
        })
        .eq("id", notif!.id);
      return { ok: true, email_id: result.id } as JSONValue;
    },
  },
  {
    name: "log_action",
    description: "Append a row to action_logs.",
    inputSchema: {
      type: "object",
      properties: {
        incident_id: { type: "string" },
        action: { type: "string" },
        status: { type: "string" },
        message: { type: "string" },
        result: { type: "object" },
      },
      required: ["incident_id", "action", "status"],
    },
    handler: async (args) => {
      await supabaseAdmin().from("action_logs").insert({
        incident_id: String(args.incident_id),
        action: String(args.action),
        status: String(args.status),
        message: args.message ? String(args.message) : null,
        result: (args.result as Record<string, unknown> | undefined) ?? null,
      });
      return { ok: true } as JSONValue;
    },
  },
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// MCP server surface (JSON-RPC envelope)
// ---------------------------------------------------------------------------
type RpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };
type RpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: JSONValue }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export async function handleMcp(req: RpcRequest): Promise<RpcResponse> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema as unknown as JSONValue,
            })),
          },
        };

      case "tools/call": {
        const name = String((req.params ?? {}).name ?? "");
        const args = ((req.params ?? {}).arguments ?? {}) as Record<string, unknown>;
        const tool = toolMap.get(name);
        if (!tool) {
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } };
        }
        const out = await tool.handler(args);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }],
            structuredContent: out,
          },
        };
      }

      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${req.method}` } };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// In-process client — the Executor uses this to call tools without going
// through the HTTP endpoint. Same contract either way.
// ---------------------------------------------------------------------------
export async function callTool<T = JSONValue>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`MCP tool not found: ${name}`);
  return (await tool.handler(args)) as T;
}

export function listTools() {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
