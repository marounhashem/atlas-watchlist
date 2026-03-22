const { SYMBOLS, getSessionNow, sessionMultiplier } = require('./config');
const { getLatestMarketData, getWeights, insertSignal } = require('./db');

function scoreBias(data) {
  // Pine Script sends bias as integer: -3 to +3
  // EMA alignment, MACD, structure, FVG all baked in
  const raw = Math.abs(data.bias || 0);
  const fvgBonus = data.fvg_present ? 0.15 : 0;
  return Math.min(1.0, (raw / 3) + fvgBonus);
}

function scoreFXSSI(data, direction) {
  // Contrarian logic: high % of crowd on SAME side = stop hunt risk
  // High % on OPPOSITE side = trapped = good for our direction
  const longPct = data.fxssi_long_pct || 50;
  const shortPct = data.fxssi_short_pct || 50;

  if (!direction) return 0.5;

  if (direction === 'LONG') {
    // We want crowd heavily short (trapped bears)
    if (shortPct >= 70) return 1.0;
    if (shortPct >= 60) return 0.75;
    if (shortPct >= 50) return 0.5;
    return 0.25; // crowd is long = dangerous
  } else {
    // We want crowd heavily long (trapped bulls)
    if (longPct >= 70) return 1.0;
    if (longPct >= 60) return 0.75;
    if (longPct >= 50) return 0.5;
    return 0.25;
  }
}

function scoreOrderBook(data, direction) {
  // Absorption at key levels, imbalance, large resting orders
  let score = 0.4; // baseline
  if (data.ob_absorption) score += 0.3;
  const imbalance = data.ob_imbalance || 0;
  if (direction === 'LONG' && imbalance > 0.3) score += 0.2;
  if (direction === 'SHORT' && imbalance < -0.3) score += 0.2;
  if (data.ob_large_orders) score += 0.1;
  return Math.min(1.0, score);
}

function scoreSession(symbol) {
  return sessionMultiplier(symbol);
}

function inferDirection(data) {
  if (!data) return null;
  const bias = data.bias || 0;
  if (bias > 0) return 'LONG';
  if (bias < 0) return 'SHORT';
  // Fallback to structure if bias is 0
  if (data.structure === 'bullish') return 'LONG';
  if (data.structure === 'bearish') return 'SHORT';
  return null;
}

function calcRR(entry, sl, tp, direction) {
  if (!entry || !sl || !tp) return null;
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return null;
  return Math.round((reward / risk) * 10) / 10;
}

function scoreSymbol(symbol) {
  let data;
  try { data = getLatestMarketData(symbol); } catch(e) { return null; }
  if (!data) return null;

  const cfg = SYMBOLS[symbol];
  if (!cfg) return null;

  // Get live weights from DB (updated by learner every 30m)
  const w = getWeights(symbol);
  const weights = w ? {
    pineBias: w.pine_bias,
    fxssiSentiment: w.fxssi_sentiment,
    orderBook: w.order_book,
    sessionQuality: w.session_quality
  } : cfg.scoringWeights;

  const minScore = w ? w.min_score_proceed : cfg.minScoreProceed;
  const direction = inferDirection(data);
  if (!direction) return null;

  const biasSc = scoreBias(data);
  const fxssiSc = scoreFXSSI(data, direction);
  const obSc = scoreOrderBook(data, direction);
  const sessionSc = scoreSession(symbol);

  const total = (
    biasSc * weights.pineBias +
    fxssiSc * weights.fxssiSentiment +
    obSc * weights.orderBook +
    sessionSc * weights.sessionQuality
  ) * 100;

  const score = Math.round(total);

  let verdict = 'SKIP';
  if (score >= minScore) verdict = 'PROCEED';
  else if (score >= 55) verdict = 'WATCH';

  const close = data.close || 0;
  const atr = estimateATR(data, cfg.assetClass);

  let entry = close;
  let sl, tp;
  if (direction === 'LONG') {
    sl = Math.round((close - atr * 1.5) * 10000) / 10000;
    tp = Math.round((close + atr * 3.0) * 10000) / 10000;
  } else {
    sl = Math.round((close + atr * 1.5) * 10000) / 10000;
    tp = Math.round((close - atr * 3.0) * 10000) / 10000;
  }

  const rr = calcRR(entry, sl, tp, direction);

  const reasoning = buildReasoning(symbol, direction, {
    biasSc, fxssiSc, obSc, sessionSc, data, cfg
  });

  return {
    symbol,
    label: cfg.label,
    direction,
    score,
    verdict,
    entry: Math.round(close * 100) / 100,
    sl,
    tp,
    rr,
    session: getSessionNow(),
    breakdown: { bias: biasSc, fxssi: fxssiSc, ob: obSc, session: sessionSc },
    reasoning,
    ts: Date.now()
  };
}

function estimateATR(data, assetClass) {
  const range = (data.high || 0) - (data.low || 0);
  if (range > 0) return range;
  // Fallback ATR estimates by asset class
  const fallbacks = { commodity: 2.5, crypto: 300, index: 15 };
  return fallbacks[assetClass] || 5;
}

