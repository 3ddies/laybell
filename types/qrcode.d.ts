// Minimal ambient types for the pure-JS `qrcode` package. Under Metro the
// package's "browser" field maps its entry to lib/browser.js (and stubs `fs`),
// so only the generation core is bundled — no native module / dev-client rebuild.
declare module 'qrcode' {
  export interface QRCodeMatrix {
    modules: { size: number; data: Uint8Array };
  }
  export interface QRCodeCreateOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    version?: number;
  }
  export function create(text: string, options?: QRCodeCreateOptions): QRCodeMatrix;
  const _default: { create: typeof create };
  export default _default;
}
