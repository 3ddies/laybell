import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onBadgeRisk, BADGES_BY_KEY, TIER_WEIGHT, type BadgeRisk } from './badges';
import { tg } from './i18n';

// "Your Gold login badge goes at the end of today" — a LOCAL notification,
// scheduled by the app for later the same day and cancelled the moment the user
// does the thing that saves it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT PART OF THE RE-ENGAGEMENT CRON
//
// The obvious place for "you are about to lose a badge" is the server job that
// already sends Laybell's other reminders. It cannot go there, for two reasons
// that only showed up on reading the badge rules:
//
//   1. WRONG TIMESCALE. Badges are maintained DAILY — the free grace window is
//      one day, three for Premium. The cron fires at twelve days of silence, by
//      which point every lapsing badge lapsed eleven days ago. The message would
//      be false at the moment it was sent.
//   2. THE SERVER DOES NOT KNOW. Badges are evaluated entirely in lib/badges.ts
//      against per-day activity rows; profiles.badge_tier is only a cached
//      rollup the client writes. Answering "which badge, and when" server-side
//      would mean a second copy of the whole rule set in SQL, kept in step by
//      hand. That is the kind of duplication that is correct on the day it is
//      written and wrong a release later.
//
// So the client, which has the rules and the data, schedules a LOCAL
// notification. No push token, no server round trip, and the timing is exact.
//
// It honours the SAME opt-in as the re-engagement push (profiles.reengage_opt_in)
// rather than inventing a second switch. This is still a notification designed
// to pull someone back into the app, which is what App Store guideline 4.5.4 is
// about, and one switch the user has already understood beats two.

const KEY_ID   = 'badge_risk_notif_id';   // the scheduled notification to cancel
const KEY_DAY  = 'badge_risk_notif_day';  // the UTC day it was scheduled for

// How long before the UTC day flips to warn. Laybell is US-only: 00:00 UTC is
// 8pm Eastern / 5pm Pacific, so four hours earlier lands at 4pm Eastern / 1pm
// Pacific — inside the working day everywhere in the country, and far enough
// ahead to actually open the app and do something about it.
const WARN_HOURS_BEFORE_FLIP = 4;

// Below this, don't bother: the deadline is close enough that the person is
// either in the app already (this runs on evaluation, which needs the app open)
// or past saving it.
const MIN_LEAD_MS = 15 * 60 * 1000;

/** The badge worth naming when several lapse at once: the highest tier. */
export function mostValuable(keys: string[]): string | null {
  let best: string | null = null;
  let bestWeight = -1;
  for (const k of keys) {
    const def = BADGES_BY_KEY[k];
    if (!def) continue;
    const w = TIER_WEIGHT[def.tier];
    if (w > bestWeight) { bestWeight = w; best = k; }
  }
  return best;
}

/**
 * When to fire, given the UTC day the badge state is anchored to.
 * Returns null when the moment has already passed or is too close to be useful.
 */
export function fireTimeFor(todayUTC: string, now: number = Date.now()): number | null {
  const [y, m, d] = todayUTC.split('-').map(Number);
  if (!y || !m || !d) return null;
  // The badge day ends at the START of the next UTC day.
  const flip = Date.UTC(y, m - 1, d + 1);
  const at = flip - WARN_HOURS_BEFORE_FLIP * 3600_000;
  return at - now >= MIN_LEAD_MS ? at : null;
}

function bodyFor(key: string, count: number): string {
  const def = BADGES_BY_KEY[key];
  // `title` already carries the tier — "Gold Login", not "Login" — so prefixing
  // tierLabel here would say "Gold Gold Login".
  const badge = def ? def.title : '';
  // One extra badge reads as "and 1 other", which is worse than naming the
  // number of badges outright, so the plural form carries the total.
  return count > 1
    ? tg('badgeRisk.bodyMany', { badge, count })
    : tg('badgeRisk.bodyOne', { badge });
}

async function cancelExisting(): Promise<void> {
  try {
    const id = await AsyncStorage.getItem(KEY_ID);
    if (id) await Notifications.cancelScheduledNotificationAsync(id);
  } catch { /* already gone, or the OS forgot it — nothing to undo */ }
  try { await AsyncStorage.multiRemove([KEY_ID, KEY_DAY]); } catch {}
}

/**
 * Reconcile the scheduled reminder against what is actually at risk right now.
 * Safe to call on every badge evaluation — that is the point, because an empty
 * risk list is what cancels a reminder the user has since made unnecessary.
 */
export async function syncBadgeRiskReminder(risk: BadgeRisk): Promise<void> {
  try {
    const todayUTC = risk.today;
    // Nothing at risk, or they never asked to hear from us: make sure whatever
    // was scheduled earlier today is gone. Cancelling is the important half —
    // a reminder that fires AFTER the user saved the badge is worse than none,
    // because it is wrong and they can see it is wrong.
    if (!risk.optedIn || risk.keys.length === 0) { await cancelExisting(); return; }

    const at = fireTimeFor(todayUTC);
    if (at === null) { await cancelExisting(); return; }

    const named = mostValuable(risk.keys);
    if (!named) { await cancelExisting(); return; }

    // Already scheduled for this same UTC day: leave it be. Re-scheduling on
    // every evaluation would churn the OS queue for no change, and evaluation
    // runs on a 4-second debounce off ordinary activity.
    const day = await AsyncStorage.getItem(KEY_DAY);
    if (day === todayUTC) return;

    await cancelExisting();

    // Ask before scheduling. The OS drops it silently otherwise, which would
    // look exactly like a bug in this file.
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return;

    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: tg('badgeRisk.title'),
        body: bodyFor(named, risk.keys.length),
        sound: 'default',
        data: { type: 'badge_risk', badge: named },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at) },
    });
    await AsyncStorage.multiSet([[KEY_ID, id], [KEY_DAY, todayUTC]]);
  } catch {
    // Never let a reminder break an evaluation — the badge itself matters more
    // than being told about it.
  }
}

// Registered at import time, the same way lib/entitlements wires its getters.
// contexts/ProfileContext imports this module for the side effect.
let started = false;
export function startBadgeRiskReminders(): void {
  if (started) return;
  started = true;
  onBadgeRisk((risk) => { syncBadgeRiskReminder(risk).catch(() => {}); });
}
