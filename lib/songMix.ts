// A post's sound: how its attached song and the video's own audio play together,
// and which part of the song plays. Set in the composer's video studio
// (components/VideoStudio, 1.0.3). Pure, so it is tested in plain Node.
//
// Stored as song_start_sec / song_volume / video_volume on the post
// (supabase/sql/post_song_mix.sql). A post published without the editor has none
// of them and plays exactly as before — the song from its first second at full
// volume, the video silent, each looping on its own — and so does every post on
// an app older than 1.0.3, which never reads the columns.

export type SongMix = {
  /** Seconds into the song where it starts. */
  startSec: number;
  /** The song's level, 0..1. */
  songVolume: number;
  /** The video's own sound, 0..1. */
  videoVolume: number;
};

/** What the editor opens on: today's behaviour — the song at full, the video silent. */
export const DEFAULT_MIX: SongMix = { startSec: 0, songVolume: 1, videoVolume: 0 };

/**
 * What the ambient song player needs for a post (contexts/PostMusicContext).
 * `startSec` null is a legacy post: the song starts at 0 and loops on its own,
 * never re-synced to the video.
 */
export type AmbientMix = {
  startSec: number | null;
  volume: number;
  /** The video's first second on its own clock (trim_start), for lining the song up with it. */
  videoStartSec: number;
};

type MixColumns = {
  song_start_sec?: unknown;
  song_volume?: unknown;
  video_volume?: unknown;
  trim_start?: unknown;
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const floor1 = (n: number) => Math.floor(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 0..1; anything that is not a finite number is 0. */
export function clamp01(v: unknown): number {
  return isNum(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** The mix a post was published with. `custom` is false for a post without one. */
export function mixFromPost(post: MixColumns | null | undefined): SongMix & { custom: boolean } {
  const s = post?.song_start_sec;
  const sv = post?.song_volume;
  const vv = post?.video_volume;
  const start = isNum(s) && s >= 0 ? s : null;
  const song = isNum(sv) ? clamp01(sv) : null;
  const video = isNum(vv) ? clamp01(vv) : null;
  return {
    startSec: start ?? 0,
    songVolume: song ?? 1,
    videoVolume: video ?? 0,
    custom: start != null || song != null || video != null,
  };
}

/** The ambient player's view of a post's mix. */
export function ambientMixFor(post: MixColumns | null | undefined): AmbientMix {
  const m = mixFromPost(post);
  const ts = post?.trim_start;
  return {
    startSec: m.custom ? m.startSec : null,
    volume: m.songVolume,
    videoStartSec: isNum(ts) && ts > 0 ? ts : 0,
  };
}

/**
 * The video's own sound for a post whose song is playing. `songMuted` is the
 * app-wide ambient mute: the one sound button silences both, as it always
 * silenced the song.
 */
export function videoSoundFor(post: MixColumns | null | undefined, songMuted: boolean): { muted: boolean; volume: number } {
  const { videoVolume } = mixFromPost(post);
  return { muted: songMuted || videoVolume <= 0, volume: videoVolume };
}

/**
 * The latest start that still leaves a whole window of song — a 15-second video
 * cannot start 5 seconds before a song ends and fill with it. Tenths of a second,
 * rounded down so the result never passes the latest start. An unknown song
 * length leaves the start alone.
 */
export function clampStart(startSec: number, songSec: number, windowSec: number): number {
  const s = isNum(startSec) ? Math.max(0, startSec) : 0;
  if (!(songSec > 0)) return floor1(s);
  const fit = Math.max(0, Math.min(isNum(windowSec) ? windowSec : 0, songSec));
  return floor1(Math.min(s, Math.max(0, songSec - fit)));
}

/**
 * Where the song should be while the video is at `videoSec` on its own clock: the
 * chosen start plus however far the video is past its first second. A song that
 * runs out before the video does wraps to the chosen start, the way the player
 * loops it. An unknown song length (0) never wraps.
 */
export function songPositionFor(startSec: number, videoSec: number, videoStartSec: number, songSec: number): number {
  const start = isNum(startSec) ? Math.max(0, startSec) : 0;
  const offset = Math.max(0, (isNum(videoSec) ? videoSec : 0) - (isNum(videoStartSec) ? videoStartSec : 0));
  let pos = start + offset;
  if (songSec > start && pos >= songSec) pos = start + ((pos - start) % (songSec - start));
  return round2(pos);
}

/** A video's clock jumping back by more than a second: it looped, or was scrubbed back. */
export function isVideoWrap(prevSec: number, nextSec: number): boolean {
  return isNum(prevSec) && isNum(nextSec) && nextSec < prevSec - 1;
}

export function percent(v: number): number {
  return Math.round(clamp01(v) * 100);
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(isNum(sec) ? sec : 0));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/** A mix as post columns: clamped and rounded, ready to insert. */
export function mixColumns(mix: SongMix): { song_start_sec: number; song_volume: number; video_volume: number } {
  return {
    song_start_sec: floor1(isNum(mix.startSec) ? Math.max(0, mix.startSec) : 0),
    song_volume: round2(clamp01(mix.songVolume)),
    video_volume: round2(clamp01(mix.videoVolume)),
  };
}
