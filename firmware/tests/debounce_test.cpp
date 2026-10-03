/*
 * Host-side tests for the firmware's seating state machine (debounce.h).
 *
 * Compiles the SAME header the ESP8266 sketch includes — no Arduino headers
 * involved — so these assertions hold for the code that runs on the device.
 *
 * Build & run (repo root):
 *   c++ -std=c++17 -Wall -Wextra -I firmware/sitting_tracker \
 *       firmware/tests/debounce_test.cpp -o /tmp/debounce_test && /tmp/debounce_test
 *
 * Covered behavior:
 *   - distance thresholds unchanged (relaxing / deadband / attentive / vacant)
 *   - vacant → sitting needs SIT_START_CONFIRM (5 s) of continuous sitting
 *   - sitting → vacant needs SIT_END_CONFIRM (10 s) of continuous vacant
 *   - relaxing ↔ attentive keeps POSTURE_CONFIRM (2 s) and never passes
 *     through vacant (a posture switch can never open/close a session)
 *   - any fluctuation inside a confirmation window restarts it, so short
 *     sits/absences and alternating noise never confirm a transition
 *
 * Sampled scenarios drive DISTANCES through classifyDistance() at the real
 * 700 ms sensor cadence, mirroring the sketch's loop() exactly; the expected
 * confirmation ticks below are grid ticks (multiples of 700 ms).
 */

#include "debounce.h"

#include <vector>
#include <cstdio>

static int g_failures = 0;

static void check(const char* name, bool ok) {
    if (!ok) g_failures++;
    std::printf("%s %s\n", ok ? "PASS" : "FAIL", name);
}

// ── helpers ─────────────────────────────────────────────────────────────────

// Real cadence from the sketch
static const unsigned long SENSOR_INTERVAL = 700;

// Stand-in distances for each posture band (cm)
static const float D_RELAXING  = 5.0f;
static const float D_ATTENTIVE = 20.0f;
static const float D_DEADBAND  = 8.2f;
static const float D_VACANT    = 60.0f;

struct RunResult {
    std::vector<unsigned long> confirmTimes;
    std::vector<State> confirmedTo;
    bool currentEverVacant = false;
};

// Feed `durationMs` of measurements sampled every SENSOR_INTERVAL, with the
// raw distance for each sample taken from `timeline(simMs)` and classified
// against the machine's current state — the same two calls the sketch makes.
static RunResult run(DebounceState start, float (*timeline)(unsigned long), unsigned long durationMs) {
    RunResult r;
    DebounceState s = start;
    for (unsigned long t = 0; t < durationMs; t += SENSOR_INTERVAL) {
        State measured = classifyDistance(timeline(t), s.current);
        DebounceEvent e = updateDebounce(s, measured, t);
        if (e == DEBOUNCE_CONFIRMED) {
            r.confirmTimes.push_back(t);
            r.confirmedTo.push_back(s.current);
        }
        if (s.current == STATE_VACANT) r.currentEverVacant = true;
    }
    return r;
}

// ── distance thresholds (must remain unchanged) ─────────────────────────────

static void testClassification() {
    check("7.9 cm from vacant is relaxing", classifyDistance(7.9f, STATE_VACANT) == STATE_RELAXING);
    check("8.2 cm deadband from vacant reads attentive", classifyDistance(8.2f, STATE_VACANT) == STATE_ATTENTIVE);
    check("8.2 cm deadband holds relaxing when relaxing", classifyDistance(8.2f, STATE_RELAXING) == STATE_RELAXING);
    check("8.6 cm is attentive", classifyDistance(8.6f, STATE_VACANT) == STATE_ATTENTIVE);
    check("45.0 cm inclusive is occupied (attentive)", classifyDistance(45.0f, STATE_VACANT) == STATE_ATTENTIVE);
    check("45.1 cm is vacant", classifyDistance(45.1f, STATE_ATTENTIVE) == STATE_VACANT);
    check("invalid (-1) reading is vacant", classifyDistance(-1.0f, STATE_ATTENTIVE) == STATE_VACANT);
}

// ── confirmation windows ────────────────────────────────────────────────────

