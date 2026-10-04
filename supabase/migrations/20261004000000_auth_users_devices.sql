-- ==============================================================================
-- Migration: User authentication + device ownership
-- ==============================================================================
-- Adds:
--   users          — dashboard accounts (bcrypt password hashes, never plaintext)
--   auth_sessions  — persistent login sessions (cookie token hashes; no expiry —
--                    a session stays valid until logout or manual invalidation)
--   devices        — Arduino/device registry and ownership linking
--   sitting_sessions.user_id / device_id — per-user session attribution
--
-- Run this in the Supabase SQL editor BEFORE backend/scripts/migrate-auth.ts
-- (the script then creates the admin account, assigns existing sessions to it
-- and links your device).
-- ==============================================================================

-- ── 1. users ──────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Case-insensitive unique usernames (duplicate signups rejected at the DB level)
create unique index if not exists idx_users_username_lower
  on public.users (lower(username));

-- ── 2. auth_sessions (persistent — no expiry) ────────────────────────────────
-- The HttpOnly cookie carries a random 256-bit token; only its SHA-256 hash is
-- stored here. active = false + logout_at set = logged out / invalidated.
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

-- ── 3. devices (device registry + ownership) ─────────────────────────────────
-- device_id matches the firmware's DEVICE_ID (MQTT topic segment), so it is
-- restricted to URL/topic-safe characters. user_id is null = unlinked (its data
-- is visible in nobody's dashboard). device_secret is an optional bcrypt-hashed
-- PIN a user must present to claim an unlinked device.
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

-- ── 4. sitting_sessions: per-user attribution ────────────────────────────────
alter table public.sitting_sessions
  add column if not exists user_id uuid references public.users(id) on delete set null,
  add column if not exists device_id text;

create index if not exists idx_sitting_sessions_user_id
  on public.sitting_sessions (user_id);

create index if not exists idx_sitting_sessions_device_id
  on public.sitting_sessions (device_id);

-- ── 5. RLS (service-role key bypasses these, matching the existing pattern) ──
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
