import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { stripe } from '../_shared/stripe.ts';

// ─────────────────────────────────────────────────────────────────────────────
// stripe-webhook — deliver (or refund) a web card purchase of a shop beat.
//
// Stripe calls this with NO Supabase JWT, so it deploys with --no-verify-jwt and the
// Stripe SIGNATURE is the authentication: every event is HMAC-verified against
// STRIPE_WEBHOOK_SECRET before anything runs. Delivery itself is all in
// shop_deliver_stripe_order (service role, idempotent on the Stripe event id); this
// function only orchestrates: verify → deliver → refund the card if it couldn't deliver.
//
// RETRY SEMANTICS: any transient failure returns 5xx so Stripe retries. The deliver RPC
// is idempotent on event.id and returns the recorded outcome, so a retry re-attempts a
// refund that a prior attempt recorded as owed ('failed') but could not complete — the
// card never gets charged twice and a failed delivery never strands the buyer's money.
//
// ⚠️ MONEY CODE. Pairs with shop_stripe.sql + stripe-checkout. Do not point a LIVE
// Stripe webhook at this until the money review passes.
//
// Deploy (JWT OFF — Stripe can't send a Supabase JWT; the signature is the auth):
//   supabase secrets set STRIPE_SHOP_SECRET_KEY=sk_test_…   # the shop's OWN key; TEST for testing
//   supabase functions deploy stripe-webhook --no-verify-jwt
//   supabase functions deploy stripe-checkout
//   # then, IN THE MATCHING STRIPE MODE (test), create a webhook endpoint pointing at the
//   #   stripe-webhook URL for events checkout.session.completed,
//   #   checkout.session.async_payment_succeeded, charge.refunded,
//   #   charge.dispute.created, charge.dispute.closed → set its signing
//   #   secret:  supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_…
//   # (the webhook endpoint's mode must match STRIPE_SHOP_SECRET_KEY's mode.)
// ─────────────────────────────────────────────────────────────────────────────

// DEDICATED shop key (same one stripe-checkout uses for refunds) — NOT the shared
// STRIPE_SECRET_KEY, which is LIVE and powers payouts. Set STRIPE_SHOP_SECRET_KEY to a
// TEST key for testing, live only at go-live. Fail-closed if unset.
const STRIPE_KEY = Deno.env.get('STRIPE_SHOP_SECRET_KEY');
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// Guest-download email (Resend). Reuse the already-verified consent sender if SHOP_FROM_EMAIL
// isn't set. Best-effort: a mail failure never strands a purchase (the success page still
// shows an instant download).
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const SHOP_FROM_EMAIL = Deno.env.get('SHOP_FROM_EMAIL') ?? Deno.env.get('CONSENT_FROM_EMAIL') ?? 'Laybell <noreply@laybell.app>';
const WEB_ORIGIN = Deno.env.get('SHOP_WEB_ORIGIN') ?? 'https://laybell-web.vercel.app';

