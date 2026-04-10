'use strict';

// ── ABC Gate Engine ───────────────────────────────────────────────────────────
// Applies server-side filters to Pine ABC signals.
// Pine has already done structural classification (A/B/C).
// This layer adds: macro blocks, crowd sentiment gates, RR sanity, cooldown, verdict mapping.

const { isBankHoliday } = require('./marketHours');
const { SYMBOLS } = require('./config');
const { isPreEventRisk, isPostEventSuppressed } = require('./forexCalendar');

// ── Verdict mapping by class × crowd sentiment ────────────────────────────────
// Class A: structurally strongest — crowd sentiment pass=PROCEED, fail=WATCH
// Class B: needs crowd sentiment — pass=PROCEED, fail=SKIP
// Class C: weakest — crowd sentiment pass=WATCH, fail=SKIP
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

// ── Crowd sentiment gate — same logic as scorer ───────────────────────────────
// Returns { passed: bool, reason: string }
function checkFxssi(symbol, fxssiData) {
  // Truly no data — market data record doesn't exist or has no FXSSI fields at all
  if (!fxssiData || (fxssiData.fxssi_long_pct == null && fxssiData.fxssi_short_pct == null)) {
    return { passed: false, noData: true, reason: 'No crowd sentiment data available for this symbol' };
  }

  const direction = fxssiData._direction;
  const trapped   = fxssiData.fxssi_trapped;

  // Data present but crowd not sufficiently one-sided (neither side >60%)
  if (trapped == null) {
    return {
      passed: false,
      noData: false,
      reason: `Crowd split (long:${fxssiData.fxssi_long_pct?.toFixed(1)}% short:${fxssiData.fxssi_short_pct?.toFixed(1)}%) — no contrarian edge`
    };
  }

  const trappedAligned = (direction === 'LONG'  && trapped === 'SHORT') ||
                         (direction === 'SHORT' && trapped === 'LONG');
  if (!trappedAligned) {
    return { passed: false, noData: false, reason: 'Crowd aligned with direction — no contrarian squeeze' };
  }
  return { passed: true, noData: false, reason: `Crowd majority ${trapped === 'SHORT' ? 'short' : 'long'} — contrarian ${direction.toLowerCase()} pressure` };
}

// ── Gravity proximity gate ────────────────────────────────────────────────────
// If TP is blocked by a gravity cluster, skip the trade
function checkGravity(direction, tp, fxssiData) {
  if (!fxssiData || !tp) return { passed: true, reason: 'No gravity data' };

  // Skip gravity gate if FXSSI data is stale (>45min)
  const fxssiAge = fxssiData.fetchedAt ? Date.now() - fxssiData.fetchedAt : Infinity;
  if (fxssiAge > 45 * 60 * 1000) {
    return { passed: true, reason: 'Gravity data stale — gate skipped' };
  }

  const gravity = fxssiData.gravity_price || fxssiData.fxssi_gravity;
  if (!gravity) return { passed: true, reason: 'No gravity level' };

  const entry = fxssiData._entry;
  if (!entry) return { passed: true, reason: 'No entry for gravity check' };

  const tpDist     = Math.abs(tp - entry);
  const gravDist   = Math.abs(gravity - entry);
  const gravInPath = direction === 'LONG'
    ? gravity > entry && gravity < tp
    : gravity < entry && gravity > tp;

  // Block only if gravity is in the first half of the TP path (within 50%)
  if (gravInPath && gravDist < tpDist * 0.50) {
    return { passed: false, reason: `Gravity at ${gravity} blocks TP path (${Math.round(gravDist/tpDist*100)}% of move)` };
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
    return { verdict: 'SKIP', blocked: true, gate: 'BANKHOLIDAY', reason: 'Bank holiday' };
  }

  // 2. Pre-event suppression (<30min to high-impact event)
  if (isPreEventRisk && isPreEventRisk(symbol)) {
    return { verdict: 'SKIP', blocked: true, gate: 'PREEVENT', reason: 'Pre-event suppression' };
  }

  // 3. Post-event volatility window (<5min after event)
  if (isPostEventSuppressed && isPostEventSuppressed(symbol)) {
    return { verdict: 'SKIP', blocked: true, gate: 'PREEVENT', reason: 'Post-event volatility block' };
  }

  // 4. RR sanity check
  if (!entry || !sl || !tp) {
    return { verdict: 'SKIP', blocked: true, gate: 'RR', reason: 'Missing entry/sl/tp from Pine' };
  }
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp   - entry);
  const rr     = slDist > 0 ? Math.round((tpDist / slDist) * 10) / 10 : 0;
  if (rr < 1.5) {
    return { verdict: 'SKIP', blocked: true, gate: 'RR', reason: `RR ${rr} below 1.5` };
  }

  // 4b. Minimum SL distance — reject suspiciously tight stops
  const isForex = symbol.length === 6 && !['BTCUSD','ETHUSD','OILWTI','GOLD','SILVER','COPPER','PLATINUM'].includes(symbol);
  const minSlPct = isForex ? 0.0005 : 0.001;
  const slPct = slDist / entry;
  if (slPct < minSlPct) {
    return { verdict: 'SKIP', blocked: true, gate: 'MINSL', reason: `SL too tight (${(slPct*100).toFixed(3)}% < min ${(minSlPct*100).toFixed(3)}%)` };
  }

  // 4c. Hard block — noOrderBook instruments have no FXSSI permanently,
  // not temporarily. NO_DATA verdict on these is meaningless. SKIP all classes.
  const symConfig = SYMBOLS[symbol];
  if (symConfig?.noOrderBook) {
    return { verdict: 'SKIP', blocked: true, gate: 'NOORDERBOOK', reason: 'No contrarian data available for this class of symbols' };
  }

  // 5. Inject direction into fxssiData for gate checks
  if (fxssiData) fxssiData._direction = direction;
  if (fxssiData) fxssiData._entry     = entry;

  // 6. Crowd sentiment gate
  const fxssiCheck = checkFxssi(symbol, fxssiData);

  // 7. Gravity proximity gate
  const gravityCheck = checkGravity(direction, tp, fxssiData);
  if (!gravityCheck.passed) {
    return { verdict: 'SKIP', blocked: true, gate: 'GRAVITY', reason: gravityCheck.reason };
  }

  // 8. Class × crowd sentiment verdict mapping
  const verdict = mapVerdict(pineClass, fxssiCheck.passed, fxssiCheck.noData);
  if (verdict === 'SKIP') {
    return { verdict: 'SKIP', blocked: true, gate: 'CROWD', reason: `Class ${pineClass} + crowd sentiment fail → SKIP. ${fxssiCheck.reason}` };
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
