import { useEffect, useState, useSyncExternalStore } from 'react';

// ── One camera view at a time ─────────────────────────────────────────────────
// The story camera stays mounted on its page while another camera (the composer's, or
// the collage builder's) opens over it, and on Android two camera views break each
// other: `active` is iOS-only, a view binds through CameraX's process-wide unbindAll()
// and calls it again when it's destroyed, and a bound view never re-binds by itself
// (ExpoCameraView.kt) — so the first camera would sit black after the second closes.
// Only the newest open camera renders a CameraView; an older one keeps its place and
// settings over black and gets a fresh view once the newer one has closed — a beat
// later, so the old view's teardown has run before the next one binds.
//
// This coordinator is a process-wide singleton shared by every CameraView host
// (components/CaptureCamera.tsx, components/CollageCamera.tsx), so they hand the one
// live camera off between each other instead of fighting over it.
const HANDOVER_MS = 150;
const openCameras: number[] = [];
const turnListeners = new Set<() => void>();
let lastCameraId = 0;

function subscribeTurns(listener: () => void) {
  turnListeners.add(listener);
  return () => { turnListeners.delete(listener); };
}

// Returns whether THIS camera instance currently owns the single live camera. Mounting
// a newer camera takes the turn (after a short settle so the older view has torn down);
// losing the turn is immediate.
export function useCameraTurn(): boolean {
  const [id] = useState(() => ++lastCameraId);
  useEffect(() => {
    openCameras.push(id);
    turnListeners.forEach((listener) => listener());
    return () => {
      const i = openCameras.indexOf(id);
      if (i >= 0) openCameras.splice(i, 1);
      turnListeners.forEach((listener) => listener());
    };
  }, [id]);
  const newest = useSyncExternalStore(subscribeTurns, () => openCameras[openCameras.length - 1] === id);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!newest) return;
    const timer = setTimeout(() => setSettled(true), HANDOVER_MS);
    return () => clearTimeout(timer);
  }, [newest]);
  return newest && settled; // losing the turn is immediate; getting it waits the beat
}
