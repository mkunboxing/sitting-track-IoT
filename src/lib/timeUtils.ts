/**
 * Formats duration in seconds into HH:MM:SS format (e.g., 01:24:05)
 */
export function formatHMS(totalSeconds: number): string {
  if (isNaN(totalSeconds) || totalSeconds < 0) return '00:00:00';
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);

  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

/**
 * Formats duration in seconds into a friendly human-readable format (e.g., "2h 45m" or "32m 10s")
 */
export function formatFriendlyDuration(totalSeconds: number): string {
  if (isNaN(totalSeconds) || totalSeconds <= 0) return '0s';
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);

  if (hrs > 0) {
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }
  if (mins > 0) {
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  return `${secs}s`;
}

/**
 * Formats an ISO date string into a local 12-hour or 24-hour time string (e.g., "02:45 PM")
 */
export function formatTimeOnly(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '--:--';
  }
}

/**
 * Calculates the exact duration (in seconds) of a session that falls within a given day interval.
 * Solves the midnight crossing edge case:
 * If a session began at 23:45 yesterday and ended at 00:30 today,
 * only the 30 minutes from 00:00:00 to 00:30:00 are credited to today.
 */
export function calculateSessionOverlapWithInterval(
  startedAt: string | Date,
  endedAt: string | Date | null,
  intervalStart: Date,
  intervalEnd: Date
): number {
  const startMs = new Date(startedAt).getTime();
  const endMs = endedAt ? new Date(endedAt).getTime() : Date.now();

  const windowStartMs = intervalStart.getTime();
  const windowEndMs = intervalEnd.getTime();

  const effectiveStart = Math.max(startMs, windowStartMs);
  const effectiveEnd = Math.min(endMs, windowEndMs);

  if (effectiveEnd <= effectiveStart) {
    return 0;
  }

  return Math.floor((effectiveEnd - effectiveStart) / 1000);
}
