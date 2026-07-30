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

// Types only — this import is erased at compile time and pulls in no code, so
// the real module is loaded solely by the guarded require() below.
type SentryModule = typeof import('@sentry/react-native');

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';

// Sending from a dev machine floods the quota with errors nobody will action.
// Set EXPO_PUBLIC_SENTRY_DEBUG=1 to force it on while verifying the wiring.
const FORCE = process.env.EXPO_PUBLIC_SENTRY_DEBUG === '1';
const ENABLED = !!DSN && (!__DEV__ || FORCE);

let mod: SentryModule | null = null;
let resolved = false;
let started = false;

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

export function initMonitoring(): void {
  if (started) return;
  const S = sentry();
  if (!S) return;
  started = true;

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

    // Errors are always captured; performance tracing is not the point here and
    // would burn the quota on a free plan. Enable deliberately if ever needed.
    tracesSampleRate: 0,

    // Which build threw. Essential once OTA updates are live, because the
    // JavaScript on a user's phone may not be the JavaScript in the store build.
    dist: process.env.EXPO_PUBLIC_BUILD_ID || undefined,

    beforeSend(event: any) {
      return scrub(event);
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
