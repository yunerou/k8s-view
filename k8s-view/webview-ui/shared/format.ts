/** `kubectl`-style age (ShortHumanDuration): 45s, 5m, 5h, 2d, 2y. */
export function formatAge(timestamp: number, now: number): string {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < -1) return "<invalid>";
  if (seconds < 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  if (hours < 24 * 365) return `${Math.floor(hours / 24)}d`;
  return `${Math.floor(hours / 24 / 365)}y`;
}
