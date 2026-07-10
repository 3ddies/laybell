import { Component, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

// AirPlay route button for Laybell TV — the iPhone path to Apple TV and the
// AirPlay-2 smart TVs most people own (Samsung, LG, Sony, Vizio, Roku 2019+).
//
// Uses expo-video's built-in VideoAirPlayButton (an AVRoutePickerView), so there
// is NO custom native module: tapping it opens the system AirPlay picker, and
// because the video player keeps `allowsExternalPlayback` on (AVPlayer's
// default), selecting a device streams the CURRENTLY PLAYING Laybell TV video —
// video only, not a mirror of the whole app — to that screen.
//
// Guarded three ways so it can never crash a binary: iOS-only, the require is
// wrapped, and an error boundary swallows a missing native view (e.g. a dev
// client built before this expo-video view existed) by rendering nothing.

let VideoAirPlayButton: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  VideoAirPlayButton = require('expo-video').VideoAirPlayButton;
} catch { /* expo-video without the AirPlay view — renders null */ }

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function AirPlayButton({ size = 24, tint = '#fff', activeTint = '#F26522' }: {
  size?: number; tint?: string; activeTint?: string;
}) {
  // AirPlay is Apple-only; Android reaches TVs via Google Cast (CastButton).
  if (Platform.OS !== 'ios' || !VideoAirPlayButton) return null;
  return (
    <Boundary>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <VideoAirPlayButton tint={tint} activeTint={activeTint} style={{ width: size, height: size }} />
      </View>
    </Boundary>
  );
}