static void testWindowSelection() {
    check("occupied → vacant window is SIT_END_CONFIRM (10 s)",
          confirmationWindowMs(STATE_VACANT, STATE_ATTENTIVE) == 10000);
    check("vacant → occupied window is SIT_START_CONFIRM (5 s)",
          confirmationWindowMs(STATE_ATTENTIVE, STATE_VACANT) == 5000);
    check("relaxing ↔ attentive window is POSTURE_CONFIRM (2 s)",
          confirmationWindowMs(STATE_RELAXING, STATE_ATTENTIVE) == 2000);
}

// Exact boundary semantics of the debounce machine (no sampling grid)
static void testBoundaries() {
    DebounceState s = { STATE_VACANT, STATE_VACANT, 0, 0 };
    check("vacant→sitting: first sitting sample resets, not confirms",
          updateDebounce(s, STATE_ATTENTIVE, 0) == DEBOUNCE_RESET);
    check("vacant→sitting: quiet at 4999 ms", updateDebounce(s, STATE_ATTENTIVE, 4999) == DEBOUNCE_QUIET);
    check("vacant→sitting: confirmed exactly at 5000 ms",
          updateDebounce(s, STATE_ATTENTIVE, 5000) == DEBOUNCE_CONFIRMED && s.current == STATE_ATTENTIVE);

    DebounceState w = { STATE_ATTENTIVE, STATE_ATTENTIVE, 0, 0 };
    check("sitting→vacant: first vacant sample resets, not confirms",
          updateDebounce(w, STATE_VACANT, 0) == DEBOUNCE_RESET);
    check("sitting→vacant: quiet at 9999 ms", updateDebounce(w, STATE_VACANT, 9999) == DEBOUNCE_QUIET);
    check("sitting→vacant: confirmed exactly at 10000 ms",
          updateDebounce(w, STATE_VACANT, 10000) == DEBOUNCE_CONFIRMED && w.current == STATE_VACANT);

    DebounceState p = { STATE_ATTENTIVE, STATE_ATTENTIVE, 0, 0 };
    check("posture: first relaxing sample resets, not confirms",
          updateDebounce(p, STATE_RELAXING, 0) == DEBOUNCE_RESET);
    check("posture: quiet at 1999 ms", updateDebounce(p, STATE_RELAXING, 1999) == DEBOUNCE_QUIET);
    check("posture: confirmed exactly at 2000 ms",
          updateDebounce(p, STATE_RELAXING, 2000) == DEBOUNCE_CONFIRMED && p.current == STATE_RELAXING);
}

// ── realistic sampled timelines ─────────────────────────────────────────────

// Desk occupied from power-on (boot while sitting)
static float bootSitting(unsigned long) { return D_ATTENTIVE; }

static void testBootWhileSitting() {
    RunResult r = run({ STATE_VACANT, STATE_VACANT, 0, 0 }, bootSitting, 30000);
    check("boot while sitting: exactly one confirmation", r.confirmTimes.size() == 1);
    check("boot while sitting: confirmed after 5 s (grid tick 5600), not the old 2 s",
          r.confirmTimes.size() == 1 && r.confirmTimes[0] == 5600);
    check("boot while sitting: confirmed state is attentive",
          r.confirmedTo.size() == 1 && r.confirmedTo[0] == STATE_ATTENTIVE);
}

// Desk vacant until the 59500 grid tick, then continuously occupied
static float sitAt59500(unsigned long t) { return t < 59500 ? D_VACANT : D_ATTENTIVE; }

static void testVacantToSitting() {
    RunResult r = run({ STATE_VACANT, STATE_VACANT, 0, 0 }, sitAt59500, 120000);
    check("vacant→sitting: exactly one confirmation", r.confirmTimes.size() == 1);
    check("vacant→sitting: confirmed after 5 s of sitting (grid tick 65100)",
          r.confirmTimes.size() == 1 && r.confirmTimes[0] == 65100);
    check("vacant→sitting: confirmed state is attentive",
          r.confirmedTo.size() == 1 && r.confirmedTo[0] == STATE_ATTENTIVE);
}

// 4.2 s (sampled) noise burst of "sitting" while vacant, then vacant again
static float shortNoiseBurst(unsigned long t) {
    if (t < 30000) return D_VACANT;
    if (t < 34500) return D_ATTENTIVE;
    return D_VACANT;
}

