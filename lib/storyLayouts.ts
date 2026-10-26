// Photo-collage layouts for the story camera (TikTok-style). Each slot is a normalized
// rect (0..1) inside the story frame, so the SAME definition drives the builder, the
// editor background, the viewer and the thumbnail at any size/aspect. Order matches the
// camera's layout picker (top → bottom).
export type CollageSlotRect = { x: number; y: number; w: number; h: number };
export type CollageLayout = { id: string; slots: CollageSlotRect[] };

const T = 1 / 3;
const TT = 2 / 3;

export const COLLAGE_LAYOUTS: CollageLayout[] = [
  // Two, stacked (top / bottom).
  { id: 'v2', slots: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }] },
  // Two, side by side (left / right).
  { id: 'h2', slots: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }] },
  // Three, stacked.
  { id: 'v3', slots: [{ x: 0, y: 0, w: 1, h: T }, { x: 0, y: T, w: 1, h: T }, { x: 0, y: TT, w: 1, h: T }] },
  // Four, 2×2.
  { id: 'grid4', slots: [
    { x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ] },
  // Six, 2×3.
  { id: 'grid6', slots: [
    { x: 0, y: 0, w: 0.5, h: T }, { x: 0.5, y: 0, w: 0.5, h: T },
    { x: 0, y: T, w: 0.5, h: T }, { x: 0.5, y: T, w: 0.5, h: T },
    { x: 0, y: TT, w: 0.5, h: T }, { x: 0.5, y: TT, w: 0.5, h: T },
  ] },
];

export function getCollageLayout(id: string | null | undefined): CollageLayout | undefined {
  return COLLAGE_LAYOUTS.find((l) => l.id === id);
}

export function collageSlotCount(id: string | null | undefined): number {
  return getCollageLayout(id)?.slots.length ?? 0;
}
