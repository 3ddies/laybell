// Crash and error reporting.
//
// WHY THIS EXISTS: before this, a failure in production was invisible. Apple
// only reports NATIVE crashes — aggregated, delayed, and with no JavaScript
// stack traces — so a red screen, a stuck spinner or a swallowed promise
// rejection never reached anyone. That matters most on the money paths, which
// were written carefully and, at the time of writing, executed zero times.
//
// It is a NO-OP until EXPO_PUBLIC_SENTRY_DSN is set, so the app builds and runs
// identically with or without an account behind it.

import AsyncStorage from '@react-native-async-storage/async-storage';

// Types only — this import is erased at compile time and pulls in no code, so
// the real module is loaded solely by the guarded require() below.
type SentryModule = typeof import('@sentry/react-native');

// ── User opt-out ────────────────────────────────────────────────────────────
// Settings → Privacy Center → "Crash reports". Defaults ON, unlike ad
// personalization next to it, and the difference is deliberate: personalised
// ads need consent, whereas diagnostic reports carrying no identity rest on
// legitimate interests. A crash reporter nobody opts into reports nothing.
//
// The gate is applied at SEND time rather than at init, because wrapRoot() runs
// synchronously at module scope to catch render errors — deferring init until
// AsyncStorage resolved would leave the root unwrapped. So the SDK always
// starts, and beforeSend decides whether anything actually leaves the device.
//
// It fails CLOSED: until the preference has been read, `allowSend` is null and
// beforeSend drops everything. That costs a few milliseconds of early-crash
// coverage for everyone, which is the right trade against a user who opted out
// having a single report escape during startup.
const PREF_KEY = 'crash_reporting_v1';
let allowSend: boolean | null = null;

export async function isCrashReportingEnabled(): Promise<boolean> {
  if (allowSend != null) return allowSend;
  try {
    const raw = await AsyncStorage.getItem(PREF_KEY);
    allowSend = raw == null ? true : raw === '1';
  } catch {
    allowSend = true;
  }
  return allowSend;
}

export async function setCrashReporting(enabled: boolean): Promise<void> {
  allowSend = enabled;
  try { await AsyncStorage.setItem(PREF_KEY, enabled ? '1' : '0'); } catch {}
}

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';

// Sending from a dev machine floods the quota with errors nobody will action.
// Set EXPO_PUBLIC_SENTRY_DEBUG=1 to force it on while verifying the wiring.
const FORCE = process.env.EXPO_PUBLIC_SENTRY_DEBUG === '1';
const ENABLED = !!DSN && (!__DEV__ || FORCE);

// Share of sessions whose performance is traced (app start, screen loads, slow and
// frozen frames, JS stalls). Errors are unaffected — every one is always captured.
// 1.0.4 turned this on to measure the app before and after its performance work
// (owner, 2026-09-19). Each traced session sends a handful of transactions; lower
// this as the user base grows so the Sentry plan's quota holds.
const TRACES_SAMPLE_RATE = 0.3;

let mod: SentryModule | null = null;
let resolved = false;
let started = false;
// Times each screen change and how long the new screen takes to draw (TTID).
let navigation: { registerNavigationContainer: (ref: unknown) => void } | null = null;

// Loaded lazily and behind a try/catch, mirroring how _layout.tsx guards
// @livekit/react-native. Two reasons, both real:
//
//  · @sentry/react-native has a NATIVE module. A dev client built before it was
//    added does not contain it, and a hard top-level import would reach for it
//    at load on every existing binary.
//  · Without a DSN the module is never needed at all, so it stays out of the
//    startup path entirely rather than costing parse time to do nothing.
function sentry(): SentryModule | null {
  if (!ENABLED) return null;
  if (!resolved) {
    resolved = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('@sentry/react-native');
    } catch {
      mod = null; // natives not in this binary yet — stay silent, don't crash
    }
  }
  return mod;
}

// Anything that looks like a credential, wherever it turns up in an event.
const SECRET_KEYS = /^(authorization|apikey|api_key|token|access_token|refresh_token|password|secret|cookie|set-cookie)$/i;
// Bearer/JWT-shaped strings, and anything smelling like an email address.
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

function scrubString(s: string): string {
  return s.replace(JWT, '[jwt]').replace(EMAIL, '[email]');
}

