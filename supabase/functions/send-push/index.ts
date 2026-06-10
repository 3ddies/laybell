import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MESSAGES: Record<string, (name: string) => { title: string; body: string }> = {
  like:       name => ({ title: '❤️ New Like',      body: `${name} liked your post` }),
  comment:    name => ({ title: '💬 New Comment',   body: `${name} commented on your post` }),
  follow:     name => ({ title: '🔔 New Follower',  body: `${name} started following you` }),
  mention:    name => ({ title: '🏷️ Mentioned',    body: `${name} mentioned you` }),
  tag:        name => ({ title: '🏷️ Tagged',       body: `${name} tagged you in a post` }),
  song_used:  name => ({ title: '🎵 Your audio',    body: `${name} used your audio in a post` }),
  song_story: name => ({ title: '🎵 Your audio',    body: `${name} used your audio in their story` }),
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
      supabase.from('profiles').select('display_name').eq('id', actorId).single(),
    ]);

    if (!tokenData?.token) return new Response('No token', { status: 200 });

    const actorName = actor?.display_name ?? 'Someone';
    const msgFn = MESSAGES[type] ?? ((n: string) => ({ title: 'Laybell', body: `${n} interacted with you` }));
    const { title, body } = msgFn(actorName);

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: tokenData.token,
        title,
        body,
        sound: 'default',
        data: { type, postId },
      }),
    });

    return new Response('OK', { status: 200 });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
});
