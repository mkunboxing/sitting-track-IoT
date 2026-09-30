-- ==============================================================================
-- Sitting Time Tracker - Supabase Database Schema
-- ==============================================================================

-- 1. Create the sitting_sessions table
create table if not exists public.sitting_sessions (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds bigint,
  created_at timestamptz not null default now()
);

-- 2. Partial unique index: Guarantee that at most ONE session can be active (ended_at IS NULL)
-- This enforces at the database level that multiple active sessions cannot be created concurrently.
create unique index if not exists idx_sitting_sessions_one_active
  on public.sitting_sessions ((ended_at is null))
  where ended_at is null;

-- 3. Performance indexes
-- Fast lookup for the latest sessions and range queries for today/weekly stats
create index if not exists idx_sitting_sessions_started_at
  on public.sitting_sessions (started_at desc);

create index if not exists idx_sitting_sessions_ended_at
  on public.sitting_sessions (ended_at desc);

-- 4. Enable Row Level Security (RLS)
alter table public.sitting_sessions enable row level security;

-- 5. Policies
-- The Next.js backend uses the Supabase service-role key, which automatically bypasses RLS.
-- For dashboard read access or optional anonymous read (if needed):
create policy "Allow server full access"
  on public.sitting_sessions
  for all
  using (true)
  with check (true);

-- 6. Helper function to safely stop an active session with server-calculated duration
create or replace function public.stop_active_session()
returns table (
  id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds bigint,
  created_at timestamptz
) language plpgsql as $$
declare
  active_id uuid;
  now_ts timestamptz := clock_timestamp();
begin
  -- Find currently active session
  select s.id into active_id
  from public.sitting_sessions s
  where s.ended_at is null
  order by s.started_at desc
  limit 1;

  if active_id is not null then
    return query
    update public.sitting_sessions s
    set
      ended_at = now_ts,
      duration_seconds = extract(epoch from (now_ts - s.started_at))::bigint
    where s.id = active_id
    returning s.id, s.started_at, s.ended_at, s.duration_seconds, s.created_at;
  end if;
end;
$$;
