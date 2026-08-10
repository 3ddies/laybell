import { Alert } from 'react-native';
import { supabase } from './supabase';
import { logAccess } from './accessLog';
import { collectPostMediaUrls, removePublicUrls } from './storageCleanup';
import { deleteStreamVideo } from './streamUpload';
import { isPostSpotlighted } from './spotlight';
import { tg } from './i18n';

export async function deletePostById(postId: string): Promise<boolean> {
  // Capture media URLs (and the Cloudflare Stream uid) BEFORE deleting the row so
  // we can also clean up the public Storage objects and the Stream asset (the DB
  // delete only removes the row). Best-effort — the profile-delete trigger in
  // storage_cleanup.sql is the backstop, and the per-user Storage DELETE policy
  // from that same migration is what lets this run.
  let media: string[] = [];
  let videoUid: string | null = null;
  try {
    // legacy_media_url = the pre-backfill Storage MP4 (stream_backfill.sql).
    // Selecting a missing column errors the whole select, so if that migration
    // hasn't run yet, retry without it rather than skipping cleanup entirely.
    let { data } = await supabase
      .from('posts')
      .select('media_url, thumbnail_url, cover_url, slides, video_uid, legacy_media_url')
      .eq('id', postId)
      .single();
    if (!data) {
      ({ data } = await supabase
        .from('posts')
        .select('media_url, thumbnail_url, cover_url, slides, video_uid')
        .eq('id', postId)
        .single() as any);
    }
    if (data) { media = collectPostMediaUrls(data); videoUid = (data as any).video_uid ?? null; }
  } catch {}
  // `.select('id')` so we can tell a real delete from a no-op: an RLS-blocked
  // delete (e.g. the posts DELETE policy is missing — supabase/sql/posts_delete_policy.sql)
  // removes 0 rows with NO error. Without this check we'd report phantom success
  // AND wipe the post's Storage media while its row survived in the DB.
  const { data, error } = await supabase.from('posts').delete().eq('id', postId).select('id');
  if (error || !data?.length) return false;
  if (media.length) await removePublicUrls(media);
  // Video posts on Cloudflare Stream: delete the CDN asset so it stops costing
  // storage. Ownership is enforced server-side; fire-and-forget so the delete stays
  // snappy (best-effort cleanup, never throws).
  if (videoUid) deleteStreamVideo(videoUid);
  return true;
}

// ── Themed delete/archive confirm bridge ─────────────────────────────────────
// The themed PostConfirm dialog (contexts/PostConfirmContext) registers its opener
// here, so the imperative confirmDeletePost/confirmArchivePost callers (the 3-dot
// menu, long-press, the archive screen) stay unchanged while the confirm is a real
// in-app card instead of a system Alert. Falls back to Alert if not mounted.
export type PostConfirmRequest = {
  kind: 'delete' | 'archive';
  postId: string;
  spotlighted: boolean;
  onDone?: () => void;
};
let postConfirmHandler: ((req: PostConfirmRequest) => void) | null = null;
export function setPostConfirmHandler(fn: ((req: PostConfirmRequest) => void) | null) { postConfirmHandler = fn; }

// Archiving hides a post from your profile/feed/explore without deleting it.
// `archived_at` is set to now (archive) or cleared to null (restore). Requires
// the posts.archived_at column (supabase/sql/post_archive.sql) AND the owner
// UPDATE policy (supabase/sql/posts_update_policy.sql).
//
// We `.select('id')` and require a returned row, NOT just `!error`: an UPDATE
// that RLS blocks (e.g. the posts UPDATE policy is missing) comes back with no
// error and ZERO rows. Without this check that phantom success would hide the
// post optimistically only for it to reappear on the next refresh.
export async function archivePostById(postId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('posts')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', postId)
    .select('id');
  return !error && (data?.length ?? 0) > 0;
}

export async function restorePostById(postId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('posts')
    .update({ archived_at: null })
    .eq('id', postId)
    .select('id');
  return !error && (data?.length ?? 0) > 0;
}

