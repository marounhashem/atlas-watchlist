const { SYMBOLS, getSessionNow, sessionMultiplier } = require('./config');
const { getLatestMarketData, getWeights, insertSignal } = require('./db');

function scoreBias(data) {
  // v2: bias score is now -8 to +8 (emaScore 5TF + vwapDir + rsi×2 + macd + struct4h)
  // v1: bias was -3 to +3
  const raw = Math.abs(data.bias || 0);
  const maxBias = raw > 3 ? 8 : 3;
  const fvgBonus = data.fvg_present ? 0.10 : 0;

  let vwapBonus = 0;
  try {
    if (data.raw_payload) {
      const raw2 = JSON.parse(data.raw_payload);
      const vwap = raw2.vwap;
      if (vwap && (vwap.aboveUpper2 || vwap.belowLower2)) vwapBonus = 0.10;
    }
  } catch(e) {}

  // ── Momentum alignment bonus (v2 Pine only) ───────────────────────────────
  let momBonus = 0;
  try {
    if (data.raw_payload) {
      const raw3 = JSON.parse(data.raw_payload);
      const mom = raw3.momScore;
      if (mom != null && !isNaN(mom)) {
        if      (mom >= 80) momBonus = 0.15;
        else if (mom >= 60) momBonus = 0.10;
        else if (mom >= 30) momBonus = 0.05;
        else if (mom < 15 && raw >= 3) momBonus = -0.08;
      }

      // ── Confluence bonus ───────────────────────────────────────────────────
      // Independent sources agreeing = much higher conviction than raw bias alone
      const cc = raw3.confluenceCount;
      if (cc != null && !isNaN(cc)) {
        if      (cc >= 5) momBonus += 0.15;
        else if (cc >= 4) momBonus += 0.10;
        else if (cc >= 3) momBonus += 0.05;
        else if (cc <= 1) momBonus -= 0.08;
      }

      // ── FVG quality ────────────────────────────────────────────────────────
      const fvg = raw3.fvg;
      if (fvg) {
        const bq = fvg.bullQuality; const brq = fvg.bearQuality;
        if (bq === 'stale' || brq === 'stale')   momBonus -= 0.06;
        if (bq === 'fresh' || brq === 'fresh')   momBonus += 0.04;
      }

      // ── Opening range penalty ──────────────────────────────────────────────
      if (raw3.isOpeningRange === true || raw3.isOpeningRange === 'true') {
        momBonus -= 0.04;
      }
    }
  } catch(e) {}

  return Math.min(1.0, Math.max(0, (raw / maxBias) + fvgBonus + vwapBonus + momBonus));
}

function scoreFXSSI(data, direction) {
  if (!direction) return 0.5;

  const longPct  = data.fxssi_long_pct  || 50;
  const shortPct = data.fxssi_short_pct || 50;

  let fxssi = null;
  try {
    const raw = data.fxssi_analysis || data.raw_payload;
    if (raw) {
      const parsed = JSON.parse(raw);
      fxssi = parsed.fxssiAnalysis
        ? (typeof parsed.fxssiAnalysis === 'string' ? JSON.parse(parsed.fxssiAnalysis) : parsed.fxssiAnalysis)
        : (parsed.longPct != null ? parsed : null);
    }
  } catch(e) {}

  let score = 0.5;

  // 1. Contrarian crowd position
  if (direction === 'LONG') {
    if (shortPct >= 70) score += 0.30;
    else if (shortPct >= 60) score += 0.20;
    else if (longPct >= 65) score -= 0.20;
    else if (longPct >= 70) score -= 0.30;
  } else {
    if (longPct >= 70) score += 0.30;
    else if (longPct >= 60) score += 0.20;
    else if (shortPct >= 65) score -= 0.20;
    else if (shortPct >= 70) score -= 0.30;
  }

  // 2. In profit ratio
  if (fxssi) {
    const inProfit = fxssi.inProfitPct || 50;
    if (inProfit > 65) score -= 0.15;
    if (inProfit < 35) score += 0.10;
  }

  // 3. SL cluster gravity in direction
  if (fxssi && data.close) {
    const cp = data.close;
    if (direction === 'LONG'  && fxssi.nearestSLAbove?.price) score += 0.10;
    if (direction === 'SHORT' && fxssi.nearestSLBelow?.price) score += 0.10;
    if (direction === 'LONG'  && fxssi.losingClusters?.some(l => l.price < cp)) score += 0.08;
    if (direction === 'SHORT' && fxssi.losingClusters?.some(l => l.price > cp)) score += 0.08;
    if (direction === 'LONG'  && fxssi.nearestLimitAbove?.price) score -= 0.08;
    if (direction === 'SHORT' && fxssi.nearestLimitBelow?.price) score -= 0.08;
  }

  // 4. Absorption
  if (data.ob_absorption && direction === 'LONG') score += 0.10;

  // 5. Signal bias
  if (fxssi?.signals?.bias) {
    if (fxssi.signals.bias === 'BUY'  && direction === 'LONG')  score += 0.10;
    if (fxssi.signals.bias === 'SELL' && direction === 'SHORT') score += 0.10;
    if (fxssi.signals.bias === 'BUY'  && direction === 'SHORT') score -= 0.10;
    if (fxssi.signals.bias === 'SELL' && direction === 'LONG')  score -= 0.10;
  }

  return Math.max(0, Math.min(1, score));
}

