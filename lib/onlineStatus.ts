import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { supabase } from './supabase';
import { isLoopIdle, subscribeLoopIdle } from './playbackPresence';

// ── Active Status: the green "online now" dot ────────────────────────────────
// Two halves share one module so they can both read the viewer's own opt-out flag:
//
//   • HEARTBEAT — while I'm foregrounded and opted in, stamp my last_active_at via
//     the touch_active() RPC (~every 60s). Backgrounded → the beats stop, so I fall
//     out of the 2-minute window and go offline on everyone else's screen.
//   • POLL — of the userIds currently on screen, ask online_user_ids() which are
//     live right now (one shared 45s request for every mounted avatar, exactly like
//     lib/liveNow). The RPC enforces the reciprocal rule server-side: opted out → it
//     returns nothing, so I both vanish from others AND see no one.
//
// Dormant until active_status.sql is applied (the RPCs 404, caught) and until the
// profile carries active_status_enabled (ProfileContext only enables it then).

const HEARTBEAT_MS = 60_000;
const POLL_MS = 45_000;

let myUserId: string | null = null;
let myEnabled = false; // the viewer's own Active-Status setting

// ── Heartbeat ────────────────────────────────────────────────────────────────
let hbTimer: ReturnType<typeof setInterval> | null = null;
let appSub: { remove: () => void } | null = null;
let presenceUnsub: (() => void) | null = null;

async function beat() {
  if (!myUserId || !myEnabled) return;
  if (AppState.currentState !== 'active') return; // foreground only — no background-audio "online"
  // Foregrounded but untouched past the idle threshold = the room is empty (see
  // lib/presenceCore). Stop stamping so an app left open on a table drops to offline
  // instead of reading "active" forever — a single touch (below) brings it right back.
  if (isLoopIdle()) return;
  try { await supabase.rpc('touch_active'); } catch { /* pre-migration / offline */ }
}

function startHeartbeat() {
  if (hbTimer) return;
  beat();
  hbTimer = setInterval(beat, HEARTBEAT_MS);
  // On foreground: stamp at once AND re-poll, so a returning viewer's now-stale dots
  // clear within a second instead of on the next 45s tick.
  appSub = AppState.addEventListener('change', (s: AppStateStatus) => { if (s === 'active') { beat(); poll(); } });
  // A touch after an idle stretch means the user is back — stamp immediately so their
  // dot reappears promptly rather than waiting for the next 60s beat.
  presenceUnsub = subscribeLoopIdle(() => { if (!isLoopIdle()) beat(); });
}

function stopHeartbeat() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  if (appSub) { appSub.remove(); appSub = null; }
  if (presenceUnsub) { presenceUnsub(); presenceUnsub = null; }
}

// ── Shared online poll ─────────────────────────────────────────────────────────
const wanted = new Map<string, number>(); // userId → ref-count of mounted avatars
let online = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let pokeTimer: ReturnType<typeof setTimeout> | null = null;
let fetching = false;

function notify() { listeners.forEach((l) => l()); }

async function poll() {
  if (fetching) return;
  if (!myEnabled || wanted.size === 0) {
    if (online.size) { online = new Set(); notify(); } // off/empty → everyone offline
    return;
  }
  fetching = true;
  try {
    const ids = [...wanted.keys()];
    const { data, error } = await supabase.rpc('online_user_ids', { ids });
    if (!error) {
      const next = new Set<string>((data ?? []).map((r: any) => r.id));
      let changed = next.size !== online.size;
      if (!changed) { for (const id of next) if (!online.has(id)) { changed = true; break; } }
      if (changed) { online = next; notify(); }
    }
  } catch { /* offline / pre-migration — keep the last known set */ }
  fetching = false;
}

function ensurePolling() {
  if (timer) return;
  timer = setInterval(poll, POLL_MS);
}

function stopIfIdle() {
  if (wanted.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
    if (online.size) { online = new Set(); notify(); }
  }
}

// Coalesce a burst of avatar mounts (a whole feed appears in one frame) into one
// request, and resolve freshly-added ids well before the 45s tick.
function pokePoll() {
  if (pokeTimer) return;
  pokeTimer = setTimeout(() => { pokeTimer = null; poll(); }, 150);
}

// ── Lifecycle (driven by ProfileContext) ───────────────────────────────────────
/** Point the heartbeat + poll at the current user and their opt-out flag. */
export function syncOnlineStatus(userId: string | null, enabled: boolean) {
  const wasEnabled = myEnabled;
  myUserId = userId;
  myEnabled = enabled;
  if (userId && enabled) startHeartbeat(); else stopHeartbeat();
  if (!userId) { wanted.clear(); stopIfIdle(); }
  if (wasEnabled !== enabled) poll(); // re-pull now (clears instantly when turned off)
}

// ── Hook: is this user online right now? ───────────────────────────────────────
export function useIsOnline(userId?: string | null): boolean {
  // Never a dot on myself, and null when presence isn't wanted for this avatar.
  const id = userId && userId !== myUserId ? userId : null;
  const [, force] = useState(0);
  useEffect(() => {
    if (!id) return;
    const l = () => force((n) => n + 1);
    listeners.add(l);
    wanted.set(id, (wanted.get(id) ?? 0) + 1);
    ensurePolling();
    pokePoll();
    return () => {
      listeners.delete(l);
      const n = (wanted.get(id) ?? 1) - 1;
      if (n <= 0) wanted.delete(id); else wanted.set(id, n);
      stopIfIdle();
    };
  }, [id]);
  return id ? online.has(id) : false;
}

// ── Hook: who is active right now for the "Active now" rail? ────────────────────
// Up to `limit` users online this moment, with the caller's own people (passed in
// `prefer`, friends first) ahead of everyone else — the server (active_now) fills any
// slots still open with other online users, so the rail shows faces even on a near-
// empty app yet never a stranger while your own people fill it. Its own light poll on
// the shared cadence; pass `prefer = null` when the viewer has Active Status off (the
// rail then shows nothing, which the server enforces too).
export function useActiveNow(prefer: string[] | null, limit = 5): string[] {
  const [ids, setIds] = useState<string[]>([]);
  const key = prefer ? prefer.join(',') : null;
  useEffect(() => {
    if (key === null) { setIds([]); return; }
    let live = true;
    const run = async () => {
      try {
        const { data, error } = await supabase.rpc('active_now', { p_prefer: prefer ?? [], p_limit: limit });
        if (!error && live) setIds(((data ?? []) as { id: string }[]).map((r) => r.id));
      } catch { /* offline / pre-migration — keep the last set */ }
    };
    run();
    const timer = setInterval(run, POLL_MS);
    return () => { live = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, limit]);
  return ids;
}
