'use client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

// A single browser client that PERSISTS the session (localStorage) — this is the
// authenticated surface (Tier 2). Same anon key + RLS; the logged-in user's JWT is
// attached automatically once they sign in, so every write is gated by their own
// permissions. (Public Tier-1 pages keep using the no-session server client.)
let client: SupabaseClient | null = null;
export function browserSb(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'lb-web-auth' },
    });
  }
  return client;
}
