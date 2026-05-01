'use strict';

// ── cronHeartbeat — catch-up safety net for node-cron silent-drop ───────────
//
// Background:
//   node-cron has shown silent-tick-drop behavior under event-loop load on
//   Railway across multiple crons (FXSSI 2026-04-22 + 2026-04-28, stocks
//   16:00 cron 2026-04-22, COT Friday cron 2026-04-25 missed). Existing
//   watchdogs (stocks read-time, FXSSI 15-min staleness) catch SOME of these
//   but with delay or with thresholds that miss edge cases.
//
// Design:
//   - Register tasks with { cadenceMs, run, skipIf }.
//   - A 30s setInterval ticker checks each registered task: if (now -
//     lastRunAt > cadenceMs) AND skipIf() returns false AND task isn't
//     already inFlight, run it. Update lastRunAt.
//   - The existing cron.schedule callbacks call markRan(name) on successful
//     completion. That keeps the heartbeat in sync — it will only catch up
//     when cron actually missed a tick.
//   - Run failures are logged. lastSuccessAt is tracked separately from
//     lastRunAt so /api/heartbeat-status can show "ran but failed" cases.
//   - Single-fire guard via inFlight flag — concurrent ticks can't double-run.
//
// Why setInterval is reliable here when node-cron isn't:
//   setInterval doesn't try to align to wall-clock minute boundaries, so it
//   doesn't suffer the "missed minute boundary" silent-drop pattern. Even if
//   the event loop blocks for 60s, the next interval tick still runs — it
//   just runs late. Late-but-fired beats never-fired.
//
// What this is NOT:
//   - Not a replacement for node-cron. The cron schedules still fire and
//     are the primary trigger. Heartbeat is the fallback.
//   - Not for crons that depend on wall-clock alignment (e.g. "fire exactly
//     at 16:00 Dubai for the daily stocks scan"). Those still need cron;
//     heartbeat catches drops with a minimum-cadence guarantee.
//
// API:
//   register(name, { cadenceMs, run, skipIf })
//   markRan(name, ts?)              // call from your cron callback on success
//   start(intervalMs = 30000)       // begins the ticker (call once at boot)
//   getStatus()                     // for /api/heartbeat-status

const tasks = new Map();
let _intervalHandle = null;

function register(name, opts) {
  if (!opts || typeof opts.run !== 'function') {
    throw new Error(`heartbeat.register(${name}): run() function required`);
  }
  if (typeof opts.cadenceMs !== 'number' || opts.cadenceMs <= 0) {
    throw new Error(`heartbeat.register(${name}): cadenceMs must be positive number`);
  }
  if (tasks.has(name)) {
    throw new Error(`heartbeat.register(${name}): task already registered`);
  }
  tasks.set(name, {
    cadenceMs:     opts.cadenceMs,
    run:           opts.run,
    skipIf:        opts.skipIf || (() => false),
    lastRunAt:     0,        // ms wall-clock — last time we attempted to run (success or failure)
    lastSuccessAt: 0,        // ms wall-clock — last time run() resolved without throw
    lastError:     null,
    inFlight:      false,
    runCount:      0,
    catchUpCount:  0,        // how many times this task fired via heartbeat (vs cron.markRan)
  });
}

function markRan(name, ts = Date.now()) {
  const t = tasks.get(name);
  if (!t) return;
  t.lastRunAt = ts;
  t.lastSuccessAt = ts;
  t.lastError = null;
  t.runCount++;
}

async function tickOnce(now = Date.now()) {
  for (const [name, t] of tasks.entries()) {
    if (t.inFlight) continue;
    try { if (t.skipIf()) continue; } catch(e) { continue; }

    const nextRunAt = t.lastRunAt + t.cadenceMs;
    if (now < nextRunAt) continue;

    // Overdue — fire catch-up
    t.inFlight = true;
    t.lastRunAt = now;        // claim the slot synchronously to prevent races
    t.catchUpCount++;
    const overdueMin = t.lastSuccessAt
      ? Math.round((now - t.lastSuccessAt) / 60000)
      : null;
    console.log(`[Heartbeat] ${name} catch-up firing (overdue ${overdueMin == null ? 'first run' : overdueMin + 'm since success'})`);

    Promise.resolve()
      .then(() => t.run())
      .then(() => {
        t.lastSuccessAt = Date.now();
        t.lastError = null;
        t.runCount++;
      })
      .catch((err) => {
        t.lastError = err && err.message ? err.message : String(err);
        console.error(`[Heartbeat] ${name} error:`, t.lastError);
      })
      .finally(() => { t.inFlight = false; });
  }
}

function start(intervalMs = 30 * 1000) {
  if (_intervalHandle) return;
  _intervalHandle = setInterval(() => {
    tickOnce().catch(e => console.error('[Heartbeat] tick error:', e?.message));
  }, intervalMs);
  // Don't keep process alive on its own
  if (typeof _intervalHandle.unref === 'function') _intervalHandle.unref();
}

function stop() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

function getStatus() {
  const now = Date.now();
  const out = {};
  for (const [name, t] of tasks.entries()) {
    out[name] = {
      cadenceMs:        t.cadenceMs,
      cadenceMin:       Math.round(t.cadenceMs / 60000),
      lastRunAt:        t.lastRunAt || null,
      lastRunAgoMin:    t.lastRunAt ? Math.round((now - t.lastRunAt) / 60000) : null,
      lastSuccessAt:    t.lastSuccessAt || null,
      lastSuccessAgoMin: t.lastSuccessAt ? Math.round((now - t.lastSuccessAt) / 60000) : null,
      lastError:        t.lastError,
      inFlight:         t.inFlight,
      runCount:         t.runCount,
      catchUpCount:     t.catchUpCount,
      overdueMs:        Math.max(0, now - (t.lastRunAt + t.cadenceMs)),
      overdueMin:       Math.max(0, Math.round((now - (t.lastRunAt + t.cadenceMs)) / 60000)),
    };
  }
  return out;
}

module.exports = { register, markRan, tickOnce, start, stop, getStatus };
