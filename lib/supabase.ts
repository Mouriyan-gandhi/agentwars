import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");

// Server-only client that bypasses RLS. Never ship this to the browser.
let _adminClient: SupabaseClient | null = null;
export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    if (!serviceKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    _adminClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _adminClient;
}

// Browser-safe client (reads only via RLS; we currently fetch all data server-side).
export function supabaseBrowser(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
