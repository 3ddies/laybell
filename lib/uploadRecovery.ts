import { supabase } from './supabase';
import { loadDrafts, deleteDraft, patchDraft, type Draft } from './drafts';
import { pollStreamReady } from './streamUpload';

// Boot-time reconciliation for uploads a previous session never finished.
//
// The failure this kills: upload completes → the posts row is INSERTED with
// video_status='processing' → the app babysits Cloudflare's encode → the user
// exits. Nothing ever flips the row to ready, and the feed renders a real post
// whose video doesn't exist yet — a black rectangle wearing a rotate hint.
//
// Every video Share writes a crash-insurance draft flagged pendingUpload, and
// the queue stamps it with the row id once the insert lands. So at boot the
// flagged draft tells us exactly which of three worlds we're in:
//
//   1. Row exists and is READY   → everything actually finished; tidy up.
//   2. Row exists, still processing → ADOPT it: babysit the encode from this
//      session, flip it ready (or delete the corpse and offer a resume).
//   3. No row                    → the upload never landed; offer a one-tap
//      resume (the draft has the whole post; tus continues from the server's
//      byte offset for films).
export type RecoveryResult =
  | { kind: 'resume'; draft: Draft }   // ask the user; Resume opens the composer pre-filled
  | { kind: 'healed'; postId: string } // a stranded post finished — tell the user it's live
  | null;                              // nothing to do (or offline — retry next boot)

export async function reconcileInterruptedUpload(): Promise<RecoveryResult> {
  const drafts = await loadDrafts();
  const pending = drafts.filter((d) => d.pendingUpload);
  if (!pending.length) return null;

  // One prompt per boot: the newest interruption is the one the user remembers.
  // Older flags demote to ordinary drafts rather than queueing up nag dialogs.
  pending.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const d of pending.slice(1)) await patchDraft(d.id, { pendingUpload: false });
  const d = pending[0];

  if (d.postedId) {
    const { data: row, error } = await supabase
      .from('posts').select('id, video_status, video_uid')
      .eq('id', d.postedId).maybeSingle();
    // Offline / transient: change nothing, try again next boot.
    if (error) return null;

    if (row) {
      if (row.video_status === 'ready') {
        await deleteDraft(d.id);
        return null;
      }
      // World 2: adopt the stranded encode. Budget mirrors the queue's rule of
      // thumb (~1.5s per source second) with the same 10-minute floor a film
      // deserves — by boot time Cloudflare has usually long finished.
      const uid = (row.video_uid as string) ?? d.postedUid ?? '';
      const poll = uid
        ? await pollStreamReady(uid, Math.max(600_000, Math.round((d.videoDuration || 0) * 1500)), undefined, 10_000)
        : { ready: false, errored: true, reason: null };
      if (poll.ready) {
        await supabase.from('posts').update({ video_status: 'ready' }).eq('id', row.id).then(undefined, () => {});
        await deleteDraft(d.id);
        return { kind: 'healed', postId: row.id as string };
      }
      // Still not ready but NOT errored → the encode may yet land. Leave
      // everything in place; the next boot (or the feed's processing cover)
      // picks it up. Only a DEAD encode removes the row.
      if (!poll.errored) return null;
      // Encode is dead. Remove the black-video corpse (the delete trigger
      // queues its Cloudflare asset for reaping) and fall through to resume.
      await supabase.from('posts').delete().eq('id', row.id).then(undefined, () => {});
    }
    // World 3 via rollback — the stamped row no longer exists.
    await patchDraft(d.id, { postedId: undefined, postedUid: undefined });
  }
  return { kind: 'resume', draft: d };
}

// "Not now" on the resume prompt: stop asking at boot, but keep the post as a
// perfectly ordinary draft the user can reopen whenever they want.
export async function dismissRecovery(draftId: string): Promise<void> {
  await patchDraft(draftId, { pendingUpload: false });
}
