import { Alert } from 'react-native';
import { supabase } from './supabase';

// User blocking. Schema + RLS live in supabase/sql/blocks.sql.
// One row per (blocker, blocked). Blocking is one-directional and enforced
// client-side: a blocked user's posts are filtered out of your home feed and
// explore, and you can review / undo blocks in Settings → Blocked.

export type BlockedUser = {
  blocked_id: string;
  created_at: string;
  profile?: {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
  };
};

export async function blockUser(blockedId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id === blockedId) return false;
  const { error } = await supabase
    .from('blocks')
    .insert({ blocker_id: user.id, blocked_id: blockedId });
  // 23505 = unique_violation — already blocked, treat as success.
  return !error || error.code === '23505';
}

export async function unblockUser(blockedId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { error } = await supabase
    .from('blocks')
    .delete()
    .eq('blocker_id', user.id)
    .eq('blocked_id', blockedId);
  return !error;
}

export async function isBlocked(blockedId: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase
    .from('blocks')
    .select('blocked_id')
    .eq('blocker_id', user.id)
    .eq('blocked_id', blockedId)
    .maybeSingle();
  return !!data;
}

// The set of user ids the current user has blocked — for filtering content
// client-side. Returns an empty set if the blocks table isn't set up yet.
export async function fetchBlockedIds(): Promise<Set<string>> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Set();
  const { data } = await supabase
    .from('blocks')
    .select('blocked_id')
    .eq('blocker_id', user.id);
  return new Set((data ?? []).map((b: any) => b.blocked_id as string));
}

// The Blocked list: each block joined to the blocked user's profile (manual join
// because blocks.blocked_id references auth.users, not profiles).
export async function fetchBlockedUsers(): Promise<BlockedUser[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data: blocks } = await supabase
    .from('blocks')
    .select('blocked_id, created_at')
    .eq('blocker_id', user.id)
    .order('created_at', { ascending: false });
  if (!blocks || blocks.length === 0) return [];

  const ids = blocks.map((b: any) => b.blocked_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', ids);
  const byId = new Map<string, any>((profiles ?? []).map((p: any) => [p.id, p]));

  return (blocks as any[]).map((b) => ({ ...b, profile: byId.get(b.blocked_id) }));
}

// Confirm + block, then fire onBlocked so the caller can drop their content.
export function confirmBlockUser(
  userId: string,
  username: string | undefined,
  onBlocked?: () => void,
) {
  const handle = username ? `@${username}` : 'this user';
  Alert.alert(
    `Block ${handle}?`,
    `You won't see ${handle}'s posts in your feed or explore. You can unblock them anytime from Settings → Blocked.`,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block',
        style: 'destructive',
        onPress: async () => {
          const ok = await blockUser(userId);
          if (ok) onBlocked?.();
          else Alert.alert('Error', 'Could not block this user. Please try again.');
        },
      },
    ],
  );
}