function scoreOrderBook(data, direction) {
  if (!direction) return 0.4;

  let score = 0.4;
  let fxssi = null;
  try {
    const raw = data.fxssi_analysis || data.raw_payload;
    if (raw) {
      const parsed = JSON.parse(raw);
      fxssi = parsed.fxssiAnalysis
        ? (typeof parsed.fxssiAnalysis === 'string' ? JSON.parse(parsed.fxssiAnalysis) : parsed.fxssiAnalysis)
        : (parsed.longPct != null ? parsed : null);
    }
  } catch(e) {}

  const cp = data.close || 0;

  if (data.ob_absorption && direction === 'LONG')  score += 0.20;
  if (data.ob_absorption && direction === 'SHORT') score += 0.05;

  const imbalance = data.ob_imbalance || 0;
  if (direction === 'LONG'  && imbalance > 0.3)  score += 0.15;
  if (direction === 'SHORT' && imbalance < -0.3) score += 0.15;

  if (!fxssi) return Math.min(1.0, score);

  // Winning cluster reversal risk
  if (fxssi.winningClusters?.length > 0) {
    const winsAbove = fxssi.winningClusters.filter(c => c.price > cp);
    const winsBelow = fxssi.winningClusters.filter(c => c.price < cp);
    if (direction === 'LONG'  && winsAbove.length > 0) score -= 0.15;
    if (direction === 'SHORT' && winsBelow.length > 0) score -= 0.15;
  }

  // Losing cluster trampoline
  if (fxssi.losingClusters?.length > 0) {
    const losersAbove = fxssi.losingClusters.filter(c => c.price > cp);
    const losersBelow = fxssi.losingClusters.filter(c => c.price < cp);
    if (direction === 'LONG'  && losersBelow.length > 0) score += 0.12;
    if (direction === 'SHORT' && losersAbove.length > 0) score += 0.12;
  }

  // Middle of volume
  if (fxssi.middleOfVolume && cp) {
    if (direction === 'SHORT' && cp > fxssi.middleOfVolume) score += 0.10;
    if (direction === 'LONG'  && cp < fxssi.middleOfVolume) score += 0.10;
  }

  // Limit wall quality
  if (fxssi.nearestLimitAbove && direction === 'SHORT') {
    const slAlsoAbove = fxssi.nearestSLAbove &&
      Math.abs(fxssi.nearestLimitAbove.price - fxssi.nearestSLAbove.price) < cp * 0.005;
    if (!slAlsoAbove) score += 0.10;
  }
  if (fxssi.nearestLimitBelow && direction === 'LONG') {
    const slAlsoBelow = fxssi.nearestSLBelow &&
      Math.abs(fxssi.nearestLimitBelow.price - fxssi.nearestSLBelow.price) < cp * 0.005;
    if (!slAlsoBelow) score += 0.10;
  }

  // SL cluster as TP target
  if (direction === 'SHORT' && fxssi.nearestSLBelow?.price) score += 0.10;
  if (direction === 'LONG'  && fxssi.nearestSLAbove?.price) score += 0.10;

  // Overbought/oversold
  if (direction === 'SHORT' && fxssi.overbought?.price && fxssi.overbought.price >= cp * 0.998) score += 0.08;
  if (direction === 'LONG'  && fxssi.oversold?.price  && fxssi.oversold.price  <= cp * 1.002) score += 0.08;

  return Math.max(0, Math.min(1.0, score));
}

function scoreSession(symbol) {
  return sessionMultiplier(symbol);
}

function inferDirection(data) {
  if (!data) return null;
  const bias = data.bias || 0;
  if (bias > 0) return 'LONG';
  if (bias < 0) return 'SHORT';
  if (data.structure === 'bullish') return 'LONG';
  if (data.structure === 'bearish') return 'SHORT';
  return null;
}

function calcRR(entry, sl, tp, direction) {
  if (!entry || !sl || !tp) return null;
  const risk   = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return null;
  return Math.round((reward / risk) * 10) / 10;
}

function estimateATR(data, assetClass) {
  try {
    if (data.raw_payload) {
      const raw = JSON.parse(data.raw_payload);
      const atr = raw.atr;
      if (atr) return atr['1h'] || atr['4h'] || atr['15m'] || atr['5m'] || null;
    }
  } catch(e) {}
  const range = (data.high || 0) - (data.low || 0);
  if (range > 0) return range;
  const fallbacks = { commodity: 2.5, crypto: 300, index: 15 };
  return fallbacks[assetClass] || 5;
}

const FXSSI_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

