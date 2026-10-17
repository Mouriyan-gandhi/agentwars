import { createHash, randomBytes } from "crypto";

export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  const hash = hashToken(token);
  return { token, hash };
}

export function hashToken(token: string): string {
  const secret = process.env.CUSTOMER_FORM_TOKEN_SECRET || "default-dev-secret";
  return createHash("sha256").update(`${secret}:${token}`).digest("hex");
}
