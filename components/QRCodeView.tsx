import { useMemo } from 'react';
import { View } from 'react-native';
import QRCode from 'qrcode';

// Pure-JS QR renderer — no native module, so it works on the current dev client
// with no rebuild. `qrcode` resolves to its browser build under Metro (see the
// package "browser" field), so only the generation core is bundled. We take the
// boolean module matrix it produces and draw it with plain Views.

type Props = {
  value: string;
  size?: number;
  /** Dark module colour. */
  color?: string;
  /** Light background behind the code (keep it light so scanners get contrast). */
  background?: string;
  /** Error-correction level — 'M' balances density and scannability. */
  level?: 'L' | 'M' | 'Q' | 'H';
};

export default function QRCodeView({
  value,
  size = 220,
  color = '#000000',
  background = '#ffffff',
  level = 'M',
}: Props) {
  const { count, segments } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: level });
    const n = qr.modules.size;
    const data = qr.modules.data;
    // Coalesce each row's runs of dark modules into single rectangles, so a
    // ~33×33 code renders as a few dozen Views instead of ~1,000.
    const segs: { x: number; y: number; w: number }[] = [];
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (data[r * n + c]) {
          let w = 1;
          while (c + w < n && data[r * n + c + w]) w++;
          segs.push({ x: c, y: r, w });
          c += w;
        } else {
          c++;
        }
      }
    }
    return { count: n, segments: segs };
  }, [value, level]);

  const cell = size / count;

  return (
    <View style={{ width: size, height: size, backgroundColor: background }}>
      {segments.map((s, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: s.x * cell,
            top: s.y * cell,
            // Round-up overlap avoids hairline seams between adjacent rows/cells.
            width: s.w * cell + 0.5,
            height: cell + 0.5,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}