static void testNoiseBurstBelowOpenWindow() {
    RunResult r = run({ STATE_VACANT, STATE_VACANT, 0, 0 }, shortNoiseBurst, 120000);
    check("sitting noise burst below 5 s: never confirms, no phantom session",
          r.confirmTimes.empty());
}

// Genuine but brief 2.1 s (sampled) sit-down after a long vacant stretch
static float threeSecondSit(unsigned long t) {
    if (t < 10000) return D_VACANT;
    if (t < 13000) return D_ATTENTIVE;
    return D_VACANT;
}

static void testShortGenuineSit() {
    RunResult r = run({ STATE_VACANT, STATE_VACANT, 0, 0 }, threeSecondSit, 60000);
    check("short sit-down below 5 s: never confirms vacant→sitting",
          r.confirmTimes.empty());
}

// Fluctuation (single vacant sample) inside the open window restarts it:
// sitting [60000, 63000), one vacant sample at 63000, sitting from 63700 on.
static float fluctuationInsideOpenWindow(unsigned long t) {
    if (t < 60000) return D_VACANT;
    if (t < 63000) return D_ATTENTIVE;
    if (t < 63700) return D_VACANT;
    return D_ATTENTIVE;
}

static void testFluctuationRestartsOpenWindow() {
    RunResult r = run({ STATE_VACANT, STATE_VACANT, 0, 0 }, fluctuationInsideOpenWindow, 150000);
    // The first stretch (2.1 s sampled) cannot confirm; the stray sample
    // restarts the window, so the confirm lands 5 s after the resume (69300).
    check("fluctuation inside open window: exactly one confirmation",
          r.confirmTimes.size() == 1);
    check("fluctuation inside open window: confirm lands 5 s after the restart (69300)",
          r.confirmTimes.size() == 1 && r.confirmTimes[0] == 69300);
}

// Occupied until the 60200 grid tick, then continuously vacant
static float leaveAt60200(unsigned long t) { return t < 60200 ? D_ATTENTIVE : D_VACANT; }

static void testSittingToVacant() {
    RunResult r = run({ STATE_ATTENTIVE, STATE_ATTENTIVE, 0, 0 }, leaveAt60200, 120000);
    check("sitting→vacant: exactly one confirmation", r.confirmTimes.size() == 1);
    check("sitting→vacant: confirmed after 10 s of vacant (grid tick 70700)",
          r.confirmTimes.size() == 1 && r.confirmTimes[0] == 70700);
    check("sitting→vacant: confirmed state is vacant",
          r.confirmedTo.size() == 1 && r.confirmedTo[0] == STATE_VACANT);
}

// 8.4 s (sampled) absence (< 10 s window) then sitting again
static float briefAbsence(unsigned long t) {
    if (t < 20000) return D_ATTENTIVE;
    if (t < 29100) return D_VACANT;
    return D_ATTENTIVE;
}

static void testBriefAbsenceNeverCloses() {
    RunResult r = run({ STATE_ATTENTIVE, STATE_ATTENTIVE, 0, 0 }, briefAbsence, 90000);
    check("brief absence below 10 s: never confirms sitting→vacant",
          r.confirmTimes.empty());
    check("brief absence below 10 s: device keeps reporting sitting the whole time",
          !r.currentEverVacant);
}

// 8–8.5 cm deadband blip inside the close window restarts it (no false close):
// vacant from 10500 tick, one deadband sample at 16800, vacant again from 17500.
static float deadbandBlipInsideCloseWindow(unsigned long t) {
    if (t < 10000) return D_ATTENTIVE;
    if (t < 16300) return D_VACANT;
    if (t < 17000) return D_DEADBAND;
    return D_VACANT;
}

static void testDeadbandBlipRestartsCloseWindow() {
    RunResult r = run({ STATE_ATTENTIVE, STATE_ATTENTIVE, 0, 0 }, deadbandBlipInsideCloseWindow, 60000);
    // Close only 10 s after the blip ends (restart at 17500 → tick 28000)
    check("deadband blip inside close window: one confirmation, 10 s after the blip",
          r.confirmTimes.size() == 1 && r.confirmTimes[0] == 28000);
}

