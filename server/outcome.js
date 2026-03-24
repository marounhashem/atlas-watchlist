const { getOpenSignals, updateOutcome, updatePaperOutcome, getLatestMarketData, updateMFE, run } = require('./db');
const claudeLearner = require('./claudeLearner');

// checkOutcomes runs across ALL cycles — retired signals still get WIN/LOSS detected
// Only dedup (saveSignal) uses getCurrentCycleOpenSignals

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

    // ── Track max favorable excursion (MFE) on ACTIVE signals ────────────────
    // MFE = how far price moved toward TP before reversing
    // Stored so Claude can distinguish "right direction, bad SL" vs "wrong call"
    if (currentState === 'ACTIVE' && entry) {
      let favorable = 0;
      if (direction === 'LONG'  && price > entry) favorable = price - entry;
      if (direction === 'SHORT' && price < entry) favorable = entry - price;
      if (favorable > 0) {
        const mfePct = Math.round((favorable / entry) * 10000) / 100;
        updateMFE(id, favorable, mfePct);
      }
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
        // Fire Claude learning automatically
        claudeLearner.onOutcome({ ...sig, pnl_pct: pnlPct }, outcome, broadcast).catch(e =>
          console.error('[Claude] Auto-learning error:', e.message)
        );
      }

      // ── Expire ACTIVE signals older than 24h ────────────────────────────────
      // An ACTIVE signal stuck for 24h means price is going nowhere — treat as EXPIRED
      if (currentState === 'ACTIVE' && !outcome) {
        const ageHours = (Date.now() - sig.ts) / 3600000;
        if (ageHours > 24) {
          updateOutcome(id, 'EXPIRED', 0);
          console.log(`[Outcome] ${sig.symbol} ${direction} → EXPIRED (ACTIVE 24h timeout)`);
          if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome: 'EXPIRED', ts: Date.now() });
        }
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

    // ── WATCH paper trade tracking ────────────────────────────────────────────
    // Only track paper outcome if entry was actually touched first
    // Otherwise we're measuring signals that were never realistically enterable
    if (sig.verdict === 'WATCH' && !sig.paper_outcome && entry && sl && tp) {
      // Check entry was touched (same tolerance as real entry detection)
      const watchEntryTouched = direction === 'LONG'
        ? price <= entry + tolerance
        : price >= entry - tolerance;

      if (watchEntryTouched) {
        let paperOutcome = null;
        if (direction === 'LONG') {
          if (price >= tp) paperOutcome = 'WIN';
          else if (price <= sl) paperOutcome = 'LOSS';
        } else {
          if (price <= tp) paperOutcome = 'WIN';
          else if (price >= sl) paperOutcome = 'LOSS';
        }
        if (paperOutcome) {
          updatePaperOutcome(id, paperOutcome);
          console.log(`[Outcome] ${sig.symbol} ${direction} WATCH → paper ${paperOutcome}`);
          if (broadcast) broadcast({ type: 'PAPER_OUTCOME', signalId: id, symbol: sig.symbol, direction, paperOutcome, ts: Date.now() });
        }
      }
    }
  }
}

module.exports = { checkOutcomes };
