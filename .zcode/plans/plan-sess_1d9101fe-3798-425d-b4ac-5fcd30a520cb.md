# Retune posture thresholds: relaxing < 8.0 cm, attentive 8.5–45 cm

New bands (deadband/hysteresis logic unchanged): **< 8.0 → relaxing** · **8.0–8.5 → hold previous state** (vacant reads it as attentive) · **8.5–45 → attentive** · **> 45 / invalid → vacant**. The 45 cm vacant boundary stays as-is.

Code references the thresholds through named constants, so this is constants + comments + one UI color band + simulator test values:

1. **Firmware** `firmware/sitting_tracker/sitting_tracker.ino` (re-reading each hunk before editing):
   - `RELAX_ENTER_CM` 4.5 → **8.0**, `ATTENTIVE_ENTER_CM` 5.0 → **8.5** (lines ~155–156) — the loop/boot classifiers use the constants, so no logic edits
   - Update the three comment blocks that spell out the bands (header doc ~22–23, threshold block ~150–153, boot comment ~277, loop comment ~327–329)
2. **Frontend** `StatusCard.tsx` (~line 94): distance chip color band `distanceCm < 4.5` → `< 8.0` (sky = relaxing)
3. **Simulator** `backend/scripts/ws-device-simulator.mjs`: test readings `[3.2, 20.0, 4.7, 60.0, -1.0]` → `[5.0, 20.0, 8.2, 60.0, -1.0]` so each band (relax / attentive / deadband / vacant / invalid) is still covered, + comment
4. **Migration comment** `supabase/migrations/20261002000000_posture_tracking.sql`: comment-only band description update (SQL untouched — safe whether or not you already ran it)
5. **Memory**: update the recorded band values

Then verify: `tsc --noEmit` backend, `next build` frontend, re-run `posture-math-test.ts` (threshold-agnostic, should stay green).

Rollout: same pipeline as before — if yesterday's posture work isn't deployed/flashed yet, this rides along in the same commit; if it is, this needs a backend redeploy + ESP reflash (frontend via Vercel on push).