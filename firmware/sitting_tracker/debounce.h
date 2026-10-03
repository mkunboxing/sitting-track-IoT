#ifndef SITTING_DEBOUNCE_H
#define SITTING_DEBOUNCE_H

/*
 * Pure seating-state machine for the sitting tracker firmware.
 *
 * Split out of sitting_tracker.ino verbatim (same thresholds, same debounce
 * behavior) so the exact logic that decides sitting/vacant can be compiled
 * and tested on a development machine without any Arduino/ESP8266 headers —
 * see firmware/tests/debounce_test.cpp. The sketch includes this header and
 * the test suite includes the same file, so the tests always exercise the
 * code that actually runs on the device.
 *
 * Confirmation model — the required window depends on the TRANSITION being
 * confirmed, not just the target state:
 *
 *   vacant → relaxing/attentive : SIT_START_CONFIRM of continuous sitting
 *                                 before the device reports sitting; the
 *                                 backend opens the session on that snapshot.
 *   relaxing/attentive → vacant : SIT_END_CONFIRM of continuous vacant before
 *                                 the device reports vacant; the backend
 *                                 closes the session on that snapshot.
 *   relaxing ↔ attentive        : POSTURE_CONFIRM — posture switch only; the
 *                                 running session is never opened or closed
 *                                 by a posture change.
 *
 * A measured state different from the pending one restarts the pending
 * window, so momentary sensor fluctuations never accumulate into a
 * transition and cannot produce short phantom sessions.
 */

// ── Seating states (wire names in the .ino's stateName()) ─────────────────
enum State {
  STATE_VACANT,
  STATE_RELAXING,
  STATE_ATTENTIVE
};

// Distance thresholds (cm) — unchanged
const float RELAX_ENTER_CM     = 8.0;   // distance < 8 cm is relaxing
const float ATTENTIVE_ENTER_CM = 8.5;   // 8–8.5 cm is a deadband: hold previous
const float OCCUPANCY_LIMIT_CM = 45.0;  // distance > 45 cm is vacant

// Confirmation windows (ms), per transition — see the model comment above
const unsigned long SIT_START_CONFIRM = 5000;   // 5 s of sitting to open a session
const unsigned long SIT_END_CONFIRM   = 10000;  // 10 s of vacant to close a session
const unsigned long POSTURE_CONFIRM   = 2000;   // 2 s to switch relaxing ↔ attentive

/**
 * Instantaneous posture classification (no debouncing):
 *   valid distance < 8 cm              → relaxing
 *   distance in the 8–8.5 cm deadband  → hold `current` (a vacant device
 *                                        reads the deadband as attentive)
 *   8.5 cm < distance <= 45 cm         → attentive
 *   distance > 45 cm or <= 0 (no echo / out of range) → vacant
 */
inline State classifyDistance(float distanceCm, State current) {
  if (distanceCm <= 0 || distanceCm > OCCUPANCY_LIMIT_CM) return STATE_VACANT;
  if (distanceCm < RELAX_ENTER_CM) return STATE_RELAXING;
  if (distanceCm > ATTENTIVE_ENTER_CM) return STATE_ATTENTIVE;
  return (current == STATE_VACANT) ? STATE_ATTENTIVE : current;
}

/**
 * Confirmation window required to move from `current` to `potential`.
 * (vacant → vacant and occupied → occupied never reach here in a way that
 * matters: the debounce only acts when potential != current.)
 */
inline unsigned long confirmationWindowMs(State potential, State current) {
  if (potential == STATE_VACANT) return SIT_END_CONFIRM;    // occupied → vacant: closes a session
  if (current == STATE_VACANT)   return SIT_START_CONFIRM;  // vacant → occupied: opens a session
  return POSTURE_CONFIRM;                                   // relaxing ↔ attentive: posture only
}

struct DebounceState {
  State current;
  State potential;
  unsigned long potentialSince;
  // millis() timestamp of when the CURRENT state was first continuously
  // measured (== potentialSince captured at the moment of confirmation, or
  // boot time for the initial state). millis() - currentSince is how long
  // the reported state has actually been held — the device sends this as
  // telemetry `stateForMs` so the backend can anchor session start/end to
  // first DETECTION instead of confirmation, keeping confirmation windows
  // out of the recorded sitting duration.
  unsigned long currentSince;
};

enum DebounceEvent {
  DEBOUNCE_QUIET,      // nothing to report this tick
  DEBOUNCE_RESET,      // measurement shifted — pending window restarted
  DEBOUNCE_CONFIRMED   // transition confirmed — state.current changed
};

/**
 * Feed one instantaneous measurement into the debounce machine. `now` is the
 * caller's millisecond clock, so nothing here blocks sensing or telemetry:
 * the sketch keeps sampling every SENSOR_INTERVAL and POSTing every
 * TELEMETRY_INTERVAL_MS regardless of any pending confirmation window.
 */
inline DebounceEvent updateDebounce(DebounceState& s, State measured, unsigned long now) {
  if (measured != s.potential) {
    // Physical measurement shifted; restart the confirmation timer
    s.potential = measured;
    s.potentialSince = now;
    return DEBOUNCE_RESET;
  }
  if (s.potential == s.current) return DEBOUNCE_QUIET;
  if (now - s.potentialSince < confirmationWindowMs(s.potential, s.current)) {
    return DEBOUNCE_QUIET;
  }
  s.current = s.potential;
  s.currentSince = s.potentialSince; // the confirmed stretch began at first detection
  return DEBOUNCE_CONFIRMED;
}

#endif // SITTING_DEBOUNCE_H
