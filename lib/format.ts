// Abbreviated counts for UI (1234 -> "1.2k", 2_000_000 -> "2M").
export function formatCount(n?: number | null): string {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
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
