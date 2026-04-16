'use strict';

const db = require('./db');
const { getAbcDp } = require('./abcProcessor');

// RSI history — in-memory, resets on deploy (rebuilds within 5 min)
const rsiHistory = {};

function trackRsi(symbol, rsi) {
  if (rsi == null) return;
  if (!rsiHistory[symbol]) rsiHistory[symbol] = [];
  rsiHistory[symbol].push(rsi);
  if (rsiHistory[symbol].length > 20) rsiHistory[symbol].shift();
}

function getRsiSlope(symbol) {
  const h = rsiHistory[symbol];
  if (!h || h.length < 4) return 0;
  const recent = h.slice(-4);
  return recent[recent.length - 1] - recent[0];
}

function checkAbcOutcomes(broadcast) {
  const signals = db.getOpenAbcSignals();
  if (!signals.length) return;

  for (const sig of signals) {
    const md = db.getLatestMarketData(sig.symbol);
    if (!md || !md.close) continue;

    const price = md.close;
    const barHigh = md.high || price;
    const barLow = md.low || price;
    const { direction, entry, sl, id } = sig;
    if (!entry || !sl) continue;

    const tp = sig.tp2 || sig.tp;
    const tp1 = sig.tp1;
    const tp3 = sig.tp3;
    if (!tp) continue;

    const slDist = Math.abs(sl - entry);
    const tpDist = Math.abs(tp - entry);
    const tolerance = entry * 0.0015;
    const dp = getAbcDp(sig.symbol);

    // Track RSI
    trackRsi(sig.symbol, md.rsi);
    const rsi = md.rsi || 50;
    const rsiSlope = getRsiSlope(sig.symbol);

    // ── OPEN → ACTIVE (entry touch) ─────────────────────────────────
    if (sig.outcome === 'OPEN') {
      // Thesis invalidation — OPEN >6h and price >5% away from entry → EXPIRED
      const ageHours = (Date.now() - sig.ts) / 3600000;
      const awayPct = direction === 'LONG'
        ? (price - entry) / entry
        : (entry - price) / entry;
      if (ageHours > 6 && awayPct > 0.05) {
        db.updateAbcOutcome(id, 'EXPIRED', 0, `thesis stale: ${ageHours.toFixed(1)}h, ${(awayPct * 100).toFixed(1)}% away`);
        console.log(`[ABC Outcome] ${sig.symbol} ${direction} id:${id} → EXPIRED (thesis stale: ${ageHours.toFixed(1)}h, ${(awayPct * 100).toFixed(1)}% away from entry ${entry})`);
        if (broadcast) broadcast({ type: 'ABC_OUTCOME', signalId: id, outcome: 'EXPIRED', ts: Date.now() });
        continue;
      }
      const touched = direction === 'LONG'
        ? barLow <= entry + tolerance
        : barHigh >= entry - tolerance;
      if (touched) {
        const rsiNow = md.rsi || null;
        // Calculate TP levels if not stored
        let atp1 = tp1, atp2 = tp, atp3 = tp3;
        if (!atp1) {
          const dir = direction === 'LONG' ? 1 : -1;
          atp1 = Math.round((entry + dir * slDist) * dp) / dp;
          atp2 = Math.round(tp * dp) / dp;
          atp3 = Math.round((tp + dir * slDist * 0.5) * dp) / dp;
        }
        db.activateAbcSignal(id, atp1, atp2, atp3, rsiNow);
        console.log(`[ABC Outcome] ${sig.symbol} ${direction} id:${id} → ACTIVE (RSI: ${rsiNow})`);
        if (broadcast) broadcast({ type: 'ABC_OUTCOME', signalId: id, outcome: 'ACTIVE', ts: Date.now() });
      }
      continue;
    }

    if (sig.outcome !== 'ACTIVE') continue;

    // ── Expiry enforcement — ACTIVE signals past expires_at → EXPIRED
    if (sig.expires_at && Date.now() > sig.expires_at) {
      db.updateAbcOutcome(id, 'EXPIRED', 0, `active expired after ${((Date.now() - sig.active_ts) / 3600000).toFixed(1)}h`);
      console.log(`[ABC Outcome] ${sig.symbol} ${direction} id:${id} → EXPIRED (past expires_at)`);
      if (broadcast) broadcast({ type: 'ABC_OUTCOME', signalId: id, outcome: 'EXPIRED', ts: Date.now() });
      continue;
    }

    // ── SL hit ──────────────────────────────────────────────────────
    const slHit = direction === 'LONG' ? barLow <= sl : barHigh >= sl;
    if (slHit) {
      const pnl = -Math.round((slDist / entry) * 10000) / 100;
      db.updateAbcOutcome(id, 'LOSS', pnl, 'SL hit');
      console.log(`[ABC Outcome] ${sig.symbol} ${direction} → LOSS ${pnl}%`);
      if (broadcast) broadcast({ type: 'ABC_OUTCOME', signalId: id, symbol: sig.symbol, outcome: 'LOSS', pnl_pct: pnl, ts: Date.now() });
      continue;
    }

    // ── TP2 hit (main target = WIN) ─────────────────────────────────
    const tp2Hit = direction === 'LONG' ? barHigh >= tp : barLow <= tp;
    if (tp2Hit) {
      const pnl = Math.round((tpDist / entry) * 10000) / 100;
      db.updateAbcOutcome(id, 'WIN', pnl, 'TP2 hit');
      console.log(`[ABC Outcome] ${sig.symbol} ${direction} → WIN +${pnl}%`);
      if (broadcast) broadcast({ type: 'ABC_OUTCOME', signalId: id, symbol: sig.symbol, outcome: 'WIN', pnl_pct: pnl, ts: Date.now() });
      continue;
    }

    // ── MFE tracking ────────────────────────────────────────────────
    const favorablePrice = direction === 'LONG' ? barHigh : barLow;
    const currentMfe = direction === 'LONG'
      ? (favorablePrice - entry) / entry * 100
      : (entry - favorablePrice) / entry * 100;
    const newMfe = Math.max(sig.mfe_pct || 0, Math.round(currentMfe * 100) / 100);
    const mfePrice = newMfe > (sig.mfe_pct || 0) ? favorablePrice : (sig.mfe_price || favorablePrice);

    // ── Progress toward TP ──────────────────────────────────────────
    const priceDist = direction === 'LONG' ? price - entry : entry - price;
    let progressPct = tpDist > 0 ? Math.round((priceDist / tpDist) * 100) : 0;

    db.updateAbcActive(id, { mfe_pct: newMfe, mfe_price: mfePrice, progress_pct: progressPct });

    // ── RECOMMENDATIONS (DB-persisted dedup) ─────────────────────────

    // 1. TP1 HIT — PARTIAL_CLOSE
    if (tp1 && !sig.partial_closed) {
      const tp1Hit = direction === 'LONG' ? barHigh >= tp1 : barLow <= tp1;
      if (tp1Hit) {
        db.updateAbcActive(id, { partial_closed: 1 });
        if (!db.isAbcRecSent(id, 'PARTIAL_CLOSE')) {
          if (broadcast) broadcast({
            type: 'ABC_RECOMMENDATION', signalId: id, symbol: sig.symbol,
            rec: { type: 'PARTIAL_CLOSE', urgency: 'HIGH',
                   reason: 'TP1 hit — close 40% of position. Move SL to breakeven: ' + entry },
            ts: Date.now()
          });
          db.markAbcRecSent(id, 'PARTIAL_CLOSE');
        }
      }
    }

    // 2. TP2 APPROACHING — TRAIL SL
    if (progressPct >= 75 && sig.partial_closed && !sig.trail_sl_sent) {
      db.updateAbcActive(id, { trail_sl_sent: 1 });
      if (!db.isAbcRecSent(id, 'MOVE_SL')) {
        if (broadcast) broadcast({
          type: 'ABC_RECOMMENDATION', signalId: id, symbol: sig.symbol,
          rec: { type: 'MOVE_SL', urgency: 'MEDIUM',
                 reason: 'Within 25% of main target — trail SL to TP1 (' + tp1 + ') to lock profit' },
          ts: Date.now()
        });
        db.markAbcRecSent(id, 'MOVE_SL');
      }
    }

    // 3. RSI DIVERGENCE — WATCH
    if (progressPct > 30 && progressPct < 80 && !db.isAbcRecSent(id, 'RSI_DIVERGENCE')) {
      const rsiEntry = sig.rsi_at_entry || 50;
      const diverging = (direction === 'LONG' && rsi < rsiEntry && rsiSlope < -3)
                     || (direction === 'SHORT' && rsi > rsiEntry && rsiSlope > 3);
      if (diverging) {
        if (broadcast) broadcast({
          type: 'ABC_RECOMMENDATION', signalId: id, symbol: sig.symbol,
          rec: { type: 'WATCH', urgency: 'MEDIUM',
                 reason: 'Momentum diverging from price at ' + progressPct + '% progress — consider tightening SL' },
          ts: Date.now()
        });
        db.markAbcRecSent(id, 'RSI_DIVERGENCE');
      }
    }

    // 4. RSI EXHAUSTION — CLOSE
    if (progressPct > 55 && !db.isAbcRecSent(id, 'RSI_EXHAUSTION')) {
      const exhausted = (direction === 'LONG' && rsi > 72) || (direction === 'SHORT' && rsi < 28);
      if (exhausted) {
        if (broadcast) broadcast({
          type: 'ABC_RECOMMENDATION', signalId: id, symbol: sig.symbol,
          rec: { type: 'CLOSE', urgency: 'HIGH',
                 reason: 'RSI exhausted (' + Math.round(rsi) + ') with ' + progressPct + '% progress — high reversal risk' },
          ts: Date.now()
        });
        db.markAbcRecSent(id, 'RSI_EXHAUSTION');
      }
    }

    // 5. RSI LOSES 50 — WATCH
    if (progressPct < 45 && !db.isAbcRecSent(id, 'RSI_50_CROSS')) {
      const lost50 = (direction === 'LONG' && rsi < 50 && rsiSlope < -4)
                  || (direction === 'SHORT' && rsi > 50 && rsiSlope > 4);
      if (lost50) {
        if (broadcast) broadcast({
          type: 'ABC_RECOMMENDATION', signalId: id, symbol: sig.symbol,
          rec: { type: 'WATCH', urgency: 'MEDIUM',
                 reason: 'RSI crossed 50 against direction — momentum weakening. Move SL to entry if not done' },
          ts: Date.now()
        });
        db.markAbcRecSent(id, 'RSI_50_CROSS');
      }
    }

    // 6. RSI ACCELERATION — INFO (2h rolling window)
    if (progressPct >= 20 && progressPct <= 70) {
      const accelerating = (direction === 'LONG' && rsiSlope > 5 && rsi < 65)
                        || (direction === 'SHORT' && rsiSlope < -5 && rsi > 35);
      if (accelerating && !db.isAbcInfoRecSentRecently(id)) {
        if (broadcast) broadcast({
          type: 'ABC_RECOMMENDATION', signalId: id, symbol: sig.symbol,
          rec: { type: 'INFO', urgency: 'LOW',
                 reason: 'Momentum accelerating in trade direction (RSI slope: ' + (rsiSlope > 0 ? '+' : '') + Math.round(rsiSlope) + ') — hold position' },
          ts: Date.now()
        });
        db.markAbcRecSent(id, 'INFO');
      }
    }

    // 7. DEAD TRADE — TIME STOP
    if (sig.active_ts && !db.isAbcRecSent(id, 'TIME_STOP')) {
      const hoursActive = (Date.now() - sig.active_ts) / 3600000;
      if (hoursActive > 6 && progressPct < 15 && Math.abs(rsiSlope) < 2) {
        if (broadcast) broadcast({
          type: 'ABC_RECOMMENDATION', signalId: id, symbol: sig.symbol,
          rec: { type: 'CLOSE', urgency: 'MEDIUM',
                 reason: 'No movement after ' + Math.round(hoursActive) + 'h — ' + progressPct + '% progress, RSI flat. Exit and free capital' },
          ts: Date.now()
        });
        db.markAbcRecSent(id, 'TIME_STOP');
      }
    }
  }

  // ── Class C tracking (ACTIVE only, no recommendations) ────────────
  const classC = db.getOpenClassCSignals();
  for (const sig of classC) {
    const md = db.getLatestMarketData(sig.symbol);
    if (!md || !md.close) continue;

    const price = md.close;
    const barHigh = md.high || price;
    const barLow = md.low || price;
    const { direction, entry, sl, id } = sig;
    if (!entry || !sl) continue;

    const tp = sig.tp2 || sig.tp1;
    if (!tp) continue;

    const slDist = Math.abs(sl - entry);
    const tpDist = Math.abs(tp - entry);
    const tolerance = entry * 0.0015;

    // OPEN → ACTIVE
    if (sig.outcome === 'OPEN') {
      const touched = direction === 'LONG'
        ? barLow <= entry + tolerance
        : barHigh >= entry - tolerance;
      if (touched) {
        db.activateClassCSignal(id, sig.tp1, sig.tp2, sig.tp3);
        console.log(`[Class C] ${sig.symbol} ${direction} id:${id} → ACTIVE`);
      }
      continue;
    }

    if (sig.outcome !== 'ACTIVE') continue;

    // SL hit
    const slHit = direction === 'LONG' ? barLow <= sl : barHigh >= sl;
    if (slHit) {
      const pnl = -Math.round((slDist / entry) * 10000) / 100;
      db.updateClassCOutcome(id, 'LOSS', pnl, 'SL hit');
      console.log(`[Class C] ${sig.symbol} ${direction} → LOSS ${pnl}%`);
      continue;
    }

    // TP hit
    const tpHit = direction === 'LONG' ? barHigh >= tp : barLow <= tp;
    if (tpHit) {
      const pnl = Math.round((tpDist / entry) * 10000) / 100;
      db.updateClassCOutcome(id, 'WIN', pnl, 'TP hit');
      console.log(`[Class C] ${sig.symbol} ${direction} → WIN +${pnl}%`);
      continue;
    }

    // MFE + progress
    const favorablePrice = direction === 'LONG' ? barHigh : barLow;
    const currentMfe = direction === 'LONG'
      ? (favorablePrice - entry) / entry * 100
      : (entry - favorablePrice) / entry * 100;
    const newMfe = Math.max(sig.mfe_pct || 0, Math.round(currentMfe * 100) / 100);
    const priceDist = direction === 'LONG' ? price - entry : entry - price;
    let progressPct = tpDist > 0 ? Math.round((priceDist / tpDist) * 100) : 0;

    db.updateClassCActive(id, { mfe_pct: newMfe, progress_pct: progressPct });
  }
}

module.exports = { checkAbcOutcomes };
