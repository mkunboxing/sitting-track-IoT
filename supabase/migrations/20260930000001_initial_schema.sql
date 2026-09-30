-- ==============================================================================
-- Migration: 20260930000001_initial_schema
-- Description: Initial schema for Sitting Time Tracker
--   - Creates the sitting_sessions table
--   - Adds partial unique index to enforce single active session
--   - Adds performance indexes on started_at / ended_at
--   - Enables Row Level Security with a full-access server policy
--   - Creates stop_active_session() helper function
-- ==============================================================================

-- 1. Create the sitting_sessions table
create table if not exists public.sitting_sessions (
  id                  uuid        primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  duration_seconds    bigint,
  last_heartbeat_at   timestamptz default now(),
  created_at          timestamptz not null default now()
);

-- Migration safety: add column if table already exists without it
alter table public.sitting_sessions
  add column if not exists last_heartbeat_at timestamptz default now();

-- 2. Partial unique index: at most ONE active session (ended_at IS NULL) at any time
create unique index if not exists idx_sitting_sessions_one_active
  on public.sitting_sessions ((ended_at is null))
  where ended_at is null;

-- 3. Performance indexes for time-range queries (today / weekly stats)
create index if not exists idx_sitting_sessions_started_at
  on public.sitting_sessions (started_at desc);

create index if not exists idx_sitting_sessions_ended_at
  on public.sitting_sessions (ended_at desc);

-- 4. Enable Row Level Security
alter table public.sitting_sessions enable row level security;

-- 5. Full-access policy for the service-role key used by the Next.js backend
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'sitting_sessions'
      and policyname = 'Allow server full access'
  ) then
    create policy "Allow server full access"
      on public.sitting_sessions
      for all
      using (true)
      with check (true);
  end if;
end;
$$;

-- 6. Helper function: atomically stop the active session and return the row
create or replace function public.stop_active_session()
returns table (
  id               uuid,
  started_at       timestamptz,
  ended_at         timestamptz,
  duration_seconds bigint,
  created_at       timestamptz
) language plpgsql as $$
declare
  active_id uuid;
  now_ts    timestamptz := clock_timestamp();
begin
  select s.id into active_id
  from public.sitting_sessions s
  where s.ended_at is null
  order by s.started_at desc
  limit 1;

  if active_id is not null then
    return query
    update public.sitting_sessions s
    set
      ended_at         = now_ts,
      duration_seconds = extract(epoch from (now_ts - s.started_at))::bigint
    where s.id = active_id
    returning s.id, s.started_at, s.ended_at, s.duration_seconds, s.created_at;
  end if;
end;
$$;
