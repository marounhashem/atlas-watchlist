const { getOpenSignals, updateOutcome, getLatestMarketData } = require('./db');

function checkOutcomes(broadcast) {
  const openSignals = getOpenSignals();
  if (openSignals.length === 0) return;

  let closed = 0;
  for (const sig of openSignals) {
    const data = getLatestMarketData(sig.symbol);
    if (!data || !data.close) continue;

    const price = data.close;
    const { direction, entry, sl, tp, id } = sig;
    if (!entry || !sl || !tp) continue;

    let outcome = null;
    let pnlPct = null;

    if (direction === 'LONG') {
      if (price >= tp) {
        outcome = 'WIN';
        pnlPct = Math.round(((tp - entry) / entry) * 10000) / 100;
      } else if (price <= sl) {
        outcome = 'LOSS';
        pnlPct = Math.round(((sl - entry) / entry) * 10000) / 100;
      }
    } else {
      if (price <= tp) {
        outcome = 'WIN';
        pnlPct = Math.round(((entry - tp) / entry) * 10000) / 100;
      } else if (price >= sl) {
        outcome = 'LOSS';
        pnlPct = Math.round(((entry - sl) / entry) * 10000) / 100;
      }
    }

    // Expire signals older than 48h
    const ageHours = (Date.now() - sig.ts) / 3600000;
    if (!outcome && ageHours > 48) {
      outcome = 'EXPIRED';
      pnlPct = 0;
    }

    if (outcome) {
      updateOutcome(id, outcome, pnlPct);
      closed++;
      console.log(`[Outcome] ${sig.symbol} ${direction} → ${outcome} (${pnlPct > 0 ? '+' : ''}${pnlPct}%)`);
      if (broadcast) {
        broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome, pnlPct, ts: Date.now() });
      }
    }
  }

  if (closed > 0) console.log(`[Outcome] Closed ${closed} signal(s)`);
}

module.exports = { checkOutcomes };
