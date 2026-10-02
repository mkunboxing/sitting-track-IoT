/** Posture while occupied, classified by the device from the distance reading */
export type PostureState = 'relaxing' | 'attentive';

export interface SittingSession {
  id: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  /** Current posture stretch (null on closed sessions / legacy rows) */
  posture_state: PostureState | null;
  /** When the current posture stretch started; null on legacy rows */
  posture_changed_at: string | null;
  /** Completed relaxing seconds; the running stretch is computed from posture_changed_at */
  relax_seconds: number;
  /** Completed attentive seconds; the running stretch is computed from posture_changed_at */
  attentive_seconds: number;
  created_at: string;
}

export type SittingStatus = 'RELAXING' | 'ATTENTIVE' | 'AWAY';

export interface DayStats {
  date: string; // YYYY-MM-DD
  dayName: string; // Mon, Tue, etc.
  totalSeconds: number;
  sessionCount: number;
  /** Portion of totalSeconds spent relaxing (0 for pre-posture days) */
  relaxSeconds: number;
  /** Portion of totalSeconds spent attentive (0 for pre-posture days) */
  attentiveSeconds: number;
  /** totalSeconds - relax - attentive: sessions recorded before posture tracking existed */
  unclassifiedSeconds: number;
}

export interface DashboardStatsResponse {
  status: SittingStatus;
  activeSession: SittingSession | null;
  activeDurationSeconds: number;
  /** Active session: completed columns + the running stretch, computed server-side */
  activeRelaxSeconds: number;
  activeAttentiveSeconds: number;
  todayTotalSeconds: number;
  /** Today's relaxing total across all sessions, including the live stretch */
  todayRelaxSeconds: number;
  /** Today's attentive total across all sessions, including the live stretch */
  todayAttentiveSeconds: number;
  todaySessionCount: number;
  todayLongestSessionSeconds: number;
  todaySessions: SittingSession[];
  weeklyStats: DayStats[];
  lastUpdated: string;
  configured: boolean;
  /** Latest ultrasonic reading from the device (in-memory, not persisted) */
  distanceCm?: number | null;
  distanceUpdatedAt?: string | null;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}
