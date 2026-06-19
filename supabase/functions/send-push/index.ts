import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Every Laybell push uses "Laybell" as the title (set below). The body is the
// actor's @handle + what they did, e.g. "@johndoe liked your post."
const ACTIONS: Record<string, (name: string) => string> = {
  like:       name => `${name} liked your post.`,
  comment:    name => `${name} commented on your post.`,
  follow:     name => `${name} started following you.`,
  friend:     name => `${name} added you as a friend.`,
  message:    name => `${name} sent you a message.`,
  mention:    name => `${name} mentioned you.`,
  tag:        name => `${name} tagged you in a post.`,
  song_used:  name => `${name} used your audio in a post.`,
  song_story: name => `${name} used your audio in their story.`,
};

serve(async (req) => {
  try {
    const { userId, actorId, type, postId } = await req.json();

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const [{ data: tokenData }, { data: actor }] = await Promise.all([
      supabase.from('push_tokens').select('token').eq('user_id', userId).single(),
      supabase.from('profiles').select('username, display_name').eq('id', actorId).single(),
    ]);

    if (!tokenData?.token) return new Response('No token', { status: 200 });

    // Prefer the unique @handle; fall back to display name, then a generic.
    const name = actor?.username
      ? `@${actor.username}`
      : (actor?.display_name ?? 'Someone');
    const bodyFn = ACTIONS[type] ?? ((n: string) => `${n} interacted with you.`);

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: tokenData.token,
        title: 'Laybell',
        body: bodyFn(name),
        sound: 'default',
        data: { type, postId },
      }),
    });

    return new Response('OK', { status: 200 });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
});
