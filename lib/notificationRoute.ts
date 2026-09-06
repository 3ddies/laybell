// Where a notification should take you — one table, used by BOTH the row in the
// Notifications list and the push notification it arrived as.
//
// Written as a lookup returning a destination rather than as something that
// navigates, because the two callers cannot navigate the same way. The list is
// presented as a SHEET over the tabs, so it has to pop back down to the pager
// underneath (see goToTab in app/notifications.tsx); a push tap happens with no
// sheet in the way. Sharing the navigation call would have meant one of them
// doing the wrong thing, and sharing nothing would have meant the two drifting
// apart the first time a message key changed.

export type Dest = {
  href: string;
  /** True for a route inside the (tabs) group, which each caller reaches its own way. */
  tab: boolean;
};

/**
 * The destination for a Laybell system message.
 *
 * `selfId` is the signed-in account, needed only by 'followers' — pass null when
 * it is not to hand and it degrades to the profile tab, which is one tap away
 * from the same list rather than being wrong.
 *
 * Returns null for a message that should not navigate at all.
 */
export function destForSystemKey(key: string | null | undefined, selfId?: string | null): Dest | null {
  switch (key) {
    case 'earnings':    return { href: '/wallet', tab: false };
    case 'badge_first': return { href: '/badges', tab: false };
    // Both of these say "post something", so both land on the composer.
    case 'first_post':
    case 'back':        return { href: '/(tabs)/post', tab: true };
    // Straight to the followers list, which is what "3 people followed you"
    // is actually about — the profile tab was one screen short of the answer.
    case 'followers':
      return selfId ? { href: `/followers/${selfId}`, tab: false }
                    : { href: '/(tabs)/profile', tab: true };
    // Answered by the notifications list itself.
    case 'unread':      return { href: '/notifications', tab: false };
    // A key this build does not know, sent by a newer server. The message is
    // unreadable here, so the feed is the one landing that cannot be wrong —
    // never the composer, which would hand someone a stranger's idea as an
    // instruction to post.
    default:            return { href: '/(tabs)', tab: true };
  }
}

/**
 * The destination for a tapped PUSH, from its `data` payload.
 *
 * Every push this app sends carries `data`, but not all of it is useful:
 * send-push writes `{ type, postId }` and no actor, so a 'follow' or 'message'
 * cannot be resolved to a person from the payload alone. Those land on the
 * notifications list, where the row says who — short of the ideal, and much
 * better than the nothing that happened before.
 */
export function destForPushData(data: any, selfId?: string | null): Dest | null {
  const type = data?.type;

  // The badge reminder is scheduled locally by lib/badgeRisk.
  if (type === 'badge_risk') return { href: '/badges', tab: false };

  if (type === 'system') return destForSystemKey(data?.key, selfId);

  // Straight into the stream that just started. The push carries the id; the
  // notification ROW does not (it has only the host), so that one settles for
  // the live rail — see destForNotificationRow.
  if (type === 'live_started') {
    return data?.liveId
      ? { href: `/live?streamId=${data.liveId}`, tab: false }
      : { href: '/live', tab: false };
  }

  // like / comment / mention / tag / song_used — all carry the post.
  if (data?.postId) return { href: `/post/${data.postId}`, tab: false };

  // follow / friend / message / offer, and anything unrecognised.
  return { href: '/notifications', tab: false };
}