const enc = new TextEncoder();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Email a guest their durable download link. Throws on failure so the caller can log it; the
// caller swallows that (the purchase is already delivered + downloadable on the success page).
async function sendGuestEmail(to: string, title: string, token: string) {
  if (!RESEND_API_KEY) { console.error('RESEND_API_KEY unset — guest download email not sent'); return; }
  const link = `${WEB_ORIGIN}/d/${token}`;
  const safeTitle = title.replace(/[<>]/g, '').slice(0, 120);
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 12px">Your Laybell purchase</h2>
    <p>Thanks for buying <b>${safeTitle}</b>. Download it below — keep this email, the link is your receipt.</p>
    <p style="margin:20px 0"><a href="${link}" style="display:inline-block;background:#F26522;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Download your beat</a></p>
    <p style="color:#888;font-size:13px">If the button doesn't work, paste this into your browser:<br>${link}</p>
  </div>`;
  // Bounded: fetch has no default timeout, and this runs inline before the webhook acks Stripe.
  // A hung Resend must never stall the 2xx (Stripe would retry the event), so abort after 5s —
  // the caller treats the abort like any other mail failure (the success page still delivers).
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: SHOP_FROM_EMAIL, to, subject: `Your download: ${safeTitle}`, html }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } finally {
    clearTimeout(t);
  }
}

// Email a guest ALL their cart's download links in one message. Same bounded best-effort as
// sendGuestEmail — a mail failure never stalls the webhook ack (the success page shows them all).
async function sendGuestCartEmail(to: string, downloads: Array<{ token: string; title: string }>) {
  if (!RESEND_API_KEY) { console.error('RESEND_API_KEY unset — guest cart email not sent'); return; }
  const rows = downloads.map((d) => {
    const link = `${WEB_ORIGIN}/d/${d.token}`;
    const safeTitle = String(d.title ?? 'your beat').replace(/[<>]/g, '').slice(0, 120);
    return `<div style="margin:14px 0;padding:12px 14px;border:1px solid #eee;border-radius:10px">
      <div style="font-weight:700;margin-bottom:6px">${safeTitle}</div>
      <a href="${link}" style="color:#F26522;font-weight:700;text-decoration:none">Download &rsaquo;</a>
      <div style="color:#888;font-size:12px;margin-top:4px;word-break:break-all">${link}</div>
    </div>`;
  }).join('');
  const n = downloads.length;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 12px">Your Laybell purchase</h2>
    <p>Thanks for your order — ${n} ${n === 1 ? 'beat' : 'beats'}. Keep this email, the links are your receipt.</p>
    ${rows}
  </div>`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: SHOP_FROM_EMAIL, to, subject: `Your downloads (${n})`, html }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } finally {
    clearTimeout(t);
  }
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Constant-time compare so a verifier can't be timing-probed for the right signature.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
// Verify Stripe's `t=…,v1=…` signature header against the RAW body, HMAC-SHA256 with the
// endpoint secret, inside a replay window. This is the entire authentication of the
// webhook, so it fails closed on anything unexpected.
async function verifyStripeSig(raw: string, header: string, secret: string, toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  const items = header.split(',').map((s) => s.split('='));
  const t = items.find((i) => i[0] === 't')?.[1];
  const sigs = items.filter((i) => i[0] === 'v1').map((i) => i[1]);
  if (!t || sigs.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`));
  const expected = hex(mac);
  return sigs.some((s) => timingSafeEqual(s, expected));
}


serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  if (!WEBHOOK_SECRET || !STRIPE_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    console.error('stripe-webhook not configured');
    return new Response('not_configured', { status: 500 });
  }

  const raw = await req.text();
  const ok = await verifyStripeSig(raw, req.headers.get('Stripe-Signature') ?? '', WEBHOOK_SECRET);
  if (!ok) return new Response('bad_signature', { status: 400 });

  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response('bad_json', { status: 400 }); }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object;
      // A session can complete 'unpaid' for async methods; a later *_succeeded event
      // carries the payment. Only deliver on a paid session.
      if (s.payment_status && s.payment_status !== 'paid') {
        return json({ received: true, ignored: 'unpaid' });
      }
      const cartId = s.metadata?.cart_id ?? null;
      const guestCartId = s.metadata?.guest_cart_id ?? null;
      const guestIntentId = s.metadata?.guest_intent_id ?? null;
      const intentId = s.metadata?.intent_id ?? null;
      const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null);
      // Stripe Tax adds tax ON TOP: amount_total = price + tax, amount_subtotal = price,
      // total_details.amount_tax = the tax. The RPC checks the subtotal against what we
      // issued and banks the tax. Fall back subtotal = total − tax if an older session omits
      // amount_subtotal, so a legit purchase never fails closed.
      const total = Math.floor(Number(s.amount_total));
      const tax = Math.floor(Number(s.total_details?.amount_tax ?? 0));
      const subtotal = s.amount_subtotal != null ? Math.floor(Number(s.amount_subtotal)) : total - tax;
      const addr = s.customer_details?.address ?? null;
      const guestEmail = s.customer_details?.email ?? null;
      const money = {
        p_event_id: event.id, p_payment_intent_id: pi,
        p_total_cents: total, p_subtotal_cents: subtotal, p_tax_cents: tax,
        p_tax_country: addr?.country ?? null, p_tax_state: addr?.state ?? null,
        p_currency: s.currency ?? 'usd',
      };
      // Route by session type: guest cart (N beats, no account → token delivery + emailed
      // links), logged-in cart (N beats), guest single (no account → token), or a logged-in
      // single item. All return refund:true on failure.
      const { data: res, error } = guestCartId
        ? await db.rpc('shop_deliver_stripe_guest_cart', { p_cart_id: guestCartId, ...money, p_email: guestEmail })
        : cartId
        ? await db.rpc('shop_deliver_stripe_cart', { p_cart_id: cartId, ...money })
        : guestIntentId
        ? await db.rpc('shop_deliver_stripe_guest_order', { p_intent_id: guestIntentId, ...money, p_email: guestEmail })
        : await db.rpc('shop_deliver_stripe_order', { p_intent_id: intentId, ...money });
      if (error) { console.error('deliver_failed', event.id, error.message); return new Response('deliver_error', { status: 500 }); }

      // Couldn't deliver (sold out, price mismatch, slot taken, no intent, or a prior
      // failed attempt) → refund the card. Idempotency key on the event makes a retried
      // refund return Stripe's original refund rather than a second one.
      if (res?.refund) {
        if (!pi) {
          // Must refund but the event carried no PaymentIntent — we can't auto-refund, and
          // retrying can't change that. Fail LOUD (never silently keep an undeliverable charge)
          // so a human can refund it; the payment row stays outcome='failed' as the record.
          console.error('REFUND OWED BUT NO payment_intent — MANUAL REFUND NEEDED', event.id, 'reason:', res.reason);
          return json({ received: true, delivered: false, reason: res.reason ?? null, needs_manual_refund: true });
        }
        try {
          await stripe(STRIPE_KEY, 'refunds', { payment_intent: pi, 'metadata[laybell_reason]': String(res.reason ?? 'undeliverable') }, 'POST', `refund_${event.id}`);
          await db.rpc('shop_stripe_mark_refunded', { p_event_id: event.id });
          console.log('refunded undeliverable purchase', event.id, res.reason);
        } catch (rerr) {
          console.error('refund_failed', event.id, String(rerr));
          return new Response('refund_error', { status: 500 }); // Stripe retries; deliver RPC idempotent → retries the refund
        }
      }
      // Guest delivered → email the durable download link (best-effort; the success page also
      // shows an instant download, so a mail failure never strands the purchase).
      if (guestIntentId && res?.delivered && (res as any)?.download_token && (res as any)?.email) {
        await sendGuestEmail(String((res as any).email), String((res as any).title ?? 'your beat'), String((res as any).download_token))
          .catch((e) => console.error('guest_email_failed', event.id, String(e)));
      }
      // Guest CART delivered → email every download link (best-effort; the success page also
      // shows every download, so a mail failure never strands the purchase).
      if (guestCartId && res?.delivered && Array.isArray((res as any)?.downloads) && (res as any)?.email) {
        await sendGuestCartEmail(String((res as any).email), (res as any).downloads as Array<{ token: string; title: string }>)
          .catch((e) => console.error('guest_cart_email_failed', event.id, String(e)));
      }
      return json({ received: true, delivered: !!res?.delivered, reason: res?.reason ?? null });
    }

    // A refund issued from the Stripe dashboard for a delivered order → revoke file access AND
    // claw the seller's earnings back (shop_stripe_refund_delivered does both now).
    //
    // ⚠️ Stripe emits charge.refunded for PARTIAL refunds too. Only a FULL refund should revoke
    // the download + reverse the seller's whole payout; a partial (a goodwill credit, say) leaves
    // the sale — and the seller's earnings — standing. `refunded` flips true only when the charge
    // is fully refunded; `amount_refunded >= amount` is the belt-and-suspenders for cumulative
    // partials that add up to the full amount (amount_refunded is cumulative).
    if (event.type === 'charge.refunded') {
      const c = event.data.object;
      const pi = typeof c.payment_intent === 'string' ? c.payment_intent : (c.payment_intent?.id ?? null);
      const amount = Math.floor(Number(c.amount ?? 0));
      const refundedAmt = Math.floor(Number(c.amount_refunded ?? 0));
      const fullyRefunded = c.refunded === true || (amount > 0 && refundedAmt >= amount);
      if (pi && fullyRefunded) {
        const { error } = await db.rpc('shop_stripe_refund_delivered', { p_payment_intent_id: pi });
        if (error) { console.error('refund_delivered_failed', pi, error.message); return new Response('refund_delivered_error', { status: 500 }); }
      } else if (pi) {
        console.log('partial refund — seller earnings + buyer access left intact', pi, refundedAmt, 'of', amount);
      }
      return json({ received: true, fully_refunded: pi ? fullyRefunded : null });
    }

    // A card CHARGEBACK was opened. Stripe has already pulled the funds (gross + a dispute fee)
    // from the platform balance. Treat it like a refund: revoke the download AND claw the seller's
    // earnings back (so the platform doesn't eat the chargeback AND still pay the seller their
    // cut) — the SAME audited, idempotent path a refund uses. Then record it for the owner.
    if (event.type === 'charge.dispute.created') {
      const d = event.data.object;
      const pi = typeof d.payment_intent === 'string' ? d.payment_intent : (d.payment_intent?.id ?? null);
      const charge = typeof d.charge === 'string' ? d.charge : (d.charge?.id ?? null);
      const disputed = Math.floor(Number(d.amount ?? 0));
      let clawed = false;
      let full = true;
      if (pi) {
        // A dispute is usually for the FULL charge, but can be partial. Detect a partial by
        // comparing the disputed amount to what we actually charged (the payment row's paid_cents):
        // a full dispute claws the seller back + revokes; a partial is recorded only (no
        // wrong-direction over-claw). Unknown charged amount → treat as full (a dispute is
        // adversarial and the platform is already eating the loss + fee, so protect it).
        const { data: payRow } = await db.from('shop_stripe_payments')
          .select('paid_cents').eq('payment_intent_id', pi)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        const paid = Math.floor(Number((payRow as any)?.paid_cents ?? 0));
        full = paid <= 0 || disputed >= paid;
        if (full) {
          const { data: r, error } = await db.rpc('shop_stripe_refund_delivered', { p_payment_intent_id: pi });
          // Fail LOUD (5xx → Stripe retries; the reversal is idempotent) so a revoke/clawback never
          // silently no-ops on a real chargeback.
          if (error) { console.error('dispute_revoke_failed', d.id, pi, error.message); return new Response('dispute_error', { status: 500 }); }
          clawed = !!(r as any)?.revoked;
        } else {
          console.error('PARTIAL DISPUTE — not auto-clawed; manual review needed', d.id, disputed, 'of', paid);
        }
      } else {
        console.error('DISPUTE WITH NO payment_intent — manual review needed', d.id);
      }
      // Audit row (best-effort; a log hiccup must not wedge Stripe retries for an already-reversed
      // dispute — the money reversal above is the load-bearing part).
      await db.rpc('shop_record_dispute', {
        p_dispute_id: d.id, p_payment_intent_id: pi, p_charge_id: charge,
        p_amount_cents: disputed, p_currency: d.currency ?? 'usd',
        p_reason: d.reason ?? null, p_status: d.status ?? 'needs_response', p_clawed_back: clawed,
      }).catch((e) => console.error('dispute_record_failed', d.id, String(e)));
      return json({ received: true, disputed: true, clawed_back: clawed, partial: !full });
    }

    // A dispute resolved. 'lost' → already handled on .created (the reversal is idempotent, so
    // nothing more to do). 'won' → the charge stands, but we already revoked + clawed back on
    // open, so a WON dispute may owe the seller a MANUAL re-credit + the buyer re-access. We log
    // that loudly and record it; we never auto-re-credit (a re-credit is the only mint-direction
    // action and stays a deliberate owner decision).
    if (event.type === 'charge.dispute.closed') {
      const d = event.data.object;
      const pi = typeof d.payment_intent === 'string' ? d.payment_intent : (d.payment_intent?.id ?? null);
      const charge = typeof d.charge === 'string' ? d.charge : (d.charge?.id ?? null);
      await db.rpc('shop_record_dispute', {
        p_dispute_id: d.id, p_payment_intent_id: pi, p_charge_id: charge,
        p_amount_cents: Math.floor(Number(d.amount ?? 0)), p_currency: d.currency ?? 'usd',
        p_reason: d.reason ?? null, p_status: d.status ?? null,
      }).catch((e) => console.error('dispute_record_failed', d.id, String(e)));
      if (d.status === 'won') {
        console.error('DISPUTE WON — seller was clawed back on open; MANUAL re-credit + re-grant may be owed:', d.id, 'pi:', pi);
      } else {
        console.log('dispute closed', d.status, d.id);
      }
      return json({ received: true, dispute_status: d.status ?? null });
    }

    return json({ received: true, ignored: event.type });
  } catch (err) {
    console.error('stripe-webhook failed:', event?.id, String(err));
    return new Response('error', { status: 500 });
  }
});
