import { tg } from './i18n';

// Compact relative timestamp ("3m", "5h", "2d"). Localized via the module-level
// active language (see lib/i18n setActiveLang) so it needs no t() param at the
// dozens of call sites. Keys live under `time.*` with an {n} placeholder.
export function timeAgo(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return tg('time.secondsAgo', { n: Math.max(0, seconds) });
  if (seconds < 3600) return tg('time.minutesAgo', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return tg('time.hoursAgo', { n: Math.floor(seconds / 3600) });
  return tg('time.daysAgo', { n: Math.floor(seconds / 86400) });
}
