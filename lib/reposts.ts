import { supabase } from './supabase';

// Repost actions backing the global "Repost" option and the profile Reposts tab.
// All functions degrade gracefully if the `reposts` table hasn't been migrated
// yet (see supabase/sql/reposts.sql) — they just return false.

export async function isReposted(postId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('reposts').select('id').eq('user_id', userId).eq('post_id', postId).maybeSingle();
  if (error) return false;
  return !!data;
}

export async function addRepost(postId: string, userId: string): Promise<boolean> {
  const { error } = await supabase.from('reposts').insert({ user_id: userId, post_id: postId });
  return !error;
}

export async function removeRepost(postId: string, userId: string): Promise<boolean> {
  const { error } = await supabase.from('reposts').delete().eq('user_id', userId).eq('post_id', postId);
  return !error;
}
