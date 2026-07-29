import { supabase } from './supabase';

// Client side of the server-captured access log (supabase/sql/access_log.sql).
//
// Note what this file does NOT do: it never sends an IP address. It cannot — a
// client-reported address is worthless as evidence, so the address is read from
// the request by the log-access Edge Function. All the client does is name the
// event it just performed.
//
// Every call is FIRE-AND-FORGET and swallows errors. Logging must never block a
// user from posting, reporting, or downloading something they paid for. A missing
// log row is a gap in evidence; a failed download is a broken product.

export type AccessEvent = 'upload' | 'post' | 'report' | 'shop_download' | 'live_start';

export function logAccess(event: AccessEvent, subjectType?: string, subjectId?: string): void {
  // Deliberately not awaited by callers — kick it off and move on.
  supabase.functions
    .invoke('log-access', { body: { event, subjectType, subjectId } })
    .then(undefined, () => {});
}
