/**
 * Quick sanity test for the pure posture-math helpers in sessionService.ts
 * and routes/sitting.ts (no DB access). Run from backend/:
 *   npx tsx --env-file=.env scripts/posture-math-test.ts
 */
import { accumulatePosture, currentPostureStretchSeconds } from '../src/lib/sessionService.js';
import type { SittingSession } from '../src/types/sitting.js';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

const T0 = new Date('2026-10-02T10:00:00Z');

// ── accumulatePosture ─────────────────────────────────────────────
// Legacy row (no posture data): contributes nothing
check(
  'legacy row accumulates nothing',
  accumulatePosture({ started_at: T0.toISOString(), posture_state: null, posture_changed_at: null, relax_seconds: null, attentive_seconds: null }, new Date(T0.getTime() + 60_000)),
  { relaxSeconds: 0, attentiveSeconds: 0 }
);

// 90s relaxing stretch on top of 30s already stored
check(
  'relaxing stretch flushes into relax_seconds',
  accumulatePosture({ started_at: T0.toISOString(), posture_state: 'relaxing', posture_changed_at: new Date(T0.getTime() + 30_000).toISOString(), relax_seconds: 30, attentive_seconds: 120 }, new Date(T0.getTime() + 120_000)),
  { relaxSeconds: 120, attentiveSeconds: 120 }
);

// 45s attentive stretch, nothing stored yet
check(
  'attentive stretch flushes into attentive_seconds',
  accumulatePosture({ started_at: T0.toISOString(), posture_state: 'attentive', posture_changed_at: T0.toISOString(), relax_seconds: 0, attentive_seconds: 0 }, new Date(T0.getTime() + 45_000)),
  { relaxSeconds: 0, attentiveSeconds: 45 }
);

// posture_changed_at missing (older row pre-migration start): falls back to started_at
check(
  'missing posture_changed_at falls back to started_at',
  accumulatePosture({ started_at: T0.toISOString(), posture_state: 'attentive', posture_changed_at: null, relax_seconds: 0, attentive_seconds: 10 }, new Date(T0.getTime() + 30_000)),
  { relaxSeconds: 0, attentiveSeconds: 40 }
);

// ── currentPostureStretchSeconds ──────────────────────────────────
check(
  'stretch seconds for null posture is 0',
  currentPostureStretchSeconds({ started_at: T0.toISOString(), posture_state: null, posture_changed_at: null, relax_seconds: 0, attentive_seconds: 0 }, new Date(T0.getTime() + 100_000)),
  0
);
check(
  'stretch seconds since posture_changed_at',
  currentPostureStretchSeconds({ started_at: T0.toISOString(), posture_state: 'relaxing', posture_changed_at: new Date(T0.getTime() + 40_000).toISOString(), relax_seconds: 0, attentive_seconds: 0 }, new Date(T0.getTime() + 100_000)),
  60
);

// ── postureShareSeconds (routes helper, re-implemented check) ─────
// Mirror of the route helper: proportional share + clamping
function postureShareSeconds(session: SittingSession, overlapSeconds: number, now: Date): { relax: number; attentive: number } {
  if (overlapSeconds <= 0) return { relax: 0, attentive: 0 };
  let relax: number, attentive: number, totalDuration: number;
  if (session.ended_at === null) {
    const stretch = currentPostureStretchSeconds(session, now);
    relax = (session.relax_seconds ?? 0) + (session.posture_state === 'relaxing' ? stretch : 0);
    attentive = (session.attentive_seconds ?? 0) + (session.posture_state === 'attentive' ? stretch : 0);
    totalDuration = Math.max(1, Math.floor((now.getTime() - new Date(session.started_at).getTime()) / 1000));
  } else {
    relax = session.relax_seconds ?? 0;
    attentive = session.attentive_seconds ?? 0;
    totalDuration = session.duration_seconds ?? overlapSeconds;
  }
  if (totalDuration <= 0) return { relax: 0, attentive: 0 };
  const share = Math.min(1, overlapSeconds / totalDuration);
  relax = Math.min(overlapSeconds, Math.round(relax * share));
  attentive = Math.min(overlapSeconds - relax, Math.round(attentive * share));
  return { relax, attentive };
}

// Active session 10 min old: 2 min stored relax (flushed), 3 min attentive flushed,
// currently relaxing for the last 5 min → totals: relax 7m, attentive 3m. Full overlap → exact.
const activeNow = new Date(T0.getTime() + 600_000);
const activeSession = {
  id: 'x', started_at: T0.toISOString(), ended_at: null, duration_seconds: null,
  posture_state: 'relaxing' as const,
  posture_changed_at: new Date(T0.getTime() + 300_000).toISOString(),
  relax_seconds: 120, attentive_seconds: 180, created_at: T0.toISOString(),
};
check(
  'active session full overlap returns exact split',
  postureShareSeconds(activeSession, 600, activeNow),
  { relax: 420, attentive: 180 }
);

// Same session crossing midnight: only 120s of it falls in "today" → 1/5 share
check(
  'active session partial overlap shares proportionally',
  postureShareSeconds(activeSession, 120, activeNow),
  { relax: 84, attentive: 36 }
);

// Closed legacy session: 0/0 columns → unclassified carries everything
const legacySession: SittingSession = {
  id: 'y', started_at: T0.toISOString(), ended_at: new Date(T0.getTime() + 300_000).toISOString(),
  duration_seconds: 300, posture_state: null, posture_changed_at: null,
  relax_seconds: 0, attentive_seconds: 0, created_at: T0.toISOString(),
};
check(
  'legacy closed session contributes 0/0',
  postureShareSeconds(legacySession, 300, activeNow),
  { relax: 0, attentive: 0 }
);

// Closed tracked session: 300s total, 100 relax / 200 attentive, overlap 150 (midnight) → half
const trackedSession: SittingSession = {
  id: 'z', started_at: T0.toISOString(), ended_at: new Date(T0.getTime() + 300_000).toISOString(),
  duration_seconds: 300, posture_state: null, posture_changed_at: null,
  relax_seconds: 100, attentive_seconds: 200, created_at: T0.toISOString(),
};
check(
  'closed tracked session shares proportionally',
  postureShareSeconds(trackedSession, 150, activeNow),
  { relax: 50, attentive: 100 }
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