// Confirm, archive, then fire onArchived so the caller can drop it from view.
// If the post has a LIVE spotlight, the confirm escalates: archiving only hides
// the post (sets archived_at) — it does NOT touch the campaign, whose ends_at is
// fixed wall-clock, so the timer keeps running while the post is hidden from the
// feed. The owner burns paid promotion time with no pause and no refund, so they
// are warned before committing. The spotlight check degrades to the normal copy.
export async function confirmArchivePost(postId: string, onArchived?: () => void) {
  const spotlighted = await isPostSpotlighted(postId);
  if (postConfirmHandler) { postConfirmHandler({ kind: 'archive', postId, spotlighted, onDone: onArchived }); return; }
  Alert.alert(
    spotlighted ? tg('postAction.archiveTitleSpot') : tg('postAction.archiveTitle'),
    spotlighted ? tg('postAction.archiveBodySpot') : tg('postAction.archiveBody'),
    [
      { text: tg('common.cancel'), style: 'cancel' },
      {
        text: tg('postAction.archiveBtn'),
        onPress: async () => {
          const ok = await archivePostById(postId);
          if (ok) onArchived?.();
          else Alert.alert(tg('common.error'), tg('postAction.archiveError'));
        },
      },
    ],
  );
}

// Destructive confirm, then delete, then fire onDeleted so the caller can drop
// it from local state. Also used directly for long-press affordances. If the
// post has a LIVE spotlight, the confirm escalates: deleting cascades the paid
// campaign away with no refund (see isPostSpotlighted), so the user is told
// before they commit. The spotlight check degrades to the normal copy on error.
export async function confirmDeletePost(postId: string, onDeleted?: () => void) {
  const spotlighted = await isPostSpotlighted(postId);
  if (postConfirmHandler) { postConfirmHandler({ kind: 'delete', postId, spotlighted, onDone: onDeleted }); return; }
  Alert.alert(
    spotlighted ? tg('postAction.deleteTitleSpot') : tg('postAction.deleteTitle'),
    spotlighted ? tg('postAction.deleteBodySpot') : tg('postAction.deleteBody'),
    [
      { text: tg('common.cancel'), style: 'cancel' },
      {
        text: tg('common.delete'),
        style: 'destructive',
        onPress: async () => {
          const ok = await deletePostById(postId);
          if (ok) onDeleted?.();
          else Alert.alert(tg('common.error'), tg('postAction.deleteError'));
        },
      },
    ],
  );
}

// Records a report. Silently no-ops if the post_reports table isn't migrated yet
// (the user still gets an acknowledgement either way).
export async function submitReport(postId: string, reason = 'other') {
  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from('post_reports').insert({
    post_id: postId, reporter_id: user?.id ?? null, reason,
  });
  // Server-captured IP for the reporting session. On a CSAM report this is part
  // of what makes a CyberTipline filing actionable — see docs/CSAM_RESPONSE_RUNBOOK.md.
  logAccess('report', 'post', postId);
}

// ── Report sheet bridge ──────────────────────────────────────────────────────
// The themed report sheet (contexts/ReportContext) registers its opener here, so
// the imperative reportPost/reportUser callers (the 3-dot menu, the story viewer)
// can stay unchanged while the UI is a real in-app sheet instead of an Alert.
export type ReportRequest = { kind: 'post' | 'user' | 'conversation' | 'listing' | 'community'; targetId: string; onClose?: () => void };
let reportHandler: ((req: ReportRequest) => void) | null = null;
export function setReportHandler(fn: ((req: ReportRequest) => void) | null) { reportHandler = fn; }

export function reportPost(postId: string) {
  if (reportHandler) { reportHandler({ kind: 'post', targetId: postId }); return; }
  // Fallback (provider not mounted yet) — keep reporting functional.
  Alert.alert(tg('postOptions.reportPost'), tg('postAction.reportPostBody'), [
    { text: tg('common.cancel'), style: 'cancel' },
    { text: tg('postAction.reportOther'), style: 'destructive', onPress: async () => {
      await submitReport(postId, 'other');
      Alert.alert(tg('postAction.reportThanksTitle'), tg('postAction.reportPostThanks'));
    } },
  ]);
}

