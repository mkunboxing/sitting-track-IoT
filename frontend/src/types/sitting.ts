export interface SittingSession {
  id: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export type SittingStatus = 'SITTING' | 'AWAY';

export interface DayStats {
  date: string; // YYYY-MM-DD
  dayName: string; // Mon, Tue, etc.
  totalSeconds: number;
  sessionCount: number;
}

export interface DashboardStatsResponse {
  status: SittingStatus;
  activeSession: SittingSession | null;
  activeDurationSeconds: number;
  todayTotalSeconds: number;
  todaySessionCount: number;
  todayLongestSessionSeconds: number;
  todaySessions: SittingSession[];
  weeklyStats: DayStats[];
  lastUpdated: string;
  configured: boolean;
  /** Latest ultrasonic reading from the device (pushed via SSE / included in status) */
  distanceCm?: number | null;
  distanceUpdatedAt?: string | null;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}
