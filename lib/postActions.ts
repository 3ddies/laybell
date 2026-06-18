import { Alert } from 'react-native';
import { supabase } from './supabase';
import { collectPostMediaUrls, removePublicUrls } from './storageCleanup';

export async function deletePostById(postId: string): Promise<boolean> {
  // Capture media URLs BEFORE deleting the row so we can also clean up the
  // public Storage objects (the DB delete only removes the row). Best-effort —
  // the profile-delete trigger in storage_cleanup.sql is the backstop, and the
  // per-user Storage DELETE policy from that same migration is what lets this run.
  let media: string[] = [];
  try {
    const { data } = await supabase
      .from('posts')
      .select('media_url, thumbnail_url, cover_url, slides')
      .eq('id', postId)
      .single();
    if (data) media = collectPostMediaUrls(data);
  } catch {}
  const { error } = await supabase.from('posts').delete().eq('id', postId);
  if (error) return false;
  if (media.length) await removePublicUrls(media);
  return true;
}

// Archiving hides a post from your profile/feed/explore without deleting it.
// `archived_at` is set to now (archive) or cleared to null (restore). Requires
// the posts.archived_at column (supabase/sql/post_archive.sql); if it isn't
// migrated yet the write errors and we report failure so the caller can alert.
export async function archivePostById(postId: string): Promise<boolean> {
  const { error } = await supabase
    .from('posts')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', postId);
  return !error;
}

export async function restorePostById(postId: string): Promise<boolean> {
  const { error } = await supabase
    .from('posts')
    .update({ archived_at: null })
    .eq('id', postId);
  return !error;
}

// Confirm, archive, then fire onArchived so the caller can drop it from view.
export function confirmArchivePost(postId: string, onArchived?: () => void) {
  Alert.alert(
    'Archive post?',
    'This hides the post from your profile, the feed and explore. You can restore it anytime from Settings → Archive.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive',
        onPress: async () => {
          const ok = await archivePostById(postId);
          if (ok) onArchived?.();
          else Alert.alert('Error', 'Could not archive the post. Please try again.');
        },
      },
    ],
  );
}

// Two-step destructive confirm, then delete, then fire onDeleted so the caller
// can drop it from local state. Also used directly for long-press affordances.
export function confirmDeletePost(postId: string, onDeleted?: () => void) {
  Alert.alert(
    'Delete post?',
    "This permanently deletes the post and can't be undone.",
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const ok = await deletePostById(postId);
          if (ok) onDeleted?.();
          else Alert.alert('Error', 'Could not delete the post. Please try again.');
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
}

export function reportPost(postId: string) {
  Alert.alert('Report post', 'Report this post for our team to review?', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Report',
      style: 'destructive',
      onPress: async () => {
        await submitReport(postId);
        Alert.alert('Thanks for the report', 'Our team will review this post.');
      },
    },
  ]);
}

// Records a user report. Silently no-ops if user_reports isn't migrated yet.
export async function submitUserReport(userId: string, reason = 'other') {
  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from('user_reports').insert({
    reported_id: userId, reporter_id: user?.id ?? null, reason,
  });
}

// `onDone` (optional) fires after Cancel or after the report completes — used by
// the story viewer to resume playback once the dialog is dismissed.
export function reportUser(userId: string, onDone?: () => void) {
  Alert.alert('Report user', 'Report this account for our team to review?', [
    { text: 'Cancel', style: 'cancel', onPress: onDone },
    {
      text: 'Report',
      style: 'destructive',
      onPress: async () => {
        await submitUserReport(userId);
        onDone?.();
        Alert.alert('Thanks for the report', 'Our team will review this account.');
      },
    },
  ]);
}

