import { supabase } from './supabase';

export async function createNotification({
  userId,
  actorId,
  type,
  postId = null,
}: {
  userId: string;
  actorId: string;
  type: 'like' | 'comment' | 'follow' | 'friend' | 'message' | 'mention' | 'song_used' | 'song_story' | 'tag';
  postId?: string | null;
}) {
  if (userId === actorId) return; // Never notify yourself

  const { error } = await supabase.from('notifications').insert({
    user_id: userId,
    actor_id: actorId,
    type,
    post_id: postId,
  });

  if (error) {
    console.error('notification insert:', error.message);
    return;
  }

  // Fire-and-forget push via Edge Function — won't block the UI
  supabase.functions
    .invoke('send-push', { body: { userId, actorId, type, postId } })
    .catch(err => console.log('push fn:', err.message));
}
