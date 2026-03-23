const { SYMBOLS, getSessionNow, sessionMultiplier } = require('./config');
const { getLatestMarketData, getWeights, insertSignal } = require('./db');

function scoreBias(data) {
  // v2: bias score is now -8 to +8 (emaScore 5TF + vwapDir + rsi×2 + macd + struct4h)
  // v1: bias was -3 to +3
  const raw = Math.abs(data.bias || 0);
  const maxBias = raw > 3 ? 8 : 3; // detect v1 vs v2 payload
  const fvgBonus = data.fvg_present ? 0.10 : 0;

  // VWAP overextension from raw_payload — price beyond 2σ = strong confirmation
  let vwapBonus = 0;
  try {
    if (data.raw_payload) {
      const raw2 = JSON.parse(data.raw_payload);
      const vwap = raw2.vwap;
      if (vwap) {
        // aboveUpper2 = overbought = confirms SHORT
        // belowLower2 = oversold = confirms LONG
        if (vwap.aboveUpper2 || vwap.belowLower2) vwapBonus = 0.10;
      }
    }
  } catch(e) {}

  return Math.min(1.0, (raw / maxBias) + fvgBonus + vwapBonus);
}

function scoreFXSSI(data, direction) {
  if (!direction) return 0.5;

  const longPct  = data.fxssi_long_pct  || 50;
  const shortPct = data.fxssi_short_pct || 50;
  const trapped  = data.fxssi_trapped;

  // Parse full FXSSI analysis if available
  let fxssi = null;
  try {
    if (data.fxssiAnalysis) fxssi = JSON.parse(data.fxssiAnalysis);
    else if (data.raw_payload) {
      const raw = JSON.parse(data.raw_payload);
      if (raw.fxssiAnalysis) fxssi = JSON.parse(raw.fxssiAnalysis);
    }
  } catch(e) {}

  let score = 0.5; // baseline

  // ── 1. CONTRARIAN CROWD POSITION (most important) ────────────────────────
  // Crowd trapped on wrong side = high probability move against them
  if (direction === 'LONG') {
    if (shortPct >= 70) score += 0.30;       // crowd heavily short = rocket launch
    else if (shortPct >= 60) score += 0.20;
    else if (longPct >= 65) score -= 0.20;   // crowd already long = dangerous
    else if (longPct >= 70) score -= 0.30;
  } else { // SHORT
    if (longPct >= 70) score += 0.30;        // crowd heavily long = rocket launch
    else if (longPct >= 60) score += 0.20;
    else if (shortPct >= 65) score -= 0.20;  // crowd already short = dangerous
    else if (shortPct >= 70) score -= 0.30;
  }

  // ── 2. IN PROFIT RATIO — reversal risk ───────────────────────────────────
  // High inProfit% = move too obvious = reversal near (negative signal)
  if (fxssi) {
    const inProfit = fxssi.inProfitPct || 50;
    if (inProfit > 65) score -= 0.15; // too many winners = reversal imminent
    if (inProfit < 35) score += 0.10; // mostly losers = move has legs
  }

  // ── 3. SL CLUSTER IN DIRECTION = gravity target ───────────────────────────
  // Price hunts SL clusters — if cluster is in our direction, adds confluence
  if (fxssi && data.close) {
    const cp = data.close;
    if (direction === 'LONG' && fxssi.nearestSLAbove?.price) {
      score += 0.10; // SL cluster above = price wants to go there = bullish
    }
    if (direction === 'SHORT' && fxssi.nearestSLBelow?.price) {
      score += 0.10; // SL cluster below = price wants to go there = bearish
    }
    // Losing cluster trampoline in our direction
    if (direction === 'LONG' && fxssi.losingClusters?.some(l => l.price < cp)) {
      score += 0.08; // losing sellers below = fuel for bounce
    }
    if (direction === 'SHORT' && fxssi.losingClusters?.some(l => l.price > cp)) {
      score += 0.08; // losing buyers above = fuel for drop
    }
    // Limit wall blocking our direction = negative
    if (direction === 'LONG'  && fxssi.nearestLimitAbove?.price) score -= 0.08;
    if (direction === 'SHORT' && fxssi.nearestLimitBelow?.price) score -= 0.08;
  }

  // ── 4. ABSORPTION ─────────────────────────────────────────────────────────
  if (data.ob_absorption && direction === 'LONG') score += 0.10;

  // ── 5. SIGNAL BIAS from FXSSI composite ──────────────────────────────────
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

  // ── 1. ABSORPTION (orange limit orders absorbing near price) ─────────────
  // Only meaningful for LONG — limit orders below absorbing sell pressure
  if (data.ob_absorption && direction === 'LONG') score += 0.20;
  if (data.ob_absorption && direction === 'SHORT') score += 0.05; // minor for short

  // ── 2. IMBALANCE at current price zone ───────────────────────────────────
  const imbalance = data.ob_imbalance || 0;
  if (direction === 'LONG'  && imbalance > 0.3)  score += 0.15;
  if (direction === 'SHORT' && imbalance < -0.3) score += 0.15;

  if (!fxssi) return Math.min(1.0, score);

  // ── 3. WINNING CLUSTER = reversal risk (Part 2 signal #4) ────────────────
  // Large winning positions = price came too far = they'll close = push back
  // If winning cluster is on OUR side = they'll close AGAINST us = negative
  if (fxssi.winningClusters?.length > 0) {
    const winsAbove = fxssi.winningClusters.filter(c => c.price > cp);
    const winsBelow = fxssi.winningClusters.filter(c => c.price < cp);
    if (direction === 'LONG'  && winsAbove.length > 0) score -= 0.15; // winners above = resistance
    if (direction === 'SHORT' && winsBelow.length > 0) score -= 0.15; // winners below = support
  }

  // ── 4. LOSING CLUSTER TRAMPOLINE (Part 2 signal #3) ──────────────────────
  // Losing positions = trapped traders = fuel for move in opposite direction
  // Losing shorts below price = fuel for bounce up = bullish for LONG
  // Losing longs above price = fuel for drop = bullish for SHORT
  if (fxssi.losingClusters?.length > 0) {
    const losersAbove = fxssi.losingClusters.filter(c => c.price > cp);
    const losersBelow = fxssi.losingClusters.filter(c => c.price < cp);
    if (direction === 'LONG'  && losersBelow.length > 0) score += 0.12; // trapped sellers below = spring
    if (direction === 'SHORT' && losersAbove.length > 0) score += 0.12; // trapped buyers above = weight
  }

  // ── 5. MIDDLE OF VOLUME — trend direction indicator ───────────────────────
  // Price above midVol = bearish (overextended), price below = bullish
  if (fxssi.middleOfVolume && cp) {
    if (direction === 'SHORT' && cp > fxssi.middleOfVolume) score += 0.10; // price above mid = fade
    if (direction === 'LONG'  && cp < fxssi.middleOfVolume) score += 0.10; // price below mid = bounce
  }

  // ── 6. LIMIT WALL QUALITY (Part 2 signal #2) ─────────────────────────────
  // True S/R: limit wall with NO stop losses nearby = strong barrier
  // Weak S/R: limit wall WITH stop losses = will likely break through
  if (fxssi.nearestLimitAbove && direction === 'SHORT') {
    // Resistance above — good for short BUT check if SL cluster also there (will break)
    const slAlsoAbove = fxssi.nearestSLAbove &&
      Math.abs(fxssi.nearestLimitAbove.price - fxssi.nearestSLAbove.price) < cp * 0.005;
    if (!slAlsoAbove) score += 0.10; // clean limit wall = true resistance
    // If SL cluster at same level, cancel out — price will break through to hunt SL
  }
  if (fxssi.nearestLimitBelow && direction === 'LONG') {
    const slAlsoBelow = fxssi.nearestSLBelow &&
      Math.abs(fxssi.nearestLimitBelow.price - fxssi.nearestSLBelow.price) < cp * 0.005;
    if (!slAlsoBelow) score += 0.10; // clean limit wall = true support
  }

  // ── 7. SL CLUSTER AS TP TARGET (Part 2 signal #1) ────────────────────────
  // SL cluster in direction = price WILL go there = high probability target
  // This confirms our TP is a realistic target
  if (direction === 'SHORT' && fxssi.nearestSLBelow?.price) score += 0.10;
  if (direction === 'LONG'  && fxssi.nearestSLAbove?.price) score += 0.10;

  // ── 8. OVERBOUGHT/OVERSOLD from winning position zones ────────────────────
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

  // Sanitise corrupted ob_imbalance (old rows may have JSON string)
  if (data.ob_imbalance && typeof data.ob_imbalance === 'string' && data.ob_imbalance.startsWith('{')) {
    data.ob_imbalance = 0;
  }

  const biasSc   = scoreBias(data);
  const fxssiSc  = scoreFXSSI(data, direction);
  const obSc     = scoreOrderBook(data, direction);
  const sessionSc = scoreSession(symbol);

  // ── Conflict multiplier ───────────────────────────────────────────────────
  // When Pine and FXSSI contradict each other, penalise the total score.
  // Agreement amplifies; contradiction suppresses — they are not merely additive.
  let conflictMultiplier = 1.0;

  // Determine Pine direction strength and FXSSI direction
  const pineStrong  = biasSc >= 0.65;   // Pine has clear view
  const fxssiSentiment = (() => {
    try {
      const raw = data.fxssi_analysis || data.raw_payload;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const fx = parsed.fxssiAnalysis
        ? (typeof parsed.fxssiAnalysis === 'string' ? JSON.parse(parsed.fxssiAnalysis) : parsed.fxssiAnalysis)
        : (parsed.longPct != null ? parsed : null);
      return fx?.signals?.bias || null; // 'BUY', 'SELL', 'NEUTRAL'
    } catch(e) { return null; }
  })();

  if (pineStrong && fxssiSentiment) {
    const pineDir  = direction === 'LONG' ? 'BUY' : 'SELL';
    const conflict = (pineDir === 'BUY'  && fxssiSentiment === 'SELL') ||
                     (pineDir === 'SELL' && fxssiSentiment === 'BUY');
    const agree    = (pineDir === 'BUY'  && fxssiSentiment === 'BUY')  ||
                     (pineDir === 'SELL' && fxssiSentiment === 'SELL');

    if (conflict)          conflictMultiplier = 0.72; // hard conflict — 28% penalty
    else if (agree)        conflictMultiplier = 1.12; // full agreement — 12% bonus
    // NEUTRAL = no adjustment
  }

  // Also check crowd trap vs direction
  const longPct  = data.fxssi_long_pct  || 50;
  const shortPct = data.fxssi_short_pct || 50;
  const crowdWithUs = (direction === 'LONG'  && longPct  >= 60) ||
                      (direction === 'SHORT' && shortPct >= 60);
  if (crowdWithUs) conflictMultiplier *= 0.85; // crowd on same side = danger

  const raw = (
    biasSc   * weights.pineBias +
    fxssiSc  * weights.fxssiSentiment +
    obSc     * weights.orderBook +
    sessionSc * weights.sessionQuality
  ) * 100;

  const score = Math.round(raw * conflictMultiplier);

  let verdict = 'SKIP';
  if (score >= minScore) verdict = 'PROCEED';
  else if (score >= 55) verdict = 'WATCH';

  const close = data.close || 0;
  const atr   = estimateATR(data, cfg.assetClass);

  // ── Entry price from FXSSI limit wall ────────────────────────────────────
  // SHORT: entry just below nearest limit wall above (resistance rejection)
  // LONG:  entry just above nearest limit wall below (support bounce)
  // Fallback: FVG midpoint if sent by Pine, then current price
  let entry = close;

  if (fxssiLevels && close > 0) {
    const buffer = close * 0.001; // 0.1% buffer inside the wall
    if (direction === 'SHORT' && fxssiLevels.nearestLimitAbove?.price) {
      const wall = fxssiLevels.nearestLimitAbove.price;
      const dist = wall - close;
      if (dist > 0 && dist < atr * 2) {
        // Wall is close — enter at wall minus buffer (catch rejection)
        entry = Math.round((wall - buffer) * 10000) / 10000;
      }
    } else if (direction === 'LONG' && fxssiLevels.nearestLimitBelow?.price) {
      const wall = fxssiLevels.nearestLimitBelow.price;
      const dist = close - wall;
      if (dist > 0 && dist < atr * 2) {
        entry = Math.round((wall + buffer) * 10000) / 10000;
      }
    }
  }

  // FVG mid fallback if entry is still current price
  if (entry === close && data.fvg_mid && data.fvg_mid > 0) {
    entry = Math.round(data.fvg_mid * 10000) / 10000;
  }

  let sl, tp;

  // ── Use FXSSI order book levels for SL/TP when available ─────────────────
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

  if (fxssiLevels && close > 0) {
    const cp = close;
    const atrSl = atr * 1.5; // ATR fallback distance

    if (direction === 'LONG') {
      // TP: nearest SL cluster above price (price hunts it) — Part 2 signal #1
      // Fallback to gravity if no SL cluster above
      const tpLevel = fxssiLevels.nearestSLAbove?.price || fxssiLevels.gravity?.price;
      if (tpLevel && tpLevel > cp && (tpLevel - cp) > atr * 0.5) {
        tp = Math.round(tpLevel * 10000) / 10000;
      } else {
        tp = Math.round((cp + atr * 3.0) * 10000) / 10000;
      }

      // SL: just beyond nearest losing cluster below (trampoline — if breaks, move continues)
      // Or nearest limit wall below minus a buffer
      const slClusterBelow = fxssiLevels.losingClusters?.filter(c => c.price < cp)
        .sort((a,b) => b.price - a.price)[0];
      const limitBelow = fxssiLevels.nearestLimitBelow?.price;

      if (slClusterBelow && slClusterBelow.price > cp - atrSl * 2) {
        // SL just below the losing cluster — if cluster breaks, we're out
        sl = Math.round((slClusterBelow.price - atr * 0.3) * 10000) / 10000;
      } else if (limitBelow && limitBelow > cp - atrSl * 2) {
        // SL below support wall
        sl = Math.round((limitBelow - atr * 0.5) * 10000) / 10000;
      } else {
        sl = Math.round((cp - atrSl) * 10000) / 10000;
      }

    } else { // SHORT
      // TP: nearest SL cluster below price (price hunts it)
      const tpLevel = fxssiLevels.nearestSLBelow?.price || fxssiLevels.gravity?.price;
      if (tpLevel && tpLevel < cp && (cp - tpLevel) > atr * 0.5) {
        tp = Math.round(tpLevel * 10000) / 10000;
      } else {
        tp = Math.round((cp - atr * 3.0) * 10000) / 10000;
      }

      // SL: just beyond nearest losing cluster above (if breaks, move continues down)
      const slClusterAbove = fxssiLevels.losingClusters?.filter(c => c.price > cp)
        .sort((a,b) => a.price - b.price)[0];
      const limitAbove = fxssiLevels.nearestLimitAbove?.price;

      if (slClusterAbove && slClusterAbove.price < cp + atrSl * 2) {
        // SL just above the losing cluster
        sl = Math.round((slClusterAbove.price + atr * 0.3) * 10000) / 10000;
      } else if (limitAbove && limitAbove < cp + atrSl * 2) {
        // SL above resistance wall
        sl = Math.round((limitAbove + atr * 0.5) * 10000) / 10000;
      } else {
        sl = Math.round((cp + atrSl) * 10000) / 10000;
      }
    }

  } else {
    // ATR fallback — no FXSSI data
    if (direction === 'LONG') {
      sl = Math.round((close - atr * 1.5) * 10000) / 10000;
      tp = Math.round((close + atr * 3.0) * 10000) / 10000;
    } else {
      sl = Math.round((close + atr * 1.5) * 10000) / 10000;
      tp = Math.round((close - atr * 3.0) * 10000) / 10000;
    }
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
  // Try Pine's multi-TF ATR from raw_payload first
  try {
    if (data.raw_payload) {
      const raw = JSON.parse(data.raw_payload);
      const atr = raw.atr;
      if (atr) {
        // Use 1h ATR for SL/TP — best balance of sensitivity and noise
        return atr['1h'] || atr['4h'] || atr['15m'] || atr['5m'] || null;
      }
    }
  } catch(e) {}
  // Fallback: use high-low range of current bar
  const range = (data.high || 0) - (data.low || 0);
  if (range > 0) return range;
  // Last resort: asset class defaults
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

  // FXSSI order book insights
  try {
    const raw = data.fxssi_analysis || data.raw_payload;
    if (raw) {
      const parsed = JSON.parse(raw);
      const fx = parsed.fxssiAnalysis
        ? (typeof parsed.fxssiAnalysis === 'string' ? JSON.parse(parsed.fxssiAnalysis) : parsed.fxssiAnalysis)
        : (parsed.longPct != null ? parsed : null);
      if (fx) {
        const cp = data.close || 0;
        if (fx.gravity?.price) parts.push(`SL gravity at ${fx.gravity.price} — price magnet`);
        if (fx.losingClusters?.some(c => direction === 'SHORT' ? c.price > cp : c.price < cp))
          parts.push(`Trapped ${direction === 'SHORT' ? 'buyers' : 'sellers'} — trampoline fuel`);
        if (fx.winningClusters?.some(c => direction === 'SHORT' ? c.price < cp : c.price > cp))
          parts.push(`⚠ Winning cluster — reversal risk`);
        if (fx.middleOfVolume) {
          const side = direction === 'SHORT' ? cp > fx.middleOfVolume : cp < fx.middleOfVolume;
          if (side) parts.push(`Price ${direction === 'SHORT' ? 'above' : 'below'} volume midpoint — overextension confirmed`);
        }
      }
    }
  } catch(e) {}

  // Conflict/agreement signal
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
      console.error(`[Scorer] ${symbol} error:`, e.message, e.stack?.split('\n')[1]);
      results.push({
        symbol,
        label: SYMBOLS[symbol]?.label || symbol,
        verdict: 'SKIP',
        score: 0,
        direction: null,
        reasoning: `Error: ${e.message}`,
        ts: Date.now()
      });
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
