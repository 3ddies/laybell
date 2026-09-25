import { supabase } from './supabase';

// "Who viewed your profile" (profile_views.sql) — TikTok-style, opt-in + reciprocal.
// All access is through the definer RPCs; the client never reads the table directly.

export type ProfileViewer = {
  viewer_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  badge_tier: string | null;
  badge_show: boolean | null;
  viewed_at: string;
};

// Record that the signed-in user viewed `target`. Fire-and-forget: the RPC no-ops
// for self, for a viewer who hasn't opted in, and across a block.
export async function recordProfileView(target: string): Promise<void> {
  try { await supabase.rpc('record_profile_view', { target }); } catch { /* best effort */ }
}

// The viewers of the signed-in user's own profile (empty unless they've opted in).
export async function fetchProfileViewers(max = 100): Promise<ProfileViewer[]> {
  const { data, error } = await supabase.rpc('get_profile_viewers', { max_rows: max });
  if (error || !Array.isArray(data)) return [];
  return data as ProfileViewer[];
}

// Count for the eye-icon badge (0 unless opted in).
export async function fetchProfileViewersCount(): Promise<number> {
  const { data, error } = await supabase.rpc('get_profile_viewers_count');
  if (error || typeof data !== 'number') return 0;
  return data;
}

// The one reciprocity toggle: on = you see your viewers AND you appear in others'
// history. Turning off purges your outgoing views so you vanish everywhere.
export async function setProfileViewsEnabled(on: boolean): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase.from('profiles').update({ profile_views_enabled: on }).eq('id', user.id);
  if (error) return false;
  if (!on) { try { await supabase.rpc('clear_my_profile_views'); } catch { /* best effort */ } }
  return true;
}
