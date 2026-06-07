import { Alert } from 'react-native';
import { supabase } from './supabase';

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

