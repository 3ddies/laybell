import { supabase } from './supabase';

// Aggregate listening meter — feeds the BMI licence compliance counter.
//
// The BMI agreement terminates AUTOMATICALLY at 20% over the tier's stream-hour
// ceiling (§8), with no warning and no invoice. So the hours have to be measured.
//
// This is deliberately NOT the same thing as lib/streamOutbox / record_stream.
// That path is a CREATOR-CREDIT ledger: it caps self-listens at one lifetime
// stream, collapses repeats inside a 24-hour window, and only fires past duration
// thresholds. Every one of those rules makes it under-count what BMI measures.
// BMI counts hours TRANSMITTED — uncapped, regardless of who listened or how
// often. Two different questions, two different counters.
//
// Batched on purpose: an RPC per second of playback would be absurd, so time
// accumulates locally and flushes about once a minute. Fire-and-forget — a lost
// flush costs a little accuracy in a compliance estimate, and must never
// interfere with playback.

const FLUSH_AT_SECONDS = 60;   // flush once a minute of listening has piled up
const MAX_BATCH_SECONDS = 3600; // matches the server-side sanity cap

let audioMs = 0;
let videoMs = 0;

async function send(seconds: number, kind: 'audio' | 'video'): Promise<void> {
  if (seconds <= 0) return;
  try {
    await supabase.rpc('record_listen_seconds', {
      p_seconds: Math.min(Math.round(seconds), MAX_BATCH_SECONDS),
      p_kind: kind,
    });
  } catch { /* compliance telemetry must never break playback */ }
}

/**
 * Add genuine forward playback time. Callers must pass only real elapsed
 * playback — never a seek, rewind, or the jump at end-of-track — because those
 * were not transmitted and BMI counts transmission.
 */
export function meterPlayback(deltaMs: number, kind: 'audio' | 'video' = 'audio'): void {
  if (!(deltaMs > 0)) return;
  if (kind === 'video') videoMs += deltaMs; else audioMs += deltaMs;

  if (kind === 'video' && videoMs >= FLUSH_AT_SECONDS * 1000) {
    const s = videoMs / 1000; videoMs = 0; send(s, 'video');
  } else if (kind === 'audio' && audioMs >= FLUSH_AT_SECONDS * 1000) {
    const s = audioMs / 1000; audioMs = 0; send(s, 'audio');
  }
}

/**
 * Push whatever is buffered. Call when playback stops or the app backgrounds, so
 * a partial minute isn't lost every session — over months that adds up to a
 * meaningful undercount, and undercounting is the dangerous direction here.
 */
export function flushMeter(): void {
  if (audioMs > 0) { const s = audioMs / 1000; audioMs = 0; send(s, 'audio'); }
  if (videoMs > 0) { const s = videoMs / 1000; videoMs = 0; send(s, 'video'); }
}
