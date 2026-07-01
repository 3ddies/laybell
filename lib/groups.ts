// Group chats — data layer. Groups live alongside 1:1 DMs: a `conversations` row
// with N `conversation_members`, whose messages are ordinary `messages` rows
// carrying a `conversation_id` (and a null receiver_id). See group_chats.sql.

import { supabase } from './supabase';

export const MAX_GROUP_MEMBERS = 20; // includes the creator

export type GroupProfile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  badge_tier?: string | null;
  badge_show?: boolean | null;
};

export type GroupListItem = {
  id: string;                 // conversation id
  title: string | null;      // custom group name, or null → derive from members
  avatar_url: string | null;
  created_by: string | null;
  updated_at: string;
  members: GroupProfile[];   // everyone (including me)
  last_message: string;
  last_message_time: string;
  last_sender_id: string | null;
  unread: number;
  bodies: string[];          // plain bodies, for keyword search
};

// A readable group name: the custom title, else the other members' first names.
export function groupTitle(members: GroupProfile[], myId: string | null, title?: string | null): string {
  if (title && title.trim()) return title.trim();
  const others = members.filter(m => m.id !== myId);
  const names = others.map(m => (m.display_name || m.username || '').split(' ')[0]).filter(Boolean);
  if (names.length === 0) return 'Group';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

// Create a group with `title` and `memberIds` (the creator is added automatically).
// Returns the new conversation id, or null on failure.
export async function createGroup(title: string, memberIds: string[]): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: conv, error } = await supabase
    .from('conversations')
    .insert({ title: title.trim() || null, created_by: user.id })
    .select('id')
    .single();
  if (error || !conv) return null;
  const uniqueIds = Array.from(new Set([user.id, ...memberIds])).slice(0, MAX_GROUP_MEMBERS);
  const rows = uniqueIds.map(uid => ({ conversation_id: conv.id, user_id: uid, added_by: user.id }));
  const { error: memErr } = await supabase.from('conversation_members').insert(rows);
  if (memErr) return null;
  return conv.id as string;
}

// Find a group whose member set is EXACTLY {me} ∪ memberIds (order-independent),
// so picking the same people twice reopens the existing chat instead of making a
// duplicate. Returns the conversation id, or null if there's no exact match.
export async function findExistingGroup(memberIds: string[]): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const target = new Set([user.id, ...memberIds]);

  const { data: mine } = await supabase
    .from('conversation_members').select('conversation_id').eq('user_id', user.id);
  if (!mine?.length) return null;

  const convIds = mine.map(m => m.conversation_id);
  const { data: rows } = await supabase
    .from('conversation_members').select('conversation_id, user_id').in('conversation_id', convIds);
  if (!rows) return null;

  const byConv: Record<string, Set<string>> = {};
  for (const r of rows) (byConv[r.conversation_id] ||= new Set()).add(r.user_id);
  for (const [cid, set] of Object.entries(byConv)) {
    if (set.size === target.size && [...target].every(id => set.has(id))) return cid;
  }
  return null;
}

