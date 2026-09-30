-- ==============================================================================
-- Demo data for Sitting Time Tracker (Optional)
-- Run this in the Supabase SQL editor if you want to preview the dashboard with sample sessions.
-- ==============================================================================

insert into public.sitting_sessions (started_at, ended_at, duration_seconds) values
  -- Past days
  (now() - interval '6 days' + interval '9 hours', now() - interval '6 days' + interval '10 hours 45 minutes', 6300),
  (now() - interval '6 days' + interval '14 hours', now() - interval '6 days' + interval '17 hours 10 minutes', 11400),
  (now() - interval '5 days' + interval '9 hours 30 minutes', now() - interval '5 days' + interval '12 hours', 9000),
  (now() - interval '5 days' + interval '13 hours 30 minutes', now() - interval '5 days' + interval '18 hours', 16200),
  (now() - interval '4 days' + interval '10 hours', now() - interval '4 days' + interval '13 hours', 10800),
  (now() - interval '3 days' + interval '9 hours', now() - interval '3 days' + interval '11 hours 30 minutes', 9000),
  (now() - interval '3 days' + interval '13 hours', now() - interval '3 days' + interval '16 hours 45 minutes', 13500),
  (now() - interval '2 days' + interval '9 hours 15 minutes', now() - interval '2 days' + interval '12 hours 15 minutes', 10800),
  (now() - interval '2 days' + interval '14 hours', now() - interval '2 days' + interval '17 hours 30 minutes', 12600),
  (now() - interval '1 day' + interval '9 hours', now() - interval '1 day' + interval '12 hours 40 minutes', 13200),
  (now() - interval '1 day' + interval '14 hours', now() - interval '1 day' + interval '18 hours 15 minutes', 15300),
  -- Today's completed sessions
  (date_trunc('day', now()) + interval '9 hours', date_trunc('day', now()) + interval '10 hours 45 minutes', 6300),
  (date_trunc('day', now()) + interval '11 hours 15 minutes', date_trunc('day', now()) + interval '13 hours', 6300);