function scoreSymbol(symbol) {
  let data;
  try { data = getLatestMarketData(symbol); } catch(e) { return null; }
  if (!data) return null;

  const cfg = SYMBOLS[symbol];
  if (!cfg) return null;

  // ── FXSSI staleness gate ───────────────────────────────────────────────────
  // Reject scoring if FXSSI data is older than 30 minutes — stale order book
  // produces misleading signals, especially after Railway restarts
  const fxssiAge = data.ts ? (Date.now() - data.ts) : Infinity;
  const hasFxssi = data.fxssi_long_pct != null;
  if (hasFxssi && fxssiAge > FXSSI_MAX_AGE_MS) {
    const ageMin = Math.round(fxssiAge / 60000);
    console.log(`[Scorer] ${symbol} — FXSSI data stale (${ageMin}m old), scoring without order book`);
    // Nullify FXSSI fields so scoreFXSSI and scoreOrderBook fall back to neutral
    data = { ...data,
      fxssi_long_pct: null, fxssi_short_pct: null,
      fxssi_trapped: null, ob_absorption: 0,
      ob_imbalance: 0, ob_large_orders: 0,
      fxssi_analysis: null
    };
  }

  const w = getWeights(symbol);
  const weights = w ? {
    pineBias:       w.pine_bias,
    fxssiSentiment: w.fxssi_sentiment,
    orderBook:      w.order_book,
    sessionQuality: w.session_quality
  } : cfg.scoringWeights;

  const minScore  = w ? w.min_score_proceed : cfg.minScoreProceed;
  const direction = inferDirection(data);
  if (!direction) return null;

  // Sanitise corrupted ob_imbalance
  if (data.ob_imbalance && typeof data.ob_imbalance === 'string' && data.ob_imbalance.startsWith('{')) {
    data.ob_imbalance = 0;
  }

  const biasSc    = scoreBias(data);
  const fxssiSc   = scoreFXSSI(data, direction);
  const obSc      = scoreOrderBook(data, direction);
  const sessionSc = scoreSession(symbol);

  // Conflict multiplier
  let conflictMultiplier = 1.0;
  const pineStrong = biasSc >= 0.65;
  const fxssiSentiment = (() => {
    try {
      const raw = data.fxssi_analysis || data.raw_payload;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const fx = parsed.fxssiAnalysis
        ? (typeof parsed.fxssiAnalysis === 'string' ? JSON.parse(parsed.fxssiAnalysis) : parsed.fxssiAnalysis)
        : (parsed.longPct != null ? parsed : null);
      return fx?.signals?.bias || null;
    } catch(e) { return null; }
  })();

  if (pineStrong && fxssiSentiment) {
    const pineDir = direction === 'LONG' ? 'BUY' : 'SELL';
    const conflict = (pineDir === 'BUY' && fxssiSentiment === 'SELL') ||
                     (pineDir === 'SELL' && fxssiSentiment === 'BUY');
    const agree    = (pineDir === 'BUY' && fxssiSentiment === 'BUY') ||
                     (pineDir === 'SELL' && fxssiSentiment === 'SELL');
    if (conflict) conflictMultiplier = 0.72;
    else if (agree) conflictMultiplier = 1.12;
  }

  const longPct  = data.fxssi_long_pct  || 50;
  const shortPct = data.fxssi_short_pct || 50;
  const crowdWithUs = (direction === 'LONG'  && longPct  >= 60) ||
                      (direction === 'SHORT' && shortPct >= 60);
  if (crowdWithUs) conflictMultiplier *= 0.85;

  // Structure alignment check — Claude learned this from repeated losses
  // Avoid counter-trend signals when Pine structure contradicts direction
  const structure = data.structure || 'ranging';
  const structureConflict =
    (direction === 'SHORT' && structure === 'bullish') ||
    (direction === 'LONG'  && structure === 'bearish');
  const structureAlign =
    (direction === 'SHORT' && structure === 'bearish') ||
    (direction === 'LONG'  && structure === 'bullish');

  if (structureConflict) {
    if (!fxssiSentiment || fxssiSentiment === 'NEUTRAL') {
      conflictMultiplier *= 0.75; // no FXSSI backup = high risk
    } else {
      conflictMultiplier *= 0.88; // FXSSI partially offsets structure conflict
    }
  } else if (structureAlign) {
    conflictMultiplier *= 1.05;
  }

  // RSI momentum filter — Claude learned: RSI > 60 on SHORT or < 40 on LONG = momentum against trade
  const rsi = data.rsi || 50;
  if (direction === 'SHORT' && rsi > 60) {
    const rsiPenalty = rsi > 70 ? 0.80 : 0.90; // extreme RSI = bigger penalty
    conflictMultiplier *= rsiPenalty;
  } else if (direction === 'LONG' && rsi < 40) {
    const rsiPenalty = rsi < 30 ? 0.80 : 0.90;
    conflictMultiplier *= rsiPenalty;
  }
  // RSI confirming direction = small bonus
  if (direction === 'SHORT' && rsi < 45) conflictMultiplier *= 1.05;
  if (direction === 'LONG'  && rsi > 55) conflictMultiplier *= 1.05;

  // ── Macro context alignment ───────────────────────────────────────────────
  // Daily macro fetch (07:00 UTC) provides directional bias per symbol.
  // If macro contradicts signal direction, apply penalty.
  // If macro confirms, apply small bonus.
  let macroNote = '';
  try {
    // getMacroContext is in-process via index.js — access via global if available
    const macroCtx = global.atlasGetMacroContext ? global.atlasGetMacroContext() : null;
    const macro = macroCtx ? macroCtx[symbol] : null;
    if (macro && macro.ts && (Date.now() - macro.ts) < 26 * 3600000) { // use if <26h old
      const macroConflict =
        (direction === 'LONG'  && macro.supports_short && !macro.supports_long) ||
        (direction === 'SHORT' && macro.supports_long  && !macro.supports_short);
      const macroConfirm =
        (direction === 'LONG'  && macro.supports_long  && !macro.supports_short) ||
        (direction === 'SHORT' && macro.supports_short && !macro.supports_long);

      if (macroConflict) {
        const penalty = macro.strength >= 7 ? 0.78 : macro.strength >= 4 ? 0.88 : 0.94;
        conflictMultiplier *= penalty;
        macroNote = `⚠ Macro ${macro.sentiment} conflicts — ${macro.summary}`;
      } else if (macroConfirm) {
        const bonus = macro.strength >= 7 ? 1.08 : 1.04;
        conflictMultiplier *= bonus;
        macroNote = `✓ Macro ${macro.sentiment} confirms — ${macro.summary}`;
      }
    }
  } catch(e) {}

  const rawScore = (
    biasSc   * weights.pineBias +
    fxssiSc  * weights.fxssiSentiment +
    obSc     * weights.orderBook +
    sessionSc * weights.sessionQuality
  ) * 100;

  const score = Math.round(rawScore * conflictMultiplier);

  // ── Regime adjustment ─────────────────────────────────────────────────────
  // Claude's regime detection feeds back into scoring — don't just display it
  let regimeMultiplier = 1.0;
  let regimeNote = '';
  let regimeMinScoreAdj = 0;
  let regimeSlAdj = 1.0; // multiplier applied to SL distance
  try {
    const { getRegime } = require('./claudeLearner');
    const regime = getRegime();
    if (regime && regime.confidence >= 50) {
      switch(regime.regime) {
        case 'TRENDING':
          // Trending = higher edge, lower threshold needed
          regimeMultiplier = 1.08;
          regimeMinScoreAdj = -3;
          regimeNote = `✓ ${regime.regime} regime`;
          break;
        case 'RANGING':
          // Ranging = lower edge, raise threshold, tighten SL
          regimeMultiplier = 0.88;
          regimeMinScoreAdj = +6;
          regimeSlAdj = 0.8; // tighter SL — less room to breathe in chop
          regimeNote = `⚠ RANGING regime — threshold raised`;
          break;
        case 'HIGH_VOLATILITY':
          // High vol = widen SL, raise threshold, reduce score
          regimeMultiplier = 0.92;
          regimeMinScoreAdj = +4;
          regimeSlAdj = 1.5; // wider SL — price swings more
          regimeNote = `⚠ HIGH_VOL regime — SL widened`;
          break;
        case 'NEWS_DRIVEN':
          // News = unpredictable, significant penalty
          regimeMultiplier = 0.82;
          regimeMinScoreAdj = +8;
          regimeNote = `⚠ NEWS_DRIVEN regime — reduced confidence`;
          break;
        case 'LOW_CONVICTION':
          // Low conviction = moderate penalty
          regimeMultiplier = 0.90;
          regimeMinScoreAdj = +5;
          regimeNote = `⚠ LOW_CONVICTION regime`;
          break;
      }
      // Also check if this symbol is in regime's avoid list
      if (regime.avoid_symbols?.includes(symbol)) {
        regimeMultiplier *= 0.75;
        regimeNote += ` · avoid list`;
      }
      // Boost if in best_symbols list
      if (regime.best_symbols?.includes(symbol)) {
        regimeMultiplier *= 1.08;
        regimeNote += ` · best symbol`;
      }
    }
  } catch(e) {}

  const finalScore = Math.round(score * regimeMultiplier);
  const adjustedMinScore = Math.min(88, Math.max(55, minScore + regimeMinScoreAdj));

  const verdict = finalScore >= adjustedMinScore ? 'PROCEED' : finalScore >= Math.max(55, adjustedMinScore - 15) ? 'WATCH' : 'SKIP';
  const reasoning = buildReasoning(symbol, direction, { biasSc, fxssiSc, obSc, sessionSc, data, cfg, regimeNote, macroNote });

  const close = data.close || 0;
  const atr   = estimateATR(data, cfg.assetClass);

  // ── Parse FXSSI levels ────────────────────────────────────────────────────
  let fxssiLevels = null;
  try {
    const rawPayload = data.fxssi_analysis || data.raw_payload;
    if (rawPayload) {
      const parsed = JSON.parse(rawPayload);
      fxssiLevels = parsed.fxssiAnalysis
        ? (typeof parsed.fxssiAnalysis === 'string' ? JSON.parse(parsed.fxssiAnalysis) : parsed.fxssiAnalysis)
        : (parsed.longPct != null ? parsed : null);
    }
  } catch(e) {}

  // ── Entry price — Pine optimal > FXSSI limit wall > FVG mid > close ─────────
  // Pine now sends its own calculated optimal pullback entry level
  // Cross-reference with FXSSI limit wall and pick the level closest to close
  let entry = close;
  let entrySource = 'price';

  // First check Pine's optimal entry suggestion
  let pineOptimalEntry = null;
  try {
    if (data.raw_payload) {
      const raw4 = JSON.parse(data.raw_payload);
      const pe = raw4.entry;
      if (pe) {
        pineOptimalEntry = direction === 'LONG' ? pe.longOptimal : pe.shortOptimal;
        if (pineOptimalEntry) entrySource = `pine_${direction === 'LONG' ? pe.longSource : pe.shortSource}`;
      }
    }
  } catch(e) {}

  if (fxssiLevels && close > 0) {
    if (direction === 'SHORT' && fxssiLevels.nearestLimitAbove?.price) {
      const wall    = fxssiLevels.nearestLimitAbove.price;
      const wallVol = fxssiLevels.nearestLimitAbove.ol || 1.0;
      const dist    = wall - close;
      if (dist > 0 && dist < atr * 2) {
        const bufferPct = wallVol >= 2.0 ? 0.0005 : wallVol >= 1.0 ? 0.001 : 0.002;
        const fxssiEntry = Math.round((wall - wall * bufferPct) * 10000) / 10000;
        // Pick the better entry: FXSSI wall vs Pine optimal (closer to close = better fill)
        if (pineOptimalEntry && pineOptimalEntry > close && Math.abs(pineOptimalEntry - close) < Math.abs(fxssiEntry - close)) {
          entry = pineOptimalEntry;
          entrySource = `pine_fvg_vs_wall`;
        } else {
          entry = fxssiEntry;
          entrySource = `limit_wall_vol${wallVol.toFixed(1)}`;
        }
      }
    } else if (direction === 'LONG' && fxssiLevels.nearestLimitBelow?.price) {
      const wall    = fxssiLevels.nearestLimitBelow.price;
      const wallVol = fxssiLevels.nearestLimitBelow.ol || 1.0;
      const dist    = close - wall;
      if (dist > 0 && dist < atr * 2) {
        const bufferPct = wallVol >= 2.0 ? 0.0005 : wallVol >= 1.0 ? 0.001 : 0.002;
        const fxssiEntry = Math.round((wall + wall * bufferPct) * 10000) / 10000;
        if (pineOptimalEntry && pineOptimalEntry < close && Math.abs(pineOptimalEntry - close) < Math.abs(fxssiEntry - close)) {
          entry = pineOptimalEntry;
          entrySource = `pine_fvg_vs_wall`;
        } else {
          entry = fxssiEntry;
          entrySource = `limit_wall_vol${wallVol.toFixed(1)}`;
        }
      }
    }
  }

  // Fallback: use Pine optimal if no FXSSI wall found
  if (entry === close && pineOptimalEntry && pineOptimalEntry !== close) {
    entry = Math.round(pineOptimalEntry * 10000) / 10000;
  }
  // Final fallback: FVG mid
  if (entry === close && data.fvg_mid && data.fvg_mid > 0) {
    entry = Math.round(data.fvg_mid * 10000) / 10000;
    entrySource = 'fvg_mid';
  }

  // ── SL/TP from order book ─────────────────────────────────────────────────
  // SL: place beyond the NEXT level after the nearest cluster — not just 0.3 ATR past it.
  //     This avoids getting stopped during a cluster sweep before the real move.
  // TP: check for winning clusters between price and target — if one blocks >40%
  //     of the move, set TP just before it instead of running into reversal risk.
  let sl, tp;
  if (fxssiLevels && close > 0) {
    const atrSl = atr * 1.5 * regimeSlAdj; // regime widens/tightens SL

    if (direction === 'LONG') {
      // ── TP: liquidity void above > SL cluster above ───────────────────────
      let voidAbove = null;
      try {
        const raw5 = JSON.parse(data.raw_payload || '{}');
        if (raw5.liquidity?.voidAbove && raw5.liquidity.voidAbove > close) {
          voidAbove = raw5.liquidity.voidAbove;
        }
      } catch(e) {}

      const tpTarget = voidAbove || fxssiLevels.nearestSLAbove?.price || fxssiLevels.gravity?.price;

      // Only use tpTarget if it's actually above close (gravity can be below)
      const validTpTarget = tpTarget && tpTarget > close && (tpTarget - close) > atr * 0.5;

      if (validTpTarget) {
        // Find winning clusters strictly between close and tpTarget
        const winningObstacles = (fxssiLevels.winningClusters || [])
          .filter(c => c.price > close && c.price < tpTarget)
          .sort((a, b) => a.price - b.price);

        if (winningObstacles.length > 0) {
          const obstacle    = winningObstacles[0];
          const moveToTarget = tpTarget - close;
          const moveToBlock  = obstacle.price - close;
          const blockPct     = moveToBlock / moveToTarget;

          if (blockPct < 0.25) {
            // Obstacle within 25% of move — very close to entry, use ATR fallback
            tp = Math.round((close + atr * 3.0) * 10000) / 10000;
          } else {
            // Trim TP to just before obstacle
            const trimmedTp = Math.round((obstacle.price - atr * 0.2) * 10000) / 10000;
            // Only accept trim if it still gives R:R >= 1.8 vs our SL estimate
            const estimatedSlDist = atr * 1.5;
            const trimmedRR = (trimmedTp - close) / estimatedSlDist;
            tp = trimmedRR >= 1.8 ? trimmedTp : Math.round(tpTarget * 10000) / 10000;
          }
        } else {
          tp = Math.round(tpTarget * 10000) / 10000;
        }
      } else {
        tp = Math.round((close + atr * 3.0) * 10000) / 10000;
      }

      // ── SL: find the next level BEYOND the nearest losing cluster ────────────
      const losingClustersBelow = (fxssiLevels.losingClusters || [])
        .filter(c => c.price < close)
        .sort((a, b) => b.price - a.price); // nearest first

      if (losingClustersBelow.length >= 2) {
        const nearCluster = losingClustersBelow[0];
        const farCluster  = losingClustersBelow[1];
        const gap         = nearCluster.price - farCluster.price;
        sl = Math.round((nearCluster.price - gap * 0.5) * 10000) / 10000;
      } else if (losingClustersBelow.length === 1) {
        const cluster = losingClustersBelow[0];
        sl = cluster.price > close - atrSl * 2
          ? Math.round((cluster.price - atr * 0.3) * 10000) / 10000
          : Math.round((close - atrSl) * 10000) / 10000;
      } else {
        const limitBelow = fxssiLevels.nearestLimitBelow?.price;
        sl = (limitBelow && limitBelow > close - atrSl * 2)
          ? Math.round((limitBelow - atr * 0.5) * 10000) / 10000
          : Math.round((close - atrSl) * 10000) / 10000;
      }

      // Final safety — sl must be below close, tp must be above close
      if (!sl || sl >= close) sl = Math.round((close - atrSl) * 10000) / 10000;
      if (!tp || tp <= close) tp = Math.round((close + atr * 3.0) * 10000) / 10000;

    } else { // SHORT
      // ── TP: liquidity void below > SL cluster below ───────────────────────
      let voidBelow = null;
      try {
        const raw5 = JSON.parse(data.raw_payload || '{}');
        if (raw5.liquidity?.voidBelow && raw5.liquidity.voidBelow < close) {
          voidBelow = raw5.liquidity.voidBelow;
        }
      } catch(e) {}

      const tpTarget = voidBelow || fxssiLevels.nearestSLBelow?.price || fxssiLevels.gravity?.price;

      // Only use tpTarget if it's actually below close
      const validTpTarget = tpTarget && tpTarget < close && (close - tpTarget) > atr * 0.5;

      if (validTpTarget) {
        const winningObstacles = (fxssiLevels.winningClusters || [])
          .filter(c => c.price < close && c.price > tpTarget)
          .sort((a, b) => b.price - a.price);

        if (winningObstacles.length > 0) {
          const obstacle     = winningObstacles[0];
          const moveToTarget = close - tpTarget;
          const moveToBlock  = close - obstacle.price;
          const blockPct     = moveToBlock / moveToTarget;

          if (blockPct < 0.25) {
            tp = Math.round((close - atr * 3.0) * 10000) / 10000;
          } else {
            const trimmedTp = Math.round((obstacle.price + atr * 0.2) * 10000) / 10000;
            const estimatedSlDist = atr * 1.5;
            const trimmedRR = (close - trimmedTp) / estimatedSlDist;
            tp = trimmedRR >= 1.8 ? trimmedTp : Math.round(tpTarget * 10000) / 10000;
          }
        } else {
          tp = Math.round(tpTarget * 10000) / 10000;
        }
      } else {
        tp = Math.round((close - atr * 3.0) * 10000) / 10000;
      }

      // ── SL: find the next level BEYOND the nearest losing cluster ────────────
      const losingClustersAbove = (fxssiLevels.losingClusters || [])
        .filter(c => c.price > close)
        .sort((a, b) => a.price - b.price); // nearest first

      if (losingClustersAbove.length >= 2) {
        const nearCluster = losingClustersAbove[0];
        const farCluster  = losingClustersAbove[1];
        const gap         = farCluster.price - nearCluster.price;
        sl = Math.round((nearCluster.price + gap * 0.5) * 10000) / 10000;
      } else if (losingClustersAbove.length === 1) {
        const cluster = losingClustersAbove[0];
        sl = cluster.price < close + atrSl * 2
          ? Math.round((cluster.price + atr * 0.3) * 10000) / 10000
          : Math.round((close + atrSl) * 10000) / 10000;
      } else {
        const limitAbove = fxssiLevels.nearestLimitAbove?.price;
        sl = (limitAbove && limitAbove < close + atrSl * 2)
          ? Math.round((limitAbove + atr * 0.5) * 10000) / 10000
          : Math.round((close + atrSl) * 10000) / 10000;
      }

      // Final safety — sl must be above close, tp must be below close
      if (!sl || sl <= close) sl = Math.round((close + atrSl) * 10000) / 10000;
      if (!tp || tp >= close) tp = Math.round((close - atr * 3.0) * 10000) / 10000;
    }
  } else {
    // No FXSSI levels — pure ATR fallback
    const atrSl = atr * 1.5 * regimeSlAdj;
    if (direction === 'LONG') {
      sl = Math.round((close - atrSl) * 10000) / 10000;
      tp = Math.round((close + atr * 3.0) * 10000) / 10000;
    } else {
      sl = Math.round((close + atrSl) * 10000) / 10000;
      tp = Math.round((close - atr * 3.0) * 10000) / 10000;
    }
  }

  let rr = calcRR(entry, sl, tp, direction);

  // ── R:R sanity check with Claude multipliers ──────────────────────────────
  let claudeOpt = null;
  try {
    const { getEntryOptimisation } = require('./claudeLearner');
    claudeOpt = getEntryOptimisation(symbol);
  } catch(e) {}

  const rrMin = claudeOpt?.ideal_rr_min || 1.5;
  const rrMax = claudeOpt?.ideal_rr_max || 4.0;

  if (!rr || rr < rrMin || rr > rrMax) {
    const slMult = claudeOpt?.sl_multiplier || 1.5;
    const tpMult = claudeOpt?.tp_multiplier || 3.0;
    if (direction === 'LONG') {
      sl = Math.round((entry - atr * slMult) * 10000) / 10000;
      tp = Math.round((entry + atr * tpMult) * 10000) / 10000;
    } else {
      sl = Math.round((entry + atr * slMult) * 10000) / 10000;
      tp = Math.round((entry - atr * tpMult) * 10000) / 10000;
    }
    rr = calcRR(entry, sl, tp, direction);
  }

  // Apply entry bias from Claude optimisation
  if (claudeOpt?.entry_bias && Math.abs(claudeOpt.entry_bias) > 0.05) {
    entry = Math.round((entry + atr * claudeOpt.entry_bias) * 10000) / 10000;
  }

  // Claude exact levels are calculated on-demand via ANALYSE button in dashboard
  // Not fired here to avoid API costs — user triggers manually when needed

  const fxssiStale = hasFxssi && fxssiAge > FXSSI_MAX_AGE_MS;
  const finalReasoning = fxssiStale
    ? `⚠ FXSSI stale (${Math.round(fxssiAge/60000)}m) — OB scoring neutral · ` + reasoning
    : reasoning;

  return {
    symbol, label: cfg.label, direction, score: finalScore, verdict,
    entry: Math.round(entry * 100) / 100,
    sl, tp, rr,
    session: getSessionNow(),
    breakdown: { bias: biasSc, fxssi: fxssiSc, ob: obSc, session: sessionSc },
    reasoning: finalReasoning,
    entrySource: entrySource || 'price',
    fxssiStale: fxssiStale || false,
    regimeAdj: regimeMultiplier !== 1.0 ? { multiplier: regimeMultiplier, note: regimeNote } : null,
    ts: Date.now()
  };
}

