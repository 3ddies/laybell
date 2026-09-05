#!/usr/bin/env node
// The unsubscribe link for one account. Whatever sends Laybell's marketing mail
// must put this in every message — it is a CAN-SPAM requirement, not a courtesy.
//
//   UNSUBSCRIBE_SECRET=... node scripts/unsubscribe-token.mjs <user-id>
//
// The signature must match supabase/functions/unsubscribe's sign(): HMAC-SHA256
// of the user id under UNSUBSCRIBE_SECRET, lowercase hex. Kept here rather than
// re-derived per sender so the two cannot drift into "the link looks right and
// always says not recognised".
//
// ⚠️ open.laybell.app, never *.supabase.co — the shared functions domain rewrites
// HTML to text/plain, so the reader would see raw markup. See the function's own
// header, and lib/appLinks.ts.
import { createHmac } from 'node:crypto';

const BASE = 'https://open.laybell.app/functions/v1/unsubscribe';

export function unsubscribeUrl(userId, secret) {
  if (!userId || !secret) throw new Error('unsubscribeUrl: userId and secret are both required');
  const sig = createHmac('sha256', secret).update(userId).digest('hex');
  return `${BASE}?u=${encodeURIComponent(userId)}&t=${sig}`;
}

/**
 * The headers Gmail and Yahoo require of bulk senders (RFC 8058). Without
 * List-Unsubscribe-Post they treat the mail as not offering one-click, which is
 * a deliverability problem long before it is a legal one.
 */
export function unsubscribeHeaders(userId, secret) {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(userId, secret)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const id = process.argv[2];
  const secret = process.env.UNSUBSCRIBE_SECRET;
  if (!id || !secret) {
    console.error('usage: UNSUBSCRIBE_SECRET=... node scripts/unsubscribe-token.mjs <user-id>');
    process.exit(1);
  }
  console.log(unsubscribeUrl(id, secret));
}