// Walks an arbitrary event payload and removes credentials. Depth-capped
// because Sentry events nest deeply and this runs on every send.
function scrub(value: any, depth = 0): any {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Query strings on Supabase requests carry row filters — `?id=eq.<uuid>`,
// `?email=eq.…` — so a network breadcrumb would quietly log who was being
// looked up. The path is kept (it names the table, which is the useful part)
// and everything after `?` is dropped.
function stripQuery(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?[stripped]`;
}

// Request spans name their URL in the description ("GET https://…?id=eq.<uuid>") and
// again in their data, so the same row filters as above would ride along with every
// traced session. Strip them the way breadcrumbs are stripped.
function stripSpanUrls(event: any): any {
  for (const span of event?.spans ?? []) {
    if (typeof span.description === 'string' && /^[A-Z]+ https?:\/\//.test(span.description)) {
      span.description = stripQuery(span.description);
    }
    if (span.data) {
      for (const key of ['url', 'http.url', 'server.address']) {
        if (typeof span.data[key] === 'string') span.data[key] = stripQuery(span.data[key]);
      }
      delete span.data['http.query'];
      delete span.data['http.fragment'];
    }
  }
  return event;
}

export function initMonitoring(): void {
  if (started) return;
  const S = sentry();
  if (!S) return;
  started = true;

  // Start the preference read immediately. Until it lands, beforeSend drops
  // every event (see the opt-out note above).
  isCrashReportingEnabled();

  // Screen timings. Route names only ("profile/[id]") — this integration records no
  // route params, which matters here because screens pass whole posts as JSON params.
  const nav = S.reactNavigationIntegration({ enableTimeToInitialDisplay: true });
  navigation = nav as any;

  S.init({
    dsn: DSN,

    // ── Privacy ──────────────────────────────────────────────────────────
    // Laybell carries private messages, and 13–17 year olds use it under
    // parental consent, so the defaults are turned DOWN rather than up:
    //
    //  · sendDefaultPii stays false — no IP addresses, no request bodies.
    //  · Session Replay is deliberately NOT enabled. Sentry's own setup guide
    //    suggests mobileReplayIntegration, which records the screen. On an app
    //    with DMs and minors that is not something to switch on casually, and
    //    it would need its own disclosure in the Privacy Policy.
    //  · No user identity is attached automatically. reportError() takes a
    //    context argument, so a call site that genuinely needs to know WHICH
    //    user hit a money bug opts in explicitly.
    sendDefaultPii: false,

    // ── Performance (1.0.4) ──────────────────────────────────────────────
    // A sample of sessions is traced: cold/warm app start, each screen's time to
    // first draw, slow and frozen frames, and JS-thread stalls — the numbers that
    // say where the app feels slow on real phones. See TRACES_SAMPLE_RATE.
    tracesSampleRate: TRACES_SAMPLE_RATE,
    integrations: [nav],
    // No trace headers on outgoing requests. There is no backend of ours to join
    // traces up with, and Supabase, Cloudflare's upload endpoints and the rest
    // should see exactly the requests they always have.
    tracePropagationTargets: [],

    // Which build threw. Essential once OTA updates are live, because the
    // JavaScript on a user's phone may not be the JavaScript in the store build.
    dist: process.env.EXPO_PUBLIC_BUILD_ID || undefined,

    beforeSend(event: any) {
      // The opt-out, and the last gate before anything leaves the device.
      // Returning null discards the event entirely.
      if (allowSend !== true) return null;
      return scrub(event);
    },

    // Performance data answers to the same opt-out and the same scrubbing.
    beforeSendTransaction(event: any) {
      if (allowSend !== true) return null;
      return scrub(stripSpanUrls(event));
    },

    beforeBreadcrumb(crumb: any) {
      // Console breadcrumbs replay whatever the app logged, which is the most
      // likely place for a token or an email to leak into an event.
      if (crumb.category === 'console' && crumb.message) {
        crumb.message = scrubString(crumb.message);
      }
      if (crumb.data && (crumb.category === 'xhr' || crumb.category === 'fetch')) {
        crumb.data = { ...crumb.data, url: stripQuery(crumb.data.url) };
      }
      return crumb;
    },
  });
}

// Report an error that was caught and handled — the case a crash reporter can
// never see on its own.
//
// This app has ~190 `catch {}` blocks and most of them are RIGHT: a share
// counter that fails to increment, a haptic that isn't available, an optimistic
// update rolling back. Those should stay silent. The ones worth routing here
// are where silence is indistinguishable from success — anything touching
// money, auth or uploads, where a swallowed failure means the user believes
// something happened that did not.
//
// Safe to call unconditionally: no-ops when monitoring is disabled.
export function reportError(error: unknown, context?: Record<string, any>): void {
  const S = sentry();
  if (!S) return;
  const err = error instanceof Error ? error : new Error(String(error));
  S.captureException(err, context ? { extra: scrub(context) } : undefined);
}

// A named failure that isn't an exception — an RPC that returned `{ error }`, a
// webhook that answered 4xx, a state the code believes is impossible.
export function reportIssue(message: string, context?: Record<string, any>): void {
  const S = sentry();
  if (!S) return;
  S.captureMessage(scrubString(message), {
    level: 'error',
    ...(context ? { extra: scrub(context) } : {}),
  } as any);
}

// Hands expo-router's navigation container to the screen-timing integration. Called
// once from the root layout; a no-op while monitoring is off.
export function registerNavigationContainer(ref: unknown): void {
  if (ref) navigation?.registerNavigationContainer(ref);
}

// Wraps the root component so React render errors are captured with a component
// stack, which a plain global handler cannot produce. Returns the component
// untouched when monitoring is off, so the tree is identical without a DSN.
export function wrapRoot<T>(Component: T): T {
  const S = sentry();
  return S ? (S.wrap as any)(Component) : Component;
}

// True when reports are actually being sent — so the Privacy Center never tells
// users diagnostics are collected when nothing is configured.
export function monitoringEnabled(): boolean {
  return !!sentry();
}
