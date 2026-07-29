import { supabase } from './supabase';

// "Use this sound" consent — the client side of supabase/sql/sound_optin.sql.
//
// Attaching audio to a video is SYNCHRONISATION, a right no performing-rights
// licence covers. Laybell's only basis for it is the licence the uploader grants,
// so that grant needs to be specific and revocable rather than buried in the
// Terms. This module is the specific half.

/**
 * What the "Let others use this sound" toggle starts as for a new audio post.
 *
 * ⚠️ THIS IS A POLICY DECISION, NOT A TECHNICAL ONE — it is the one line in this
 * feature worth a deliberate choice.
 *
 *   true  — the sound is shareable unless the creator turns it off. The feature
 *           works as users expect and the catalogue stays useful. The consent is
 *           still explicit in the sense that the toggle is visible and labelled at
 *           upload, but it is an opt-OUT.
 *
 *   false — nothing is shareable until the creator says so. Strongest possible
 *           consent posture, and the safest reading of "explicit opt-in". Costs
 *           reach: most uploaders will never notice the toggle, so the picker
 *           stays largely empty.
 *
 * Shipping `true` with a visible, plainly-worded toggle and a per-track timestamp.
 * Flip to `false` if you want the conservative posture — nothing else changes.
 */
export const DEFAULT_SOUND_OPT_IN = true;

export type SoundConsent = {
  optIn: boolean;
  withdrawnAt: string | null;
};

/** Is this audio currently available for others to attach? */
export function soundIsAvailable(c: Partial<SoundConsent> | null | undefined): boolean {
  if (!c) return false;
  return c.optIn === true && !c.withdrawnAt;
}

/**
 * Pull a sound back. Removes it from the picker AND strips the attribution from
 * every post and story that used it — which is what makes the borrowed audio stop
 * playing, since a video is muted only while a song is attached to it.
 *
 * Returns how many posts were affected so the UI can say so plainly. The creator
 * is about to change other people's content; they deserve to know the scale.
 */
export async function withdrawSound(
  postId: string,
): Promise<{ ok: boolean; postsUpdated: number; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('withdraw_sound', { p_post_id: postId });
    if (error) return { ok: false, postsUpdated: 0, error: error.message };
    return { ok: true, postsUpdated: Number((data as any)?.posts_updated ?? 0) };
  } catch (e: any) {
    return { ok: false, postsUpdated: 0, error: e?.message ?? 'failed' };
  }
}

/**
 * Put a sound back in the picker. Deliberately does NOT restore attributions that
 * were already stripped — silently re-attaching audio to someone else's post,
 * without asking them, is not a thing a withdrawal should be able to undo.
 */
export async function allowSound(postId: string): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('allow_sound', { p_post_id: postId });
    return !error;
  } catch {
    return false;
  }
}
