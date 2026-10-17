import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { Session } from "./types";

const COOKIE_NAME = "pp_session";
const SECRET =
  process.env.CUSTOMER_FORM_TOKEN_SECRET ||
  "fallback-dev-secret-change-me-32-bytes";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function sign(payload: string): string {
  return b64urlEncode(createHmac("sha256", SECRET).update(payload).digest());
}

export function serialize(session: Session): string {
  const payload = b64urlEncode(Buffer.from(JSON.stringify(session), "utf8"));
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

export function verify(cookieValue: string | undefined | null): Session | null {
  if (!cookieValue) return null;
  const [payload, sig] = cookieValue.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(b64urlDecode(payload).toString("utf8")) as Session;
    if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE_NAME)?.value;
  return verify(raw);
}

export async function setSession(session: Session): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, serialize(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

export function newSessionPayload(opts: {
  user_id: string;
  email: string;
  role: "admin" | "rider";
  display_name: string;
  rider_id: string | null;
}): Session {
  return {
    ...opts,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  };
}

export const SESSION_COOKIE = COOKIE_NAME;
