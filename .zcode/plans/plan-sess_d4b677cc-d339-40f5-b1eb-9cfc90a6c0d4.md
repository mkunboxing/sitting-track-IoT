# Shorten disconnect grace window from ~90 s to ~30 s

## What changes

**1. Stale-check threshold — `backend/src/routes/sitting.ts`**
- The auto-close condition `timeSinceCheck > 90 * 1000` → `30 * 1000`.
- Result: if the device stays offline, its session is closed ~30 s after the last verified contact, with `ended_at` backdated to that last contact (unchanged semantics — no offline time counted as sitting).
- Dashboard shows "Away" within ~30–60 s of a real device death (30 s grace + up to 30 s poll interval).

**2. Heartbeat touch cadence — `backend/src/ws/deviceGateway.ts`**
- `PING_INTERVAL_MS` 30 000 → 10 000. Required for correctness: the touch must run well inside the 30 s threshold, or a connected device could be spuriously stale-closed in the gap between touches (worst-case staleness for a connected device becomes ≤10 s, comfortably under 30 s).
- Side effect: `last_heartbeat_at` DB touches increase to 6/min per connected device (was 2/min) — negligible load.
- Update the disconnect-handler comment (90s → 30s references).

**3. Docs — `README.md`**
- Update the grace-window mentions (~90 s → ~30 s) in the WebSocket section, the edge-case table row, the simulator `crash` note, and the Cloud Run section.

## What stays the same
- Reconnect-within-grace still continues the same session (ESP retries every 5 s, so Cloud Run forced drops remain harmless).
- `ended_at` backdating to last contact, SSE broadcast on stale close, 30 s dashboard polling — all unchanged.

## Verification
1. `tsc --noEmit` on backend.
2. E2E with the simulator: sit → hard-drop → confirm the session is still open right after the drop, then `/status` after ~40 s shows it auto-closed (AWAY).
3. Connected-device safety: keep a simulator connected across several touch cycles (>40 s) and confirm `/status` never spuriously closes it.
4. Note: backend must be redeployed to Cloud Run for this to take effect.