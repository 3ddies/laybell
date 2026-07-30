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
  // A shop buy-offer. It names the sender and stops there, ON PURPOSE: the
  // amount someone is willing to pay for a beat is between the two of them, and
  // a lock screen is read by whoever is holding the phone. The figure lives on
  // the offer card inside the thread, which is also where it can be answered.
  offer:      name => `${name} sent you an offer.`,
};

serve(async (req) => {
  try {
    const { userId, type, postId } = await req.json();

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── Authorization ────────────────────────────────────────────────────────
    // This function sends with the service role, so it must not trust the body.
    // It previously took `actorId` from the request, which let any signed-in
    // user push an arbitrary notification to any other user while impersonating
    // anyone. Two checks now stand in the way:
    //
    //   1. The actor is the VERIFIED caller, never a body field.
    //   2. A matching `notifications` row must already exist. createNotification
    //      inserts that row (under RLS) and awaits it before invoking us, so the
    //      push can only ever mirror a notification the caller was allowed to
    //      create. Without this, an authenticated user could still spam pushes
    //      truthfully attributed to themselves.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return new Response('Unauthorized', { status: 401 });

    const { data: caller, error: authErr } = await supabase.auth.getUser(token);
    const actorId = caller?.user?.id;
    if (authErr || !actorId) return new Response('Unauthorized', { status: 401 });

    if (typeof userId !== 'string' || !userId) return new Response('Bad request', { status: 400 });
    if (userId === actorId) return new Response('OK', { status: 200 }); // never self-notify
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, type)) {
      return new Response('Bad request', { status: 400 });
    }

    const { data: row } = await supabase
      .from('notifications')
      .select('id')
      .eq('user_id', userId)
      .eq('actor_id', actorId)
      .eq('type', type)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row) return new Response('No matching notification', { status: 403 });
    // ─────────────────────────────────────────────────────────────────────────

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