function buildReasoning(symbol, direction, { biasSc, fxssiSc, obSc, sessionSc, data, cfg }) {
  const parts = [];
  if (biasSc > 0.7) parts.push(`Strong ${direction} structure on Pine (${Math.round(biasSc * 100)}%)`);
  else if (biasSc > 0.4) parts.push(`Moderate ${direction} bias`);
  else parts.push(`Weak bias — treat with caution`);

  const longPct = data.fxssi_long_pct || 50;
  const shortPct = data.fxssi_short_pct || 50;
  if (fxssiSc > 0.7) parts.push(`Crowd trapped (${direction === 'LONG' ? shortPct + '% short' : longPct + '% long'}) — contrarian favour`);
  else if (fxssiSc < 0.35) parts.push(`Crowd aligned with trade — stop hunt risk`);

  if (data.ob_absorption) parts.push(`Order book absorption detected at level`);
  if (data.fvg_present) parts.push(`FVG present — entry zone active`);

  const session = getSessionNow();
  if (session === cfg.peakSession) parts.push(`Peak session (${session}) — optimal timing`);
  else if (session === 'offHours') parts.push(`Off-hours — reduced reliability`);

  return parts.join(' · ');
}

function scoreAllPriority() {
  const { SYMBOLS } = require('./config');
  const { isMarketOpen } = require('./marketHours');
  const results = [];
  for (const symbol of Object.keys(SYMBOLS)) {
    try {
      const open = isMarketOpen(symbol);
      if (!open) {
        // Return a CLOSED placeholder — shown in dashboard but not scored
        results.push({
          symbol,
          label: SYMBOLS[symbol].label,
          direction: null,
          score: 0,
          verdict: 'CLOSED',
          session: 'closed',
          reasoning: 'Market closed',
          ts: Date.now()
        });
        continue;
      }
      const result = scoreSymbol(symbol);
      if (result) {
        results.push(result);
      } else {
        // Symbol is open but no data yet or no direction — show as SKIP
        results.push({
          symbol,
          label: SYMBOLS[symbol].label,
          direction: null,
          score: 0,
          verdict: 'SKIP',
          session: require('./config').getSessionNow(),
          reasoning: 'No data yet or insufficient bias signal',
          ts: Date.now()
        });
      }
    } catch (e) {
      console.error(`Scorer error ${symbol}:`, e.message);
    }
  }
  // Sort: open symbols first (by score desc), closed at bottom
  return results.sort((a, b) => {
    if (a.verdict === 'CLOSED' && b.verdict !== 'CLOSED') return 1;
    if (b.verdict === 'CLOSED' && a.verdict !== 'CLOSED') return -1;
    return (b.score || 0) - (a.score || 0);
  });
}

function isBetterSignal(existing, candidate) {
  // Better R:R
  const betterRR = (candidate.rr || 0) > (existing.rr || 0);
  // Tighter SL — closer to entry = less risk
  const existingSlDist = Math.abs((existing.sl || 0) - (existing.entry || 0));
  const candidateSlDist = Math.abs((candidate.sl || 0) - (candidate.entry || 0));
  const tighterSL = candidateSlDist < existingSlDist * 0.98; // at least 2% tighter
  // Higher TP — further from entry in trade direction
  const existingTpDist = Math.abs((existing.tp || 0) - (existing.entry || 0));
  const candidateTpDist = Math.abs((candidate.tp || 0) - (candidate.entry || 0));
  const higherTP = candidateTpDist > existingTpDist * 1.02; // at least 2% further
  return betterRR || tighterSL || higherTP;
}

function entryTouched(signal, currentPrice) {
  if (!currentPrice || !signal.entry) return false;
  const entry = signal.entry;
  // Entry touched if price crossed through entry point (within 0.15% tolerance)
  const tolerance = entry * 0.0015;
  if (signal.direction === 'LONG')  return currentPrice <= entry + tolerance;
  if (signal.direction === 'SHORT') return currentPrice >= entry - tolerance;
  return false;
}

function saveSignal(scored) {
  if (scored.verdict !== 'PROCEED' && scored.verdict !== 'WATCH') return null;

  let last = null;
  try {
    const { getLatestOpenSignal, getLatestMarketData, updateOutcome } = require('./db');
    last = getLatestOpenSignal(scored.symbol, scored.direction);
  } catch(e) {
    console.error('[Scorer] dedup lookup error:', e.message);
  }

  if (last) {
    // Get current price to check if entry already touched
    const { getLatestMarketData, updateOutcome } = require('./db');
    const marketData = getLatestMarketData(scored.symbol);
    const currentPrice = marketData ? marketData.close : null;

    if (entryTouched(last, currentPrice)) {
      // Entry touched — signal is active, never replace
      console.log(`[Scorer] ${scored.symbol} entry touched — keeping original signal`);
      return null;
    }

    // Entry not touched — check if new signal is meaningfully better
    if (isBetterSignal(last, scored)) {
      // Save new signal first — only replace old if save succeeds
      const newId = insertSignal(scored);
      if (newId) {
        updateOutcome(last.id, 'REPLACED', 0);
        console.log(`[Scorer] ${scored.symbol} ${scored.direction} — refined (RR:${last.rr}→${scored.rr} SL:${last.sl}→${scored.sl})`);
        return newId;
      }
    }

    // Not better or save failed — keep existing, skip
    console.log(`[Scorer] ${scored.symbol} ${scored.direction} — keeping existing signal`);
    return null;
  }

  return insertSignal(scored);
}

module.exports = { scoreSymbol, scoreAllPriority, saveSignal };
