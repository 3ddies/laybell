// Studio session invites as a special DM. Encoded INSIDE the message body, the
// same trick offers, attachments, shared posts and story replies use, so no
// schema change is needed:
//
//   laybell://studio?session=<id>&code=<join_code>&title=<encoded>
//   <optional note on the next line(s)>
//
// WHY AN INVITE CARD RATHER THAN A RING. A ringing call asserts the other person
// is free right now, and a missed one reads as a failure. An invite sits in the
// thread and gets opened when they actually have time — which for collaborating
// on music is usually the point. (Owner's call; ringing can be built on top of
// this later, since the session and join plumbing is the same.)
//
// THE JOIN CODE IS THE CAPABILITY. joinByCode() is what adds the recipient to
// studio_session_members; the session id alone only tells the card what to
// display. That means an invite forwarded outside the thread still cannot join
// anyone who was not given the code, and the server decides membership — the
// card never does.

import { fetchSession } from './studio';

const PREFIX = 'laybell://studio?';

export type StudioInviteRef = {
  sessionId: string;
  code: string;
  title: string;
};
export type ParsedStudioInvite = StudioInviteRef & { note: string };

export function studioInviteBody(i: StudioInviteRef, note?: string): string {
  const qs = [
    `session=${encodeURIComponent(i.sessionId)}`,
    `code=${encodeURIComponent(i.code || '')}`,
    `title=${encodeURIComponent(i.title || '')}`,
  ].join('&');
  const n = (note ?? '').trim();
  return n ? `${PREFIX}${qs}\n${n}` : `${PREFIX}${qs}`;
}

export function isStudioInviteBody(body: string | null | undefined): boolean {
  return !!body && body.startsWith(PREFIX);
}

export function parseStudioInvite(body: string | null | undefined): ParsedStudioInvite | null {
  if (!isStudioInviteBody(body)) return null;
  const [head, ...rest] = (body as string).split('\n');
  const qs = head.slice(PREFIX.length);
  const p = new URLSearchParams(qs);
  const sessionId = p.get('session') || '';
  if (!sessionId) return null;
  return {
    sessionId,
    code: p.get('code') || '',
    title: p.get('title') || '',
    note: rest.join('\n').trim(),
  };
}

/** One-line preview for conversation lists / notifications. Never prints the raw
 *  body — a list row showing `laybell://studio?...` is the bug this prevents. */
export function studioInvitePreview(t: (k: string) => string): string {
  return t('studioInvite.preview');
}

/** Live status for the card. Returns null for UNKNOWN, and unknown is the normal
 *  case for the person being invited.
 *
 *  studio_sessions has deliberately NO public SELECT policy — join_code is the
 *  room credential, so only members can read the row (supabase/sql/studio_live.sql).
 *  The invitee is by definition not a member yet, so the fetch returns no row.
 *  Reading "no row" as "ended" is what made the card flash Join and then declare
 *  a running session over before anyone could tap it.
 *
 *  Only an explicit status of 'ended' — which only a MEMBER can ever observe,
 *  i.e. the host or someone who already joined — closes the card. Everyone else
 *  gets Join, and joinByCode is the real arbiter: it fails cleanly on a dead
 *  session and the card surfaces that. */
export async function studioSessionOpen(sessionId: string): Promise<boolean | null> {
  try {
    const s = await fetchSession(sessionId);
    if (!s) return null;               // not visible to us — NOT evidence it ended
    return s.status === 'open';
  } catch {
    return null;
  }
}
