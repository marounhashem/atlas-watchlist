const { getOpenSignals, updateOutcome, getLatestMarketData, run } = require('./db');

// Signal lifecycle:
// OPEN (entry not touched) → ACTIVE (entry touched, TP/SL not yet) → WIN / LOSS
// OPEN can also be REPLACED (better signal superseded it)
// ACTIVE signals cannot be replaced

function checkOutcomes(broadcast) {
  const openSignals = getOpenSignals(); // returns OPEN and ACTIVE
  if (openSignals.length === 0) return;

  for (const sig of openSignals) {
    const data = getLatestMarketData(sig.symbol);
    if (!data || !data.close) continue;

    const price = data.close;
    const { direction, entry, sl, tp, id, outcome: currentState } = sig;
    if (!entry || !sl || !tp) continue;

    const tolerance = entry * 0.0015; // 0.15% tolerance for entry touch detection

    // ── Check entry touched ──────────────────────────────────────────────────
    let entryTouched = false;
    if (direction === 'LONG')  entryTouched = price <= entry + tolerance;
    if (direction === 'SHORT') entryTouched = price >= entry - tolerance;

    if (currentState === 'OPEN' && entryTouched) {
      // Transition OPEN → ACTIVE
      updateOutcome(id, 'ACTIVE', null);
      console.log(`[Outcome] ${sig.symbol} ${direction} → ACTIVE (entry touched @ ${price})`);
      if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome: 'ACTIVE', ts: Date.now() });
      continue;
    }

    // ── Check TP / SL for ACTIVE signals ─────────────────────────────────────
    if (currentState === 'ACTIVE') {
      let outcome = null;
      let pnlPct  = null;

      if (direction === 'LONG') {
        if (price >= tp) {
          outcome = 'WIN';
          pnlPct  = Math.round(((tp - entry) / entry) * 10000) / 100;
        } else if (price <= sl) {
          outcome = 'LOSS';
          pnlPct  = Math.round(((sl - entry) / entry) * 10000) / 100;
        }
      } else {
        if (price <= tp) {
          outcome = 'WIN';
          pnlPct  = Math.round(((entry - tp) / entry) * 10000) / 100;
        } else if (price >= sl) {
          outcome = 'LOSS';
          pnlPct  = Math.round(((entry - sl) / entry) * 10000) / 100;
        }
      }

      if (outcome) {
        updateOutcome(id, outcome, pnlPct);
        console.log(`[Outcome] ${sig.symbol} ${direction} → ${outcome} (${pnlPct > 0 ? '+' : ''}${pnlPct}%)`);
        if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome, pnlPct, ts: Date.now() });
      }
    }

    // ── Expire OPEN signals older than 48h ────────────────────────────────────
    if (currentState === 'OPEN') {
      const ageHours = (Date.now() - sig.ts) / 3600000;
      if (ageHours > 48) {
        updateOutcome(id, 'EXPIRED', 0);
        console.log(`[Outcome] ${sig.symbol} ${direction} → EXPIRED (48h)`);
        if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome: 'EXPIRED', ts: Date.now() });
      }
    }
  }
}

module.exports = { checkOutcomes };
