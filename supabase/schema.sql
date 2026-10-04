-- ==============================================================================
-- Sitting Time Tracker - Supabase Database Schema
-- ==============================================================================

-- 1. Create the sitting_sessions table
create table if not exists public.sitting_sessions (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds bigint,
  last_heartbeat_at timestamptz default now(),
  posture_state text,
  posture_changed_at timestamptz,
  relax_seconds bigint not null default 0,
  attentive_seconds bigint not null default 0,
  created_at timestamptz not null default now()
);

-- Migration safety: Add columns if existing table was already created
alter table public.sitting_sessions add column if not exists last_heartbeat_at timestamptz default now();

-- Posture tracking: per-session relaxing/attentive time split
alter table public.sitting_sessions
  add column if not exists posture_state text,
  add column if not exists posture_changed_at timestamptz,
  add column if not exists relax_seconds bigint not null default 0,
  add column if not exists attentive_seconds bigint not null default 0;

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

-- 6. User authentication: dashboard accounts (bcrypt hashes, never plaintext)
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Case-insensitive unique usernames (duplicate signups rejected at the DB level)
create unique index if not exists idx_users_username_lower
  on public.users (lower(username));

-- 7. Persistent login sessions (no expiry — valid until logout / invalidation).
-- The HttpOnly cookie carries a random 256-bit token; only its SHA-256 hash
-- is stored here.
create table if not exists public.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null,
  login_at timestamptz not null default now(),
  logout_at timestamptz,
  active boolean not null default true
);

create unique index if not exists idx_auth_sessions_token_hash
  on public.auth_sessions (token_hash);

create index if not exists idx_auth_sessions_user_id
  on public.auth_sessions (user_id);

-- 8. Device registry + ownership (device_id = firmware DEVICE_ID / MQTT topic
--    segment; user_id null = unlinked and invisible in every dashboard;
--    device_secret = optional bcrypt-hashed PIN required to claim the device)
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  user_id uuid references public.users(id) on delete set null,
  name text not null default 'Desk Sensor',
  device_secret text,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_devices_device_id
  on public.devices (device_id);

create index if not exists idx_devices_user_id
  on public.devices (user_id);

-- 9. Per-user sitting-session attribution (new sessions are stamped by the
--    telemetry pipeline from the device's owner; user_id null = unlinked)
alter table public.sitting_sessions
  add column if not exists user_id uuid references public.users(id) on delete set null,
  add column if not exists device_id text;

create index if not exists idx_sitting_sessions_user_id
  on public.sitting_sessions (user_id);

create index if not exists idx_sitting_sessions_device_id
  on public.sitting_sessions (device_id);

-- 10. RLS on the auth/device tables (service-role key bypasses, as above)
alter table public.users enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.devices enable row level security;

create policy "Allow server full access"
  on public.users for all
  using (true) with check (true);

create policy "Allow server full access"
  on public.auth_sessions for all
  using (true) with check (true);

create policy "Allow server full access"
  on public.devices for all
  using (true) with check (true);

-- 11. Helper function to safely stop an active session with server-calculated duration
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
