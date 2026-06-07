import { Alert } from 'react-native';
import { supabase } from './supabase';

// Shared post-management actions so "delete my post" behaves identically
// everywhere a self-post can appear (home, explore, music, profile, detail…).

export async function deletePostById(postId: string): Promise<boolean> {
  const { error } = await supabase.from('posts').delete().eq('id', postId);
  return !error;
}

// Two-step destructive confirm, then delete, then fire onDeleted so the caller
// can drop it from local state. Use this directly for long-press affordances.
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

// "Post options" action sheet (Delete post / Cancel) — for explicit "…" buttons.
export function showOwnPostOptions(postId: string, onDeleted?: () => void) {
  Alert.alert('Post options', undefined, [
    { text: 'Delete post', style: 'destructive', onPress: () => confirmDeletePost(postId, onDeleted) },
    { text: 'Cancel', style: 'cancel' },
  ]);
}
