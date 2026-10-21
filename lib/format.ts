// Counts for the UI. The full number shows through 9,999 — every digit of a
// like / share / save count reads as "this is taking off" in a way "1.3k" never
// does, and the extra digits are what make the number feel earned. Only once a
// count reaches five digits does it abbreviate (10k, 10.5k, 1.2M), where the raw
// number would be too wide for a button. A trailing ".0" is dropped so the short
// forms stay tidy (10k, not 10.0k).
export function formatCount(n?: number | null): string {
  if (!n || n <= 0) return '0';
  if (n < 10_000) return String(Math.round(n)); // 1 … 9999 — show every digit
  const unit = n >= 1_000_000 ? 1_000_000 : 1_000;
  const v = n / unit;
  // One decimal while the mantissa is small (10.5k, 1.2M); none once it is large
  // (250k, 12M), where a decimal would read as noise rather than precision.
  const s = v.toFixed(v < 100 ? 1 : 0).replace(/\.0$/, '');
  return `${s}${unit === 1_000_000 ? 'M' : 'k'}`;
}

// Human-readable byte sizes for storage UI (0 -> "0 MB", 1.5e9 -> "1.5 GB").
export function formatBytes(bytes?: number | null): string {
  const b = bytes ?? 0;
  if (b <= 0) return '0 MB';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(b >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}
