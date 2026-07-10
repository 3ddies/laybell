import { View } from 'react-native';
import { castNativeAvailable, useCast } from '../contexts/CastContext';

// The native Google Cast button (the little "screen with waves" icon). Tapping
// it opens the system device picker and, once connected, the disconnect sheet —
// all handled by the native view.
//
// Renders NOTHING when the Cast SDK isn't in this binary, or when no Cast device
// is on the network, so it never shows a dead icon. Scoped to Laybell TV
// surfaces (the header + viewers) so only TV content is ever castable.

let RNGC: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RNGC = require('react-native-google-cast');
} catch { /* native module absent — component renders null */ }

export default function CastButton({ size = 24, tint = '#fff' }: { size?: number; tint?: string }) {
  const { available, connected } = useCast();
  if (!castNativeAvailable || !RNGC?.CastButton) return null;
  // Show it whenever a device exists OR we're already connected (so the user can
  // disconnect); hide it entirely when there's nothing to cast to.
  if (!available && !connected) return null;
  const Native = RNGC.CastButton;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Native style={{ width: size, height: size, tintColor: tint }} tintColor={tint} />
    </View>
  );
}
