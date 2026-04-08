'use strict';

// ── ABC Gate Engine ───────────────────────────────────────────────────────────
// Applies server-side filters to Pine ABC signals.
// Pine has already done structural classification (A/B/C).
// This layer adds: macro blocks, FXSSI gates, RR sanity, cooldown, verdict mapping.

const { isBankHoliday } = require('./marketHours');
const { isPreEventRisk, isPostEventSuppressed } = require('./forexCalendar');

// ── Verdict mapping by class × FXSSI ─────────────────────────────────────────
// Class A: structurally strongest — FXSSI pass=PROCEED, fail=WATCH
// Class B: needs FXSSI — FXSSI pass=PROCEED, fail=SKIP
// Class C: weakest — FXSSI pass=WATCH, fail=SKIP
function mapVerdict(pineClass, fxssiPassed, fxssiNoData) {
  if (fxssiPassed) {
    if (pineClass === 'A') return 'PROCEED';
    if (pineClass === 'B') return 'PROCEED';
    if (pineClass === 'C') return 'WATCH';
  } else if (fxssiNoData) {
    if (pineClass === 'A') return 'WATCH';
    if (pineClass === 'B') return 'WATCH';
    if (pineClass === 'C') return 'SKIP';
  } else {
    if (pineClass === 'A') return 'WATCH';
    if (pineClass === 'B') return 'SKIP';
    if (pineClass === 'C') return 'SKIP';
  }
  return 'SKIP';
}

// ── FXSSI gate — same logic as scorer ────────────────────────────────────────
// Returns { passed: bool, reason: string }
function checkFxssi(symbol, fxssiData) {
  if (!fxssiData || fxssiData.fxssi_trapped == null) {
    return { passed: false, noData: true, reason: 'No FXSSI data for symbol' };
  }
  const direction = fxssiData._direction;
  const trapped   = fxssiData.fxssi_trapped;
  const trappedAligned = (direction === 'LONG'  && trapped === 'SHORT') ||
                         (direction === 'SHORT' && trapped === 'LONG');
  if (!trappedAligned) {
    return { passed: false, noData: false, reason: `Trapped not aligned (trapped=${trapped}, dir=${direction})` };
  }
  return { passed: true, noData: false, reason: `Trapped ${trapped} aligned with ${direction}` };
}

// ── Gravity proximity gate ────────────────────────────────────────────────────
// If TP is blocked by a gravity cluster, skip the trade
function checkGravity(direction, tp, fxssiData) {
  if (!fxssiData || !tp) return { passed: true, reason: 'No gravity data' };

  const gravity = fxssiData.gravity_price || fxssiData.fxssi_gravity;
  if (!gravity) return { passed: true, reason: 'No gravity level' };

  const entry = fxssiData._entry;
  if (!entry) return { passed: true, reason: 'No entry for gravity check' };

  const tpDist     = Math.abs(tp - entry);
  const gravDist   = Math.abs(gravity - entry);
  const gravInPath = direction === 'LONG'
    ? gravity > entry && gravity < tp
    : gravity < entry && gravity > tp;

  // Block if gravity is within 70% of the path to TP
  if (gravInPath && gravDist < tpDist * 0.70) {
    return { passed: false, reason: `Gravity at ${gravity} blocks TP path` };
  }

  return { passed: true, reason: 'Gravity clear of TP path' };
}

// ── Intel key levels context (reasoning annotation only, no block) ────────────
function getIntelContext(symbol, entry, tp, atr, db) {
  try {
    const intel = db.getLatestIntel ? db.getLatestIntel(symbol) : null;
    if (!intel || !intel.levels) return '';

    const levels = JSON.parse(intel.levels || '[]');
    const notes  = [];

    for (const lvl of levels) {
      const price = lvl.price || lvl.level;
      if (!price) continue;
      const distFromEntry = Math.abs(price - entry);
      const distFromTp    = Math.abs(price - tp);

      if (distFromEntry < (atr || 0) * 0.3) {
        notes.push(`✓ Key level ${price} near entry`);
      } else if (distFromTp < (atr || 0) * 0.3) {
        notes.push(`✓ Key level ${price} near TP`);
      } else {
        // Check if level is in the path between entry and TP
        const inPath = entry < tp
          ? (price > entry && price < tp)
          : (price < entry && price > tp);
        if (inPath) notes.push(`⚠ Key level ${price} in path to TP`);
      }
    }

    return notes.join(' · ');
  } catch(e) {
    return '';
  }
}

// ── Main gate runner ──────────────────────────────────────────────────────────
// Returns { verdict, blocked, reason, intelContext }
function runAbcGates(symbol, payload, fxssiData, db) {
  const { pineClass, direction, entry, sl, tp } = payload;

  // 1. Bank holiday
  if (isBankHoliday(symbol)) {
    return { verdict: 'SKIP', blocked: true, reason: 'Bank holiday' };
  }

  // 2. Pre-event suppression (<30min to high-impact event)
  if (isPreEventRisk && isPreEventRisk(symbol)) {
    return { verdict: 'SKIP', blocked: true, reason: 'Pre-event suppression' };
  }

  // 3. Post-event volatility window (<5min after event)
  if (isPostEventSuppressed && isPostEventSuppressed(symbol)) {
    return { verdict: 'SKIP', blocked: true, reason: 'Post-event volatility block' };
  }

  // 4. RR sanity check
  if (!entry || !sl || !tp) {
    return { verdict: 'SKIP', blocked: true, reason: 'Missing entry/sl/tp from Pine' };
  }
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp   - entry);
  const rr     = slDist > 0 ? Math.round((tpDist / slDist) * 10) / 10 : 0;
  if (rr < 1.5) {
    return { verdict: 'SKIP', blocked: true, reason: `RR ${rr} below 1.5` };
  }

  // 5. Inject direction into fxssiData for gate checks
  if (fxssiData) fxssiData._direction = direction;
  if (fxssiData) fxssiData._entry     = entry;

  // 6. FXSSI trapped gate
  const fxssiCheck = checkFxssi(symbol, fxssiData);

  // 7. Gravity proximity gate
  const gravityCheck = checkGravity(direction, tp, fxssiData);
  if (!gravityCheck.passed) {
    return { verdict: 'SKIP', blocked: true, reason: gravityCheck.reason };
  }

  // 8. Class × FXSSI verdict mapping
  const verdict = mapVerdict(pineClass, fxssiCheck.passed, fxssiCheck.noData);
  if (verdict === 'SKIP') {
    return { verdict: 'SKIP', blocked: true, reason: `Class ${pineClass} + FXSSI fail → SKIP. ${fxssiCheck.reason}` };
  }

  // 9. Intel key levels context (annotation only)
  const atr          = payload.atr || slDist;
  const intelContext = getIntelContext(symbol, entry, tp, atr, db);

  const fxssiNote = fxssiCheck.passed ? `✓ ${fxssiCheck.reason}` : `⚠ ${fxssiCheck.reason}`;
  const reasoning = [
    `Class ${pineClass} ${verdict}`,
    fxssiNote,
    intelContext
  ].filter(Boolean).join(' · ');

  return { verdict, blocked: false, reason: reasoning, rr, intelContext };
}

module.exports = { runAbcGates };