// Every group the user belongs to, hydrated with members, last message + unread,
// newest activity first. Used by the messages list.
export async function fetchGroupConversations(userId: string): Promise<GroupListItem[]> {
  const { data: myMemberships } = await supabase
    .from('conversation_members')
    .select('conversation_id, last_read_at')
    .eq('user_id', userId);
  if (!myMemberships?.length) return [];

  const convIds = myMemberships.map(m => m.conversation_id);
  const lastReadByConv: Record<string, string | null> = {};
  for (const m of myMemberships) lastReadByConv[m.conversation_id] = m.last_read_at;

  const [{ data: convs }, { data: memberRows }, { data: msgs }] = await Promise.all([
    supabase.from('conversations').select('id, title, avatar_url, created_by, updated_at').in('id', convIds),
    supabase.from('conversation_members').select('conversation_id, user_id').in('conversation_id', convIds),
    supabase.from('messages')
      .select('id, body, created_at, sender_id, conversation_id')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false }),
  ]);
  if (!convs?.length) return [];

  // Resolve every member's profile in one query.
  const allUserIds = Array.from(new Set((memberRows ?? []).map(r => r.user_id)));
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, badge_tier, badge_show')
    .in('id', allUserIds);
  const profileMap: Record<string, GroupProfile> = {};
  for (const p of profiles ?? []) profileMap[p.id] = p as GroupProfile;

  const membersByConv: Record<string, GroupProfile[]> = {};
  for (const r of memberRows ?? []) {
    const p = profileMap[r.user_id];
    if (!p) continue;
    (membersByConv[r.conversation_id] ||= []).push(p);
  }

  // First (newest) message per conversation, plus unread counts + search bodies.
  const latestByConv: Record<string, any> = {};
  const unreadByConv: Record<string, number> = {};
  const bodiesByConv: Record<string, string[]> = {};
  for (const msg of msgs ?? []) {
    const cid = msg.conversation_id as string;
    if (!latestByConv[cid]) latestByConv[cid] = msg;
    (bodiesByConv[cid] ||= []).push(msg.body);
    const lastRead = lastReadByConv[cid];
    const isUnread = msg.sender_id !== userId && (!lastRead || new Date(msg.created_at) > new Date(lastRead));
    if (isUnread) unreadByConv[cid] = (unreadByConv[cid] || 0) + 1;
  }

  const items: GroupListItem[] = convs.map(c => ({
    id: c.id,
    title: c.title,
    avatar_url: c.avatar_url,
    created_by: c.created_by,
    updated_at: c.updated_at,
    members: membersByConv[c.id] || [],
    last_message: latestByConv[c.id]?.body || '',
    last_message_time: latestByConv[c.id]?.created_at || c.updated_at,
    last_sender_id: latestByConv[c.id]?.sender_id ?? null,
    unread: unreadByConv[c.id] || 0,
    bodies: bodiesByConv[c.id] || [],
  }));

  items.sort((a, b) => new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime());
  return items;
}

// Rename a group (any member may, per RLS). An empty title clears it → the name
// falls back to the members' names. Returns whether the write succeeded.
export async function renameGroup(conversationId: string, title: string): Promise<boolean> {
  const { error } = await supabase
    .from('conversations').update({ title: title.trim() || null }).eq('id', conversationId);
  return !error;
}

// System "event" messages are ordinary messages rows whose body carries a marker
// instead of chat text — rendered as a centered system line, never as a bubble.
// A rename event stores the new name (empty = the name was cleared).
const RENAME_EVENT_PREFIX = 'laybell://event/rename?name=';
export function renameEventBody(name: string): string {
  return RENAME_EVENT_PREFIX + encodeURIComponent(name.trim());
}
// Returns the new name (may be '') for a rename event, or null if not one.
export function parseRenameEvent(body: string): string | null {
  if (!body || !body.startsWith(RENAME_EVENT_PREFIX)) return null;
  try { return decodeURIComponent(body.slice(RENAME_EVENT_PREFIX.length)); } catch { return ''; }
}

// Number of GROUP conversations with unread content (a group with 100 new
// messages counts as ONE). "Unread" = a message from someone else newer than my
// last_read_at for that group. Feeds the home-screen message badge.
// Returns 0 pre-migration (missing tables → null data).
export async function countGroupUnread(userId: string): Promise<number> {
  const { data: memberships } = await supabase
    .from('conversation_members').select('conversation_id, last_read_at').eq('user_id', userId);
  if (!memberships?.length) return 0;
  const convIds = memberships.map(m => m.conversation_id);
  const lastRead: Record<string, string | null> = {};
  for (const m of memberships) lastRead[m.conversation_id] = m.last_read_at;
  const { data: msgs } = await supabase
    .from('messages').select('sender_id, conversation_id, created_at').in('conversation_id', convIds);
  if (!msgs) return 0;
  const unreadConvos = new Set<string>();
  for (const m of msgs) {
    const cid = m.conversation_id as string;
    const lr = lastRead[cid];
    if (m.sender_id !== userId && (!lr || new Date(m.created_at) > new Date(lr))) unreadConvos.add(cid);
  }
  return unreadConvos.size;
}

// Mark a group read for me (drives the unread dot in the list).
export async function markGroupRead(conversationId: string, userId: string): Promise<void> {
  await supabase.from('conversation_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId).eq('user_id', userId);
}
