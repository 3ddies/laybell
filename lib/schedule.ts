// When a scheduled post goes live — the time rules behind the Schedule picker
// (components/SchedulePicker) and the Scheduled screen (app/scheduled.tsx). Pure,
// so it is tested in plain Node. Times are epoch milliseconds, and days are the
// phone's LOCAL days.
//
// The server needs none of this: a post whose publish_at is in the future is
// hidden from everyone but its author until that moment, whatever time it names
// (supabase/sql/post_scheduling.sql). These rules only shape what the picker offers.

/** How far ahead a post can be scheduled. */
export const MAX_SCHEDULE_DAYS = 30;
/** The picker's earliest suggestion is at least this far away. */
export const MIN_LEAD_MIN = 10;
/** The minute wheel's step. */
export const MINUTE_STEP = 5;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export type ScheduleProblem = 'soon' | 'far' | null;

/** Local midnight at the start of `ts`'s day. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** `dayStart`'s local day at hour:minute (24-hour). */
export function atDayTime(dayStart: number, hour: number, minute: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
}

/** Up to the next minute on the MINUTE_STEP grid (already on it stays put). */
export function ceilToStep(ts: number): number {
  const d = new Date(ts);
  const partial = d.getSeconds() > 0 || d.getMilliseconds() > 0;
  d.setSeconds(0, 0);
  const minutes = d.getMinutes() + (partial ? 1 : 0);
  d.setMinutes(Math.ceil(minutes / MINUTE_STEP) * MINUTE_STEP);
  return d.getTime();
}

/** The earliest time the picker offers. */
export function earliestSchedule(now: number): number {
  return ceilToStep(now + MIN_LEAD_MIN * MINUTE);
}

/** The latest time a post can be scheduled for. */
export function latestSchedule(now: number): number {
  return now + MAX_SCHEDULE_DAYS * DAY;
}

/** The picker's first suggestion: the next whole hour at least an hour away. */
export function defaultSchedule(now: number): number {
  const d = new Date(now + 60 * MINUTE);
  if (d.getMinutes() || d.getSeconds() || d.getMilliseconds()) d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
}

/**
 * Why a time cannot be used, or null. "Soon" only means under a minute away — the
 * picker suggests ten minutes out, but a time that was fine when the sheet opened
 * must not turn invalid while someone is still deciding.
 */
export function scheduleProblem(at: number, now: number): ScheduleProblem {
  if (!(at >= now + MINUTE)) return 'soon';
  if (at > latestSchedule(now)) return 'far';
  return null;
}

/** Local midnights from today through MAX_SCHEDULE_DAYS days ahead. */
export function scheduleDays(now: number): number[] {
  const noon = atDayTime(startOfDay(now), 12, 0);
  const out: number[] = [];
  // Stepped from noon, so a 23- or 25-hour day around a clock change never skips
  // or repeats a date.
  for (let i = 0; i <= MAX_SCHEDULE_DAYS; i++) out.push(startOfDay(noon + i * DAY));
  return out;
}

/** 'today' or 'tomorrow' when `at` falls on one of them, otherwise null. */
export function dayWord(at: number, now: number): 'today' | 'tomorrow' | null {
  const diff = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  return diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : null;
}

/** "Today, 3:00 PM" / "Tomorrow, 9:30 AM" / "Tue, Sep 16, 3:00 PM", in the app's language. */
export function formatSchedule(
  at: number,
  now: number,
  lang: string,
  words: { today: string; tomorrow: string; dayTime: (day: string, time: string) => string },
): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' });
  const w = dayWord(at, now);
  const day = w === 'today' ? words.today
    : w === 'tomorrow' ? words.tomorrow
    : date.toLocaleDateString(lang, { weekday: 'short', month: 'short', day: 'numeric' });
  return words.dayTime(day, time);
}

/**
 * Whether times read on a 12-hour clock in this language. Read off a formatted
 * 1 PM rather than resolvedOptions().hour12, which not every JS engine fills in.
 */
export function uses12h(lang: string): boolean {
  try {
    return !new Date(2000, 0, 1, 13, 0).toLocaleTimeString(lang, { hour: 'numeric' }).includes('13');
  } catch {
    return true;
  }
}

export function to12h(hour24: number): { hour12: number; pm: boolean } {
  const h = ((hour24 % 24) + 24) % 24;
  return { hour12: h % 12 === 0 ? 12 : h % 12, pm: h >= 12 };
}

export function from12h(hour12: number, pm: boolean): number {
  const h = hour12 % 12;
  return pm ? h + 12 : h;
}