// Records a user report. Silently no-ops if user_reports isn't migrated yet.
export async function submitUserReport(userId: string, reason = 'other') {
  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from('user_reports').insert({
    reported_id: userId, reporter_id: user?.id ?? null, reason,
  });
  logAccess('report', 'user', userId);
}

// Records a shop-listing report (scams, stolen content, prohibited material).
// Snapshots the seller so the report survives listing deletion. Silently no-ops
// if shop_reports isn't migrated yet.
export async function submitListingReport(listingId: string, reason = 'other') {
  const { data: { user } } = await supabase.auth.getUser();
  const { data: l } = await supabase.from('shop_listings').select('user_id').eq('id', listingId).maybeSingle();
  await supabase.from('shop_reports').insert({
    listing_id: listingId, seller_id: (l as { user_id?: string } | null)?.user_id ?? null,
    reporter_id: user?.id ?? null, reason,
  });
}

// Report a shop listing through the themed report sheet (same UX as post/user).
export function reportListing(listingId: string) {
  if (reportHandler) { reportHandler({ kind: 'listing', targetId: listingId }); return; }
  submitListingReport(listingId).catch(() => {});
}

// Records a group-conversation report. Silently no-ops if conversation_reports
// isn't migrated yet.
export async function submitConversationReport(conversationId: string, reason = 'other') {
  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from('conversation_reports').insert({
    conversation_id: conversationId, reporter_id: user?.id ?? null, reason,
  });
}

// Report a group chat through the themed report sheet (same UX as post/user).
export function reportConversation(conversationId: string, onDone?: () => void) {
  if (reportHandler) { reportHandler({ kind: 'conversation', targetId: conversationId, onClose: onDone }); return; }
  Alert.alert(tg('chat.reportChatTitle'), tg('chat.reportChatBody'), [
    { text: tg('common.cancel'), style: 'cancel', onPress: onDone },
    { text: tg('chat.report'), style: 'destructive', onPress: async () => {
      await submitConversationReport(conversationId, 'other');
      onDone?.();
      Alert.alert(tg('chat.reportThanksTitle'), tg('chat.reportThanksBody'));
    } },
  ]);
}

// Records a community report. Silently no-ops if community_reports isn't
// migrated yet — same degradation as the other report kinds, so the button is
// never a dead end even on a database that predates the table.
export async function submitCommunityReport(communityId: string, reason = 'other') {
  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from('community_reports').insert({
    community_id: communityId, reporter_id: user?.id ?? null, reason,
  });
}

// Report a community through the themed report sheet (same UX as post/user).
export function reportCommunity(communityId: string, onDone?: () => void) {
  if (reportHandler) { reportHandler({ kind: 'community', targetId: communityId, onClose: onDone }); return; }
  Alert.alert(tg('report.titleCommunity'), tg('communities.reportBody'), [
    { text: tg('common.cancel'), style: 'cancel', onPress: onDone },
    { text: tg('postAction.reportOther'), style: 'destructive', onPress: async () => {
      await submitCommunityReport(communityId, 'other');
      onDone?.();
      Alert.alert(tg('postAction.reportThanksTitle'), tg('communities.reportThanks'));
    } },
  ]);
}

// `onDone` (optional) fires after Cancel or after the report completes — used by
// the story viewer to resume playback once the dialog is dismissed.
export function reportUser(userId: string, onDone?: () => void) {
  if (reportHandler) { reportHandler({ kind: 'user', targetId: userId, onClose: onDone }); return; }
  Alert.alert(tg('postOptions.reportUser'), tg('postAction.reportUserBody'), [
    { text: tg('common.cancel'), style: 'cancel', onPress: onDone },
    { text: tg('postAction.reportOther'), style: 'destructive', onPress: async () => {
      await submitUserReport(userId, 'other');
      onDone?.();
      Alert.alert(tg('postAction.reportThanksTitle'), tg('postAction.reportUserThanks'));
    } },
  ]);
}

