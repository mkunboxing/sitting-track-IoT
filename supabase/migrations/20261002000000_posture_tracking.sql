-- ==============================================================================
-- Posture tracking: split each session into relaxing vs attentive time
-- ==============================================================================
-- Distance bands (classified in firmware, debounced):
--   < 4.5 cm            -> relaxing
--   4.5 - 5 cm          -> deadband, hold previous state
--   > 5 cm  and <= 45   -> attentive
--   > 45 cm / invalid   -> vacant (session closes as before)
--
-- posture_state / posture_changed_at describe the CURRENT stretch inside the
-- active session (null on closed sessions). relax_seconds / attentive_seconds
-- accumulate every COMPLETED stretch; the running stretch is computed as
-- now() - posture_changed_at by the backend.
-- ==============================================================================

alter table public.sitting_sessions
  add column if not exists posture_state text,
  add column if not exists posture_changed_at timestamptz,
  add column if not exists relax_seconds bigint not null default 0,
  add column if not exists attentive_seconds bigint not null default 0;
