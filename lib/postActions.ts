import { Alert } from 'react-native';
import { supabase } from './supabase';

// Shared post-management actions so the "⋯" options button behaves identically
// everywhere a post appears (home, explore, music, profile, detail…):
//   • your own post     → Edit / Delete
//   • someone else's    → Report

export async function deletePostById(postId: string): Promise<boolean> {
  const { error } = await supabase.from('posts').delete().eq('id', postId);
  return !error;
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

// Unified options menu opened by the "⋯" button. Own posts get Edit/Delete;
// others' posts go straight to the report confirm.
export function showPostOptions(opts: {
  postId: string;
  isOwn: boolean;
  onEdit?: () => void;
  onDeleted?: () => void;
}) {
  const { postId, isOwn, onEdit, onDeleted } = opts;
  if (!isOwn) {
    reportPost(postId);
    return;
  }
  Alert.alert('Post options', undefined, [
    { text: 'Edit post', onPress: () => onEdit?.() },
    { text: 'Delete post', style: 'destructive', onPress: () => confirmDeletePost(postId, onDeleted) },
    { text: 'Cancel', style: 'cancel' },
  ]);
}
