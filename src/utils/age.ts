/**
 * How long ago something happened, coarsely: `12s`, `4m`, `2h 5m`.
 *
 * Coarse on purpose — it answers "has this been held for a while?" in a table
 * or an error message, where seconds past the first minute are noise.
 */
export function formatAge(since: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
