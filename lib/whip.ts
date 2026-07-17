// Minimal WHIP (publish) + WHEP (play) clients over react-native-webrtc, used by
// the Live tab against Cloudflare Stream Live. WHIP pushes the phone's camera+mic
// to a live input's webRTC.url; WHEP pulls a broadcast from webRTCPlayback.url
// with sub-second latency. Both speak the same protocol: POST an SDP offer,
// receive an SDP answer, DELETE the returned Location to hang up.
//
// The native module is loaded LAZILY so a dev client built before the webrtc
// natives were added still boots — screens check webrtcAvailable() and show a
// "rebuild required" fallback instead of crashing at import time.

import type { MediaStream, RTCPeerConnection } from '@livekit/react-native-webrtc';

type Webrtc = typeof import('@livekit/react-native-webrtc');

let cached: Webrtc | null = null;
function webrtc(): Webrtc {
  if (!cached) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = require('@livekit/react-native-webrtc') as Webrtc;
  }
  return cached;
}

export function webrtcAvailable(): boolean {
  try {
    return !!webrtc().RTCPeerConnection;
  } catch {
    return false;
  }
}

/** The native video surface, or null in a binary without the webrtc natives. */
export function getRTCView(): Webrtc['RTCView'] | null {
  try {
    return webrtc().RTCView;
  } catch {
    return null;
  }
}

export type Facing = 'front' | 'back';

const ICE = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };

// Cloudflare answers fastest when the offer already carries ICE candidates, so
// wait (briefly) for gathering to finish before POSTing.
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function negotiate(pc: RTCPeerConnection, endpoint: string): Promise<string | null> {
  const offer = await pc.createOffer({});
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription?.sdp ?? offer.sdp,
  });
  if (!res.ok) throw new Error(`whip/whep negotiate failed: ${res.status}`);
  const answer = await res.text();
  const { RTCSessionDescription } = webrtc();
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer }));
  // Location header is the session resource; DELETE it to end cleanly.
  const loc = res.headers.get('Location') ?? res.headers.get('location');
  if (!loc) return null;
  return loc.startsWith('http') ? loc : new URL(loc, endpoint).toString();
}

async function hangUp(pc: RTCPeerConnection | null, resource: string | null) {
  if (resource) {
    try { await fetch(resource, { method: 'DELETE' }); } catch { /* best effort */ }
  }
  try { pc?.close(); } catch { /* already closed */ }
}

// --- Publisher (Go Live) -----------------------------------------------------

export class WhipPublisher {
  private pc: RTCPeerConnection | null = null;
  private resource: string | null = null;
  private facing: Facing = 'front';
  stream: MediaStream | null = null;

  /** Opens the camera+mic and returns the local preview stream (not publishing yet). */
  async openMedia(facing: Facing = 'front'): Promise<MediaStream> {
    this.facing = facing;
    this.stream = await webrtc().mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: facing === 'front' ? 'user' : 'environment',
        width: 1280,
        height: 720,
        frameRate: 30,
      },
    });
    return this.stream;
  }

  /**
   * Flips between the front and back camera and resolves with the facing the
   * publisher is ACTUALLY on afterwards — the flip is only committed when the
   * switch succeeds, so callers can trust the result (e.g. for preview
   * mirroring) and a failed switch changes nothing on screen.
   *
   * We track facing ourselves and apply it explicitly: the fork's
   * _switchCamera() derives the flip from the track's native settings, which
   * don't reliably report facingMode — it then "switches" to the front camera
   * it's already on, forever, which is exactly a dead flip button.
   */
  async switchCamera(): Promise<Facing> {
    const track = this.stream?.getVideoTracks()[0] as unknown as {
      applyConstraints?: (c: Record<string, unknown>) => Promise<unknown>;
      _switchCamera?: () => void;
    } | undefined;
    if (!track) return this.facing;
    const next: Facing = this.facing === 'front' ? 'back' : 'front';
    try {
      if (track.applyConstraints) {
        // Restate the full constraint set — applyConstraints resets any
        // omitted property to its default.
        await track.applyConstraints({
          facingMode: next === 'front' ? 'user' : 'environment',
          width: 1280,
          height: 720,
          frameRate: 30,
        });
      } else if (track._switchCamera) {
        track._switchCamera();
      } else {
        return this.facing;
      }
      this.facing = next;
    } catch { /* switch failed (single-camera device?) — stay put */ }
    return this.facing;
  }

  setMicEnabled(on: boolean): void {
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = on;
  }

  /** Starts pushing the opened media to the live input's WHIP url. */
  async publish(whipUrl: string): Promise<void> {
    if (!this.stream) throw new Error('openMedia() first');
    const { RTCPeerConnection: PC } = webrtc();
    this.pc = new PC(ICE);
    for (const track of this.stream.getTracks()) {
      this.pc.addTransceiver(track, { direction: 'sendonly' });
    }
    this.resource = await negotiate(this.pc, whipUrl);
  }

  async stop(): Promise<void> {
    await hangUp(this.pc, this.resource);
    this.pc = null;
    this.resource = null;
    for (const track of this.stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* ignore */ }
    }
    this.stream = null;
  }
}

// --- Player (watching a webrtc-mode stream) ----------------------------------

export class WhepPlayer {
  private pc: RTCPeerConnection | null = null;
  private resource: string | null = null;
  stream: MediaStream | null = null;

  /** Connects to a WHEP playback url and resolves with the remote stream. */
  async play(whepUrl: string): Promise<MediaStream> {
    const { RTCPeerConnection: PC, MediaStream: MS } = webrtc();
    this.pc = new PC(ICE);
    const remote = new MS(undefined as never);
    this.stream = remote;
    this.pc.addTransceiver('video', { direction: 'recvonly' });
    this.pc.addTransceiver('audio', { direction: 'recvonly' });
    this.pc.addEventListener('track', (ev) => {
      const track = (ev as unknown as { track?: { id: string } }).track;
      if (track) remote.addTrack(track as never);
    });
    this.resource = await negotiate(this.pc, whepUrl);
    return remote;
  }

  async stop(): Promise<void> {
    await hangUp(this.pc, this.resource);
    this.pc = null;
    this.resource = null;
    this.stream = null;
  }
}
