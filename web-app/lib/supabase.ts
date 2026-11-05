import { createClient } from '@supabase/supabase-js';

// PUBLIC anon key — the same one already shipped in the mobile app bundle. It is
// read-only and RLS applies to every query. A service key must NEVER appear here:
// this code runs where anyone can read it, and the web surface is public.
export const SUPABASE_URL = 'https://wawpaokvtptfmuygjnns.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indhd3Bhb2t2dHB0Zm11eWdqbm5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MDgyNjMsImV4cCI6MjA5NTQ4NDI2M30.78PkYUy1rnoGUvqKSF85QWqbFQF9Kfy2PV3Fzs0nPZY';

// A fresh client per request (no session persistence — Tier 1 is anonymous reads).
export function sb() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── The two guards RLS does NOT enforce (see docs/WEB_APP_PLAN.md §2) ──────────
// profiles.hidden is world-readable, and archived_at is not filtered by policy.
// Every public page applies BOTH itself. Mature posts are excluded from web
// entirely (an anonymous page has no age signal).
export function isVisibleProfile(p: { hidden?: boolean | null } | null): boolean {
  return !!p && p.hidden !== true;
}
