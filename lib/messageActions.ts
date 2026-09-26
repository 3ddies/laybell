import { supabase } from './supabase';
import { parseAttachment } from './attachments';
import { removePublicUrls } from './storageCleanup';

// DM message long-press actions (message_unsend.sql).
//
// UNSEND — hard-delete your own message so it vanishes for everyone (Instagram-
// style, no tombstone). Sender-only, enforced by the existing sender-delete RLS
// policy. If the message is an uploaded IMAGE attachment, the object is best-effort
// removed from storage too, so the bytes don't orphan in the (shared) posts bucket.
// GIFs are remote Tenor URLs and shared-post / text messages own no storage.
export async function unsendMessage(msgId: string, body: string): Promise<boolean> {
  const att = parseAttachment(body);
  if (att?.type === 'image' && att.url) {
    try { await removePublicUrls([att.url]); } catch { /* orphan cleanup is best-effort */ }
  }
  const { error } = await supabase.from('messages').delete().eq('id', msgId);
  return !error;
}

// DELETE FOR YOU — hide a message from THIS user only; the other side keeps it.
export async function hideMessageForMe(msgId: string, userId: string): Promise<boolean> {
  const { error } = await supabase
    .from('message_hides')
    .upsert({ message_id: msgId, user_id: userId }, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
  return !error;
}

// The set of message ids this user has hidden — loaded once per thread open and
// used to filter both the initial fetch and live inserts.
export async function fetchHiddenMessageIds(userId: string): Promise<Set<string>> {
  const { data } = await supabase.from('message_hides').select('message_id').eq('user_id', userId);
  return new Set<string>((data ?? []).map((r: any) => r.message_id));
}

// COPY — put a message's text on the clipboard (expo-clipboard, a native module).
// Loaded LAZILY inside try/catch so a dev client built BEFORE the module was added
// (its native side is absent) degrades to a no-op instead of crashing on import;
// a build that includes expo-clipboard copies for real. Returns whether it worked.
export async function copyText(text: string): Promise<boolean> {
  try {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
