// Screens that load at launch without being on screen — the other tabs, which all
// mount with Home — wait for Home's first paint, so on a cold start the feed has the
// network and the JS thread to itself (1.0.4). afterHomePaint() resolves when Home
// reports that paint, or after MAX_WAIT_MS, whichever comes first. A screen the user
// actually opens must not wait at all: it starts on focus (see app/(tabs)/explore).
// Tested in scripts/tests/test-screencache.mjs.

const MAX_WAIT_MS = 2500;
let painted = false;
const waiters = new Set<() => void>();

export function markHomePainted(): void {
  if (painted) return;
  painted = true;
  const pending = [...waiters];
  waiters.clear();
  pending.forEach((w) => w());
}

export function afterHomePaint(maxWaitMs = MAX_WAIT_MS): Promise<void> {
  if (painted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, maxWaitMs);
    waiters.add(done);
  });
}
