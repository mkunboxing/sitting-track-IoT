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

export interface TimezoneDayInterval {
  date: string;
  dayName: string;
  startUtc: Date;
  endUtc: Date;
}

export interface TimezoneBoundariesResult {
  timeZone: string;
  todayDate: string;
  todayDayName: string;
  todayStartUtc: Date;
  todayEndUtc: Date;
  sevenDaysAgoUtc: Date;
  weeklyIntervals: TimezoneDayInterval[];
}

/**
 * Calculates the millisecond difference between a timezone and UTC.
 */
function getTimeZoneOffsetMs(date: Date, targetTz: string): number {
  try {
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: targetTz }));
    return tzDate.getTime() - utcDate.getTime();
  } catch {
    return 0;
  }
}

/**
 * Converts local calendar parts (year, month, day, hour, etc.) in a target timezone into a UTC Date.
 */
export function getUtcForLocalTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  targetTz: string,
  tzOffsetMinutes?: number | null
): Date {
  const baseUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  let offsetMs = 0;
  if (typeof tzOffsetMinutes === 'number' && !isNaN(tzOffsetMinutes)) {
    offsetMs = -tzOffsetMinutes * 60 * 1000;
  } else {
    offsetMs = getTimeZoneOffsetMs(baseUtc, targetTz);
  }
  return new Date(baseUtc.getTime() - offsetMs);
}

/**
 * Computes exact UTC boundaries for "Today" and the past 7 days based on the user's local timezone.
 * Solves the issue where production servers running in UTC (e.g., Vercel) calculate "today" differently
 * from a user's local time (e.g., IST UTC+5:30).
 */
export function getTimezoneDayBoundaries(
  now: Date = new Date(),
  requestedTz?: string | null,
  tzOffsetMinutes?: number | null
): TimezoneBoundariesResult {
  let timeZone = requestedTz || 'UTC';
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
  } catch {
    timeZone = 'UTC';
  }

  // Get current local calendar components in the user's timezone
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });

  const parts = dtf.formatToParts(now);
  const localYear = parseInt(parts.find((p) => p.type === 'year')?.value || '1970', 10);
  const localMonth = parseInt(parts.find((p) => p.type === 'month')?.value || '1', 10);
  const localDay = parseInt(parts.find((p) => p.type === 'day')?.value || '1', 10);
  const localWeekday = parts.find((p) => p.type === 'weekday')?.value || 'Thu';

  const pad = (n: number) => String(n).padStart(2, '0');
  const todayDate = `${localYear}-${pad(localMonth)}-${pad(localDay)}`;

  const todayStartUtc = getUtcForLocalTime(localYear, localMonth, localDay, 0, 0, 0, 0, timeZone, tzOffsetMinutes);
  const todayEndUtc = getUtcForLocalTime(localYear, localMonth, localDay, 23, 59, 59, 999, timeZone, tzOffsetMinutes);

  // Compute past 7 days (index 0 = 6 days ago, index 6 = today)
  const weeklyIntervals: TimezoneDayInterval[] = [];
  for (let i = 6; i >= 0; i--) {
    const ref = new Date(Date.UTC(localYear, localMonth - 1, localDay - i));
    const y = ref.getUTCFullYear();
    const m = ref.getUTCMonth() + 1;
    const d = ref.getUTCDate();

    const startUtc = getUtcForLocalTime(y, m, d, 0, 0, 0, 0, timeZone, tzOffsetMinutes);
    const endUtc = getUtcForLocalTime(y, m, d, 23, 59, 59, 999, timeZone, tzOffsetMinutes);
    const dayName = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(startUtc);
    const dateStr = `${y}-${pad(m)}-${pad(d)}`;

    weeklyIntervals.push({
      date: dateStr,
      dayName,
      startUtc,
      endUtc,
    });
  }

  const sevenDaysAgoUtc = weeklyIntervals[0].startUtc;

  return {
    timeZone,
    todayDate,
    todayDayName: localWeekday,
    todayStartUtc,
    todayEndUtc,
    sevenDaysAgoUtc,
    weeklyIntervals,
  };
}