// Relaxing ↔ attentive churn on an occupied desk — posture only, never vacant
static float postureChurn(unsigned long t) {
    if (t < 10000) return D_ATTENTIVE;
    if (t < 15000) return D_RELAXING;
    if (t < 20000) return D_ATTENTIVE;
    if (t < 25000) return D_RELAXING;
    return D_ATTENTIVE;
}

static void testPostureSwitchesNeverReportVacant() {
    RunResult r = run({ STATE_ATTENTIVE, STATE_ATTENTIVE, 0, 0 }, postureChurn, 40000);
    check("posture churn: one 2 s confirmation per stable switch (4 total)",
          r.confirmTimes.size() == 4);
    check("posture churn: current never becomes vacant (session untouched)",
          !r.currentEverVacant);
    check("posture churn: every confirmed state is occupied",
          [&]() {
              for (State s : r.confirmedTo) if (s == STATE_VACANT) return false;
              return true;
          }());
}

// Alternating sitting/vacant noise while vacant must never accumulate a window
static float alternatingNoise(unsigned long t) {
    return (t / SENSOR_INTERVAL) % 2 == 0 ? D_ATTENTIVE : D_VACANT;
}

static void testAlternatingNoiseNeverConfirms() {
    RunResult r = run({ STATE_VACANT, STATE_VACANT, 0, 0 }, alternatingNoise, 60000);
    check("alternating attentive/vacant noise: never confirms", r.confirmTimes.empty());
}

// currentSince must record when the confirmed state was FIRST continuously
// measured — the telemetry `stateForMs` the backend anchors session timing to
static void testCurrentSinceTracksFirstDetection() {
    // Boot while sitting: confirm at tick 5600, but the sitting stretch was
    // first measured at t=0 → currentSince == 0
    DebounceState s = { STATE_VACANT, STATE_VACANT, 0, 0 };
    for (unsigned long t = 0; t <= 5600; t += SENSOR_INTERVAL) {
        updateDebounce(s, classifyDistance(D_ATTENTIVE, s.current), t);
    }
    check("boot sitting: confirmed at 5600", s.current == STATE_ATTENTIVE);
    check("boot sitting: currentSince == first detection (t=0, not confirm time)",
          s.currentSince == 0);

    // Leave at tick 60200 → vacant confirms at 70700 → currentSince == 60200
    for (unsigned long t = 6300; t <= 70000; t += SENSOR_INTERVAL) {
        updateDebounce(s, classifyDistance(t < 60200 ? D_ATTENTIVE : D_VACANT, s.current), t);
    }
    updateDebounce(s, classifyDistance(D_VACANT, s.current), 70700);
    check("leave: vacant confirmed at 70700", s.current == STATE_VACANT);
    check("leave: currentSince == first vacant detection (60200, not confirm time)",
          s.currentSince == 60200);

    // Fluctuation inside the open window: the confirmed stretch begins at the
    // post-fluctuation resume, which is the honest first detection
    DebounceState f = { STATE_VACANT, STATE_VACANT, 0, 0 };
    for (unsigned long t = 0; t <= 69300; t += SENSOR_INTERVAL) {
        float d = (t < 60000) ? D_VACANT
                : (t < 63000) ? D_ATTENTIVE
                : (t < 63700) ? D_VACANT
                : D_ATTENTIVE;
        updateDebounce(f, classifyDistance(d, f.current), t);
    }
    check("fluctuation case: confirmed at 69300", f.current == STATE_ATTENTIVE);
    check("fluctuation case: currentSince == post-fluctuation resume (63700)",
          f.currentSince == 63700);
}

int main() {
    testClassification();
    testWindowSelection();
    testBoundaries();
    testBootWhileSitting();
    testVacantToSitting();
    testNoiseBurstBelowOpenWindow();
    testShortGenuineSit();
    testFluctuationRestartsOpenWindow();
    testSittingToVacant();
    testBriefAbsenceNeverCloses();
    testDeadbandBlipRestartsCloseWindow();
    testPostureSwitchesNeverReportVacant();
    testAlternatingNoiseNeverConfirms();
    testCurrentSinceTracksFirstDetection();

    std::printf(g_failures == 0 ? "\nALL PASS\n" : "\n%d FAILURES\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
