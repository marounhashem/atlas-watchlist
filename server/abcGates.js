'use strict';

// ── ABC Gate Engine ───────────────────────────────────────────────────────────
// Applies server-side filters to Pine ABC signals.
// Pine has already done structural classification (A/B/C).
// This layer adds: macro blocks, crowd sentiment gates, RR sanity, cooldown, verdict mapping.

const { isBankHoliday } = require('./marketHours');
const { SYMBOLS } = require('./config');
const { isPreEventRisk, isPostEventSuppressed } = require('./forexCalendar');

// ── Verdict mapping by class × crowd sentiment × score ──────────────────────
// Class A: structurally strongest — crowd pass=PROCEED always
// Class B: crowd pass + score >= 65 → PROCEED; else WATCH
// Class C: crowd pass + score >= 55 → WATCH; else SKIP
function mapVerdict(pineClass, fxssiPassed, fxssiNoData, score) {
  const sc = score || 0;
  if (pineClass === 'A') {
    if (fxssiPassed) return 'PROCEED';
    if (fxssiNoData) return 'WATCH';
    return 'WATCH';
  }
  if (pineClass === 'B') {
    if (fxssiPassed) return sc >= 65 ? 'PROCEED' : 'WATCH';
    if (fxssiNoData) return 'WATCH';
    return 'SKIP';
  }
  if (pineClass === 'C') {
    if (fxssiPassed) return sc >= 55 ? 'WATCH' : 'SKIP';
    return 'SKIP';
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

// ── Gravity proximity gate — smart TP cap ────────────────────────────────────
// <30% of path: block entirely (too close to target)
// 30-60%: cap TP just before gravity, let the trade continue
// >60% or out of path: pass through, no adjustment
function checkGravity(direction, entry, tp, fxssiData) {
  if (!fxssiData || !tp || !entry) {
    return { passed: true, reason: 'No gravity data', adjustedTp: null };
  }

  // Skip gravity gate if FXSSI data is stale (>45min)
  const fxssiAge = fxssiData.fetchedAt ? Date.now() - fxssiData.fetchedAt : Infinity;
  if (fxssiAge > 45 * 60 * 1000) {
    return { passed: true, reason: 'Gravity data stale — gate skipped', adjustedTp: null };
  }

  const gravity = fxssiData.gravity_price || fxssiData.fxssi_gravity;
  if (!gravity) return { passed: true, reason: 'No gravity level', adjustedTp: null };

  const tpDist     = Math.abs(tp - entry);
  const gravDist   = Math.abs(gravity - entry);
  const gravInPath = direction === 'LONG'
    ? gravity > entry && gravity < tp
    : gravity < entry && gravity > tp;

  if (!gravInPath) {
    return { passed: true, reason: 'Gravity outside TP path', adjustedTp: null };
  }

  const gravPct = tpDist > 0 ? gravDist / tpDist : 0;

  // Gravity within 30% of TP path — too close to target, block
  if (gravPct < 0.30) {
    return {
      passed: false,
      reason: `Gravity at ${gravity} blocks TP path (${Math.round(gravPct * 100)}% of path)`,
      adjustedTp: null
    };
  }

  // Gravity between 30-60% of path — cap TP just before gravity with 5% buffer
  if (gravPct < 0.60) {
    const buffer = gravDist * 0.05;
    const cappedTp = direction === 'LONG'
      ? Math.round((gravity - buffer) * 100000) / 100000
      : Math.round((gravity + buffer) * 100000) / 100000;
    return {
      passed: true,
      reason: `Gravity at ${gravity} — TP capped to ${cappedTp}`,
      adjustedTp: cappedTp
    };
  }

  // Gravity beyond 60% of path — clear
  return { passed: true, reason: 'Gravity clear of TP path', adjustedTp: null };
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
// Returns { verdict, blocked, reason, intelContext, adjustedTp }
// Score is passed in via payload so verdict mapping can use class+crowd+score.
function runAbcGates(symbol, payload, fxssiData, db) {
  const { pineClass, direction, entry, sl, tp, score } = payload;

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

  // 7. Gravity proximity gate — may cap TP instead of blocking
  const gravityCheck = checkGravity(direction, entry, tp, fxssiData);
  if (!gravityCheck.passed) {
    return { verdict: 'SKIP', blocked: true, gate: 'GRAVITY', reason: gravityCheck.reason };
  }

  // 8. Class × crowd × score verdict mapping
  const verdict = mapVerdict(pineClass, fxssiCheck.passed, fxssiCheck.noData, score);
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
    gravityCheck.adjustedTp ? `⚠ TP capped by gravity` : '',
    intelContext
  ].filter(Boolean).join(' · ');

  return {
    verdict,
    blocked: false,
    reason: reasoning,
    rr,
    intelContext,
    adjustedTp: gravityCheck.adjustedTp
  };
}

module.exports = { runAbcGates };