function buildReasoning(symbol, direction, { biasSc, fxssiSc, obSc, sessionSc, data, cfg, regimeNote, macroNote }) {
  const parts = [];
  if (biasSc > 0.7) parts.push(`Strong ${direction} structure on Pine (${Math.round(biasSc * 100)}%)`);
  else if (biasSc > 0.4) parts.push(`Moderate ${direction} bias`);
  else parts.push(`Weak bias — treat with caution`);

  // Momentum score from v2 Pine
  try {
    const raw = data.raw_payload;
    if (raw) {
      const parsed = JSON.parse(raw);
      const mom = parsed.momScore;
      if (mom != null && !isNaN(mom)) {
        if      (mom >= 80) parts.push(`Momentum ${mom}% — strong acceleration`);
        else if (mom >= 60) parts.push(`Momentum ${mom}% — confirming`);
        else if (mom >= 30) parts.push(`Momentum ${mom}% — moderate`);
        else                parts.push(`⚠ Momentum ${mom}% — weak, bias unconfirmed`);
      }
      // Confluence count
      const cc = parsed.confluenceCount;
      if (cc != null && !isNaN(cc)) {
        if      (cc >= 5) parts.push(`✓ Confluence ${cc}/6 — maximum alignment`);
        else if (cc >= 4) parts.push(`✓ Confluence ${cc}/6 — high conviction`);
        else if (cc >= 3) parts.push(`Confluence ${cc}/6 — moderate`);
        else              parts.push(`⚠ Confluence ${cc}/6 — weak, sources disagree`);
      }
      // Opening range
      if (parsed.isOpeningRange === true || parsed.isOpeningRange === 'true') {
        parts.push(`⚠ Opening range — wider spreads, stronger momentum`);
      }
    }
  } catch(e) {}

  const longPct  = data.fxssi_long_pct || 50;
  const shortPct = data.fxssi_short_pct || 50;
  if (fxssiSc > 0.7) parts.push(`Crowd trapped (${direction === 'LONG' ? shortPct + '% short' : longPct + '% long'}) — contrarian favour`);
  else if (fxssiSc < 0.35) parts.push(`Crowd aligned with trade — stop hunt risk`);

  if (data.ob_absorption) parts.push(`Order book absorption detected at level`);
  if (data.fvg_present)   parts.push(`FVG present — entry zone active`);
  try {
    const raw = data.fxssi_analysis || data.raw_payload;
    if (raw) {
      const parsed = JSON.parse(raw);
      const fx = parsed.fxssiAnalysis
        ? (typeof parsed.fxssiAnalysis === 'string' ? JSON.parse(parsed.fxssiAnalysis) : parsed.fxssiAnalysis)
        : (parsed.longPct != null ? parsed : null);
      if (fx) {
        const cp = data.close || 0;

        // Wall volume quality
        const wall = direction === 'SHORT' ? fx.nearestLimitAbove : fx.nearestLimitBelow;
        if (wall?.ol) {
          if (wall.ol >= 2.0)      parts.push(`Strong limit wall (vol ${wall.ol.toFixed(1)}) — tight entry buffer`);
          else if (wall.ol >= 1.0) parts.push(`Moderate limit wall (vol ${wall.ol.toFixed(1)}) — standard buffer`);
          else                      parts.push(`⚠ Thin limit wall (vol ${wall.ol.toFixed(1)}) — wide buffer, may break`);
        }

        // Winning cluster obstruction between price and TP
        const tpTarget = direction === 'LONG' ? fx.nearestSLAbove?.price : fx.nearestSLBelow?.price;
        if (tpTarget) {
          const obstacles = (fx.winningClusters || []).filter(c =>
            direction === 'LONG'
              ? c.price > cp && c.price < tpTarget
              : c.price < cp && c.price > tpTarget
          );
          if (obstacles.length > 0) {
            const nearest = obstacles.sort((a,b) =>
              direction === 'LONG' ? a.price - b.price : b.price - a.price
            )[0];
            const movePct = tpTarget
              ? Math.round(Math.abs(nearest.price - cp) / Math.abs(tpTarget - cp) * 100)
              : 0;
            parts.push(`⚠ Winning cluster at ${nearest.price} blocks ${movePct}% of TP move — TP adjusted`);
          }
        }

        // Multi-cluster SL quality
        const clusters = direction === 'LONG'
          ? (fx.losingClusters || []).filter(c => c.price < cp).sort((a,b) => b.price - a.price)
          : (fx.losingClusters || []).filter(c => c.price > cp).sort((a,b) => a.price - b.price);
        if (clusters.length >= 2) parts.push(`SL placed between clusters — sweep zone cleared`);

        // Gravity, trapped traders, volume midpoint
        if (fx.gravity?.price) parts.push(`SL gravity at ${fx.gravity.price} — price magnet`);
        if (fx.losingClusters?.some(c => direction === 'SHORT' ? c.price > cp : c.price < cp))
          parts.push(`Trapped ${direction === 'SHORT' ? 'buyers' : 'sellers'} — trampoline fuel`);
        if (fx.middleOfVolume) {
          const side = direction === 'SHORT' ? cp > fx.middleOfVolume : cp < fx.middleOfVolume;
          if (side) parts.push(`Price ${direction === 'SHORT' ? 'above' : 'below'} volume midpoint — overextension confirmed`);
        }
      }
    }
  } catch(e) {}

  try {
    const raw2 = data.fxssi_analysis || data.raw_payload;
    if (raw2) {
      const parsed2 = JSON.parse(raw2);
      const fx2 = parsed2.fxssiAnalysis
        ? (typeof parsed2.fxssiAnalysis === 'string' ? JSON.parse(parsed2.fxssiAnalysis) : parsed2.fxssiAnalysis)
        : (parsed2.longPct != null ? parsed2 : null);
      if (fx2?.signals?.bias) {
        const pineDir = direction === 'LONG' ? 'BUY' : 'SELL';
        if (fx2.signals.bias === pineDir) parts.push(`✓ Pine + FXSSI aligned — high conviction`);
        else if (fx2.signals.bias !== 'NEUTRAL') parts.push(`⚠ Pine/FXSSI conflict — score penalised`);
      }
    }
  } catch(e) {}

  // RSI momentum warning
  const rsiVal = data.rsi || 50;
  if (direction === 'SHORT' && rsiVal > 70) parts.push(`⚠ RSI ${Math.round(rsiVal)} — strong momentum against SHORT`);
  else if (direction === 'SHORT' && rsiVal > 60) parts.push(`⚠ RSI ${Math.round(rsiVal)} — momentum against SHORT`);
  else if (direction === 'LONG' && rsiVal < 30) parts.push(`⚠ RSI ${Math.round(rsiVal)} — strong momentum against LONG`);
  else if (direction === 'LONG' && rsiVal < 40) parts.push(`⚠ RSI ${Math.round(rsiVal)} — momentum against LONG`);
  else if (direction === 'SHORT' && rsiVal < 45) parts.push(`RSI ${Math.round(rsiVal)} — momentum confirms SHORT`);
  else if (direction === 'LONG'  && rsiVal > 55) parts.push(`RSI ${Math.round(rsiVal)} — momentum confirms LONG`);

  // Structure alignment
  const struct = data.structure || 'ranging';
  if ((direction === 'SHORT' && struct === 'bullish') ||
      (direction === 'LONG'  && struct === 'bearish')) {
    parts.push(`⚠ Counter-trend — structure is ${struct}`);
  } else if (struct !== 'ranging') {
    parts.push(`✓ Structure aligned (${struct})`);
  }

  const session = getSessionNow();
  if (session === cfg.peakSession) parts.push(`Peak session (${session}) — optimal timing`);
  else if (session === 'offHours') parts.push(`Off-hours — reduced reliability`);

  if (regimeNote) parts.push(regimeNote);
  if (macroNote)  parts.push(macroNote);

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
        results.push({
          symbol, label: SYMBOLS[symbol].label,
          direction: null, score: 0, verdict: 'CLOSED',
          session: 'closed', reasoning: 'Market closed', ts: Date.now()
        });
        continue;
      }
      const result = scoreSymbol(symbol);
      if (result) {
        results.push(result);
      } else {
        results.push({
          symbol, label: SYMBOLS[symbol]?.label || symbol,
          direction: null, score: 0, verdict: 'SKIP',
          session: require('./config').getSessionNow(),
          reasoning: 'No data yet or insufficient bias signal',
          ts: Date.now()
        });
      }
    } catch(e) {
      console.error(`[Scorer] ${symbol} error:`, e.message, e.stack?.split('\n')[1]);
      results.push({
        symbol, label: SYMBOLS[symbol]?.label || symbol,
        verdict: 'SKIP', score: 0, direction: null,
        reasoning: `Error: ${e.message}`, ts: Date.now()
      });
    }
  }
  return results.sort((a, b) => {
    if (a.verdict === 'CLOSED' && b.verdict !== 'CLOSED') return 1;
    if (b.verdict === 'CLOSED' && a.verdict !== 'CLOSED') return -1;
    return (b.score || 0) - (a.score || 0);
  });
}

