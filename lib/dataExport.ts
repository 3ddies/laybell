import { supabase } from './supabase';

// Assembles a portable copy of the signed-in user's own data — the practical
// implementation of the GDPR Article 20 (data portability) and CCPA "right to
// know/access" promises in our Privacy Policy. It reads only rows the user can
// already see under RLS, and each table is best-effort so a missing or renamed
// table is simply skipped rather than failing the whole export.
export async function buildDataExport(): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('You must be signed in to export your data.');
  const uid = user.id;

  const out: Record<string, any> = {
    export_generated_for: { id: uid, email: user.email },
    generated_note:
      'This is a machine-readable copy of the personal data associated with your Laybell account. ' +
      'Aggregate counters and other users\' content are not included. Contact privacy@laybell.app with questions.',
  };

  async function grab(label: string, query: any) {
    try {
      const { data, error } = await query;
      if (!error && data !== undefined) out[label] = data;
    } catch {
      /* table not present / not readable — skip */
    }
  }

  await grab('profile', supabase.from('profiles').select('*').eq('id', uid).single());
  await grab('posts', supabase.from('posts').select('*').eq('user_id', uid));
  await grab('stories', supabase.from('stories').select('*').eq('user_id', uid));
  await grab('comments', supabase.from('comments').select('*').eq('user_id', uid));
  await grab('playlists', supabase.from('playlists').select('*').eq('user_id', uid));
  await grab('following', supabase.from('follows').select('*').eq('follower_id', uid));
  await grab('followers', supabase.from('follows').select('*').eq('following_id', uid));

  return JSON.stringify(out, null, 2);
}
