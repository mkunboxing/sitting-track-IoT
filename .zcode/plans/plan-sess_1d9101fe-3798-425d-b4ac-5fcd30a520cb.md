# Posture Tracking: Relaxing / Attentive / Vacant + Separate Timings

## Behavior spec (confirmed)
- Distance **< 4.5 cm → relaxing**; **> 5 cm and ≤ 45 cm → attentive**; **> 45 cm (or invalid/timeout reading) → vacant** (session closes, same as today's "away").
- **4.5–5 cm = deadband: hold previous state** (hysteresis, prevents flapping). If currently vacant and a reading lands in the deadband, classify as attentive.
- Debounce (unchanged timings): 2 s to confirm relaxing/attentive, 5 s to confirm vacant.
- Relax/attentive seconds accumulate **per session in Supabase**; backend exposes today's totals, per-session split, and live active-session split; UI shows them everywhere (full treatment). Weekly chart bars become stacked (attentive green / relaxing sky / unclassified gray for pre-feature data). No sounds/notifications on posture changes — only on session start/end, as today.

---

## 1. Firmware — `firmware/sitting_tracker/sitting_tracker.ino`
- Replace `SITTING_LIMIT_CM = 120.0` (line ~147) with `RELAX_ENTER_CM = 4.5`, `ATTENTIVE_ENTER_CM = 5.0`, `OCCUPANCY_LIMIT_CM = 45.0`; rename confirms to `OCCUPIED_CONFIRM = 2000` / `VACANT_CONFIRM = 5000`.
- `enum State { STATE_VACANT, STATE_RELAXING, STATE_ATTENTIVE }` (line ~172).
- In `loop()` classification (line ~316): `d <= 0 || d > 45 → VACANT`; `d < 4.5 → RELAXING`; `d > 5 → ATTENTIVE`; in deadband → hold `currentState` (or ATTENTIVE if currently vacant).
- `sendStateChange()` (line ~466) sends `"relaxing" | "attentive" | "vacant"`; update serial prints, `syncCurrentState()` unchanged. Telemetry `sensor` message unchanged.

## 2. Database — new migration + `supabase/schema.sql`
```sql
alter table sitting_sessions
  add column if not exists posture_state text,          -- 'relaxing' | 'attentive' | null
  add column if not exists posture_changed_at timestamptz,
  add column if not exists relax_seconds bigint not null default 0,
  add column if not exists attentive_seconds bigint not null default 0;
```
New file `supabase/migrations/20261002000000_posture_tracking.sql` + same columns in `schema.sql`. **You run this in the Supabase SQL editor before deploying the backend.**

## 3. Shared types — `backend/src/types/sitting.ts` + `frontend/src/types/sitting.ts` (kept in mirror)
- `PostureState = 'relaxing' | 'attentive'`; `SittingStatus = 'RELAXING' | 'ATTENTIVE' | 'AWAY'` (ATTENTIVE replaces SITTING).
- `SittingSession` += `posture_state`, `posture_changed_at`, `relax_seconds`, `attentive_seconds`.
- `DayStats` += `relaxSeconds`, `attentiveSeconds`, `unclassifiedSeconds`.
- `DashboardStatsResponse` += `todayRelaxSeconds`, `todayAttentiveSeconds`, `activeRelaxSeconds`, `activeAttentiveSeconds`.

## 4. Backend — `sessionService.ts`
- `openSession(posture: PostureState = 'attentive')`: inserts posture fields (`posture_changed_at = started_at`, counters 0).
- New `setPosture(posture)`: no active session → open with that posture; same posture → no-op; otherwise **flush** elapsed (`now − (posture_changed_at ?? started_at)`) into the matching column, update `posture_state` + `posture_changed_at`, and broadcast SSE event `POSTURE_CHANGE` `{ sessionId, state, relaxSeconds, attentiveSeconds, postureChangedAt }`.
- `closeActiveSession()`: flush the current stretch before computing `ended_at`/`duration_seconds` so no posture time is lost.
- Legacy rows (null posture columns) handled via `?? started_at` fallback and 0 defaults.

## 5. Backend — `deviceGateway.ts` `handleStateChange` (line ~341)
- Accept `'relaxing' | 'attentive' | 'vacant'` plus legacy `'sitting'` (→ setPosture('attentive')) and `'away'` (→ closeActiveSession) so old firmware keeps working during rollout. Acks updated accordingly.

## 6. Backend — `routes/sitting.ts`
- `GET /status`: `status = activeSession ? (posture_state === 'relaxing' ? 'RELAXING' : 'ATTENTIVE') : 'AWAY'`; `activeRelaxSeconds`/`activeAttentiveSeconds` = accumulated column + live stretch when posture matches; today's relax/attentive sums = Σ per-session counters shared proportionally into the session's overlap with today (so midnight-crossing stays consistent) **plus** the active session's live stretch; `weeklyStats` days get relax/attentive/unclassified shares the same proportional way (unclassified = overlap − relax − attentive).
- Stale-session auto-close branch: flush posture up to `last_heartbeat_at` before closing.
- `POST /simulate`: keep `'start' | 'stop'`, add `'relax'` and `'focus'` → `setPosture('relaxing'|'attentive')` (opens a session if none), powering the new UI testing buttons.

## 7. Frontend — `page.tsx`
- SSE handler: `POSTURE_CHANGE` → `fetchStatus(true)` (no chime; sessions keep their start/end sounds).
- Transition logic: occupied = `status !== 'AWAY'`; sit sound/notification on AWAY→occupied, stand-up on occupied→AWAY, wording mentions posture. Break reminder uses occupied.
- `handleSimulate` extended to `'start' | 'stop' | 'relax' | 'focus'`; pass new props to `StatusCard` and `MetricsGrid`.

## 8. Frontend — `StatusCard.tsx`
- Badge/colors per posture: RELAXING → sky/blue "Currently Relaxing", ATTENTIVE → emerald "Currently Attentive", AWAY → zinc "Currently Away"; heading "Desk is Occupied — Relaxing / — Attentive" / "Desk is Vacant". Ambient glow follows posture.
- Right panel: keep session stopwatch; add two live mini-counters under it — "Attentive" (emerald dot) and "Relax" (sky dot) — ticking client-side from `activeSession.relax_seconds`/`attentive_seconds` + `posture_changed_at`.
- Distance chip colored by band (<4.5 sky, ≤45 emerald, >45 zinc).
- Simulate controls: add a Relax/Attentive toggle button (active while sitting) alongside Sit Down / Stand Up.

## 9. Frontend — `MetricsGrid.tsx`
- Grid becomes `grid-cols-2 lg:grid-cols-3 xl:grid-cols-6` (6 cards).
- New card 5 "Relax Time" (sky, `Sofa` icon) and card 6 "Attentive Time" (emerald, `Focus` icon): today's totals including the live stretch, with "X% of sitting" as the sub-line.

## 10. Frontend — `SessionHistory.tsx`
- New "Posture Split" column: `R 1m 20s · A 7m 15s` (sky/emerald, mono); legacy sessions with 0/0 show "—"; active row includes the live current stretch.

## 11. Frontend — `WeeklyChart.tsx` (stacked, per your choice)
- Each bar splits into segments by share: attentive (emerald) + relaxing (sky) + unclassified (zinc-600/50). Tooltip lists all three; small legend added to the footer; today's bar keeps the pulse but uses segment colors. Past days render gray until posture data accumulates (expected).

## 12. Simulator — `backend/scripts/ws-device-simulator.mjs`
- `sensor` readings → `[3.2, 20.0, 4.7, 60.0, -1.0]` (relax / attentive / deadband / vacant / invalid).
- New commands `relax`, `attentive`, `vacant` (alias of `away`); `sit`/`away` kept for compat.

## 13. Verification & rollout (order matters)
1. `tsc` build backend, `next build` frontend locally; run simulator: relax → attentive → vacant flow, check `/status` fields and Supabase rows (desk must be vacant — the real device writes to prod Supabase and same-deviceId connections supersede it).
2. You run the SQL migration in Supabase.
3. Commit **everything** and deploy backend to Cloud Run (`--timeout 3600 --no-cpu-throttling`) — the currently deployed build is missing the WS gateway, so this deploy must include it; backend is backward-compatible with the still-running old firmware meanwhile.
4. Flash the ESP8266 with the new firmware; frontend deploys via Vercel on push.
