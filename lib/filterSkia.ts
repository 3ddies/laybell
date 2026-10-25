import * as FileSystem from 'expo-file-system/legacy';
import { skiaColorMatrix } from './filters';

// Bake a color filter into a JPEG with Skia — GPU-accelerated (milliseconds), unlike the
// pure-JS jpeg-js path which was unusably slow in Hermes, and unlike RN's `filter` style
// which renders no color effects on iOS. Used for BOTH the editor/chip previews and the
// final upload (a post renders in many surfaces, so the filter is baked into the pixels and
// every surface shows it with zero render-site changes). On any failure the ORIGINAL uri is
// returned, so a filter bake can never block posting or crash the editor.
//
// Skia is a NATIVE module, so it is imported LAZILY (inside a try/catch): on a dev build
// that predates adding Skia, the import throws and we return the original uri — filters
// quietly no-op instead of crashing, and start working after the client is rebuilt.
//
// `width` scales the output (never upscales): small for fast preview/thumbnail bakes; OMIT
// for the final capture so it keeps the source resolution (a cap here was making filtered
// photos look soft next to unfiltered ones). `quality` is the JPEG quality 0..100 — high for
// the final bake, the default is fine for tiny chips.

let skiaMod: typeof import('@shopify/react-native-skia') | null = null;
async function loadSkia() {
  if (!skiaMod) skiaMod = await import('@shopify/react-native-skia');
  return skiaMod;
}

export async function bakeFilter(uri: string, filterKey: string, width?: number, quality = 92): Promise<string> {
  const matrix = skiaColorMatrix(filterKey);
  if (!matrix) return uri; // 'original'/unknown — nothing to bake
  try {
    const { Skia, ImageFormat } = await loadSkia();
    const data = await Skia.Data.fromURI(uri);
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) return uri;
    const iw = image.width(), ih = image.height();
    if (!iw || !ih) return uri;
    const w = width && width < iw ? Math.round(width) : iw;
    const h = Math.max(1, Math.round((w * ih) / iw));

    const surface = Skia.Surface.MakeOffscreen(w, h);
    if (!surface) return uri;
    const canvas = surface.getCanvas();
    const paint = Skia.Paint();
    paint.setColorFilter(Skia.ColorFilter.MakeMatrix(matrix));
    canvas.drawImageRect(image, Skia.XYWHRect(0, 0, iw, ih), Skia.XYWHRect(0, 0, w, h), paint);
    surface.flush();

    const snapshot = surface.makeImageSnapshot();
    // CPU-side copy before encoding (a GPU texture image can't be safely encoded off-thread).
    const b64 = (snapshot.makeNonTextureImage() ?? snapshot).encodeToBase64(ImageFormat.JPEG, quality);
    if (!b64) return uri;

    const out = `${FileSystem.cacheDirectory}fx_${Date.now()}_${Math.round(Math.random() * 1e6)}.jpg`;
    await FileSystem.writeAsStringAsync(out, b64, { encoding: FileSystem.EncodingType.Base64 });
    return out;
  } catch {
    return uri; // native module missing (pre-rebuild) or any failure — no crash, no filter
  }
}