function isBetterSignal(existing, candidate) {
  const betterRR = (candidate.rr || 0) > (existing.rr || 0);
  const existingSlDist = Math.abs((existing.sl || 0) - (existing.entry || 0));
  const candidateSlDist = Math.abs((candidate.sl || 0) - (candidate.entry || 0));
  const tighterSL = candidateSlDist < existingSlDist * 0.98;
  const existingTpDist = Math.abs((existing.tp || 0) - (existing.entry || 0));
  const candidateTpDist = Math.abs((candidate.tp || 0) - (candidate.entry || 0));
  const higherTP = candidateTpDist > existingTpDist * 1.02;
  return betterRR || tighterSL || higherTP;
}

function entryTouched(signal, currentPrice) {
  if (!currentPrice || !signal.entry) return false;
  const entry    = signal.entry;
  const tolerance = entry * 0.0015;
  if (signal.direction === 'LONG')  return currentPrice <= entry + tolerance;
  if (signal.direction === 'SHORT') return currentPrice >= entry - tolerance;
  return false;
}

function saveSignal(scored) {
  if (scored.verdict !== 'PROCEED' && scored.verdict !== 'WATCH') return null;

  let last = null;
  try {
    const { getLatestOpenSignal, updateOutcome } = require('./db');
    last = getLatestOpenSignal(scored.symbol, scored.direction);
  } catch(e) {
    console.error('[Scorer] dedup lookup error:', e.message);
  }

  if (last) {
    const { getLatestMarketData, updateOutcome } = require('./db');
    const marketData = getLatestMarketData(scored.symbol);
    const currentPrice = marketData ? marketData.close : null;

    if (entryTouched(last, currentPrice)) {
      console.log(`[Scorer] ${scored.symbol} entry touched — keeping original signal`);
      return null;
    }

    if (isBetterSignal(last, scored)) {
      const newId = insertSignal(scored);
      if (newId) {
        updateOutcome(last.id, 'REPLACED', 0);
        console.log(`[Scorer] ${scored.symbol} ${scored.direction} — refined (RR:${last.rr}→${scored.rr})`);
        return newId;
      }
    }

    console.log(`[Scorer] ${scored.symbol} ${scored.direction} — keeping existing signal`);
    return null;
  }

  return insertSignal(scored);
}

module.exports = { scoreSymbol, scoreAllPriority, saveSignal };
