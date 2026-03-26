const { SYMBOLS, getSessionNow, sessionMultiplier } = require('./config');
const { getLatestMarketData, getWeights, insertSignal } = require('./db');

// ── Scorer version ────────────────────────────────────────────────────────────
// Bump this when scoring logic changes significantly
// Signals saved with an older version get auto-expired on startup
// Format: YYYYMMDD.N (date + daily increment)
const SCORER_VERSION = '20260326.9'; // Daily hard gate, cluster entry, raised PROCEED bar to 78, EV learner

function scoreBias(data) {
  // v2: bias score is now -8 to +8 (emaScore 5TF + vwapDir + rsi×2 + macd + struct4h)
  // v1: bias was -3 to +3
  const raw = Math.abs(data.bias || 0);
  const maxBias = raw > 3 ? 8 : 3;
  const fvgBonus = data.fvg_present ? 0.10 : 0;
  const direction = (data.bias || 0) > 0 ? 'LONG' : 'SHORT';

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

      // ── HTF range position check ───────────────────────────────────────────
      // If price is near the TOP of the 20-bar range, LONGs are entering at resistance
      // If price is near the BOTTOM of the range, SHORTs are entering at support
      // Both are low-probability entries — price is likely to reverse
      const rHigh = raw3.rangeHigh;
      const rLow  = raw3.rangeLow;
      const cp2   = raw3.price || data.close;
      if (rHigh && rLow && cp2 && (rHigh - rLow) > 0) {
        const rangePct = (cp2 - rLow) / (rHigh - rLow); // 0 = bottom, 1 = top
        if (direction === 'LONG') {
          if      (rangePct > 0.80) momBonus -= 0.18; // top 20% of range — strong resistance
          else if (rangePct > 0.70) momBonus -= 0.10; // top 30% — elevated risk
          else if (rangePct > 0.60) momBonus -= 0.05; // upper half — mild caution
        } else { // SHORT
          if      (rangePct < 0.20) momBonus -= 0.18; // bottom 20% — strong support
          else if (rangePct < 0.30) momBonus -= 0.10; // bottom 30%
          else if (rangePct < 0.40) momBonus -= 0.05; // lower half — mild caution
        }
      }

      // ── RSI momentum gate ──────────────────────────────────────────────────
      // EMAs are lagging — RSI reflects actual current momentum
      // If RSI strongly opposes direction, EMAs are lying about current conditions
      const rsi5m = raw3.rsi?.['5m'] || data.rsi || 50;
      if (direction === 'LONG') {
        if      (rsi5m < 30) momBonus -= 0.20; // deeply oversold = selling pressure, not reversal yet
        else if (rsi5m < 40) momBonus -= 0.12; // momentum against LONG
        else if (rsi5m < 45) momBonus -= 0.06; // weak momentum
        else if (rsi5m > 70) momBonus -= 0.10; // overbought LONG = chasing
      } else {
        if      (rsi5m > 70) momBonus -= 0.20; // deeply overbought = buying pressure
        else if (rsi5m > 60) momBonus -= 0.12; // momentum against SHORT
        else if (rsi5m > 55) momBonus -= 0.06; // weak momentum
        else if (rsi5m < 30) momBonus -= 0.10; // oversold SHORT = chasing
      }

      // ── Short-term price action check ──────────────────────────────────────
      // If current close is below open (bearish bar) on a LONG signal,
      // or above open (bullish bar) on SHORT, price action opposes bias
      const barOpen  = raw3.open  || data.close;
      const barClose = raw3.price || data.close;
      if (barOpen && barClose) {
        const barBearish = barClose < barOpen;
        const barBullish = barClose > barOpen;
        if (direction === 'LONG'  && barBearish) momBonus -= 0.06;
        if (direction === 'SHORT' && barBullish) momBonus -= 0.06;
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

  // ── Hourly order book confirmation ───────────────────────────────────────
  // If a level appears in BOTH the 20-min and 1-hour order books it's significant
  // Institutional positions don't appear in short snapshots — hourly confirms them
  // Gravity aligned in both books = strong conviction boost
  // Gravity contradicts in hourly = penalty (short-term noise, hourly says different)
  try {
    if (data.fxssi_hourly_analysis) {
      const hourly = typeof data.fxssi_hourly_analysis === 'string'
        ? JSON.parse(data.fxssi_hourly_analysis) : data.fxssi_hourly_analysis;
      const hGravity = hourly?.gravity?.price;
      const cp3 = data.close || 0;

      if (hGravity && cp3) {
        const hourlyBullish = hGravity > cp3; // gravity above = bullish pull
        const hourlyBearish = hGravity < cp3; // gravity below = bearish pull

        if (direction === 'LONG'  && hourlyBullish) {
          score += 0.15; // hourly confirms LONG bias — institutional buying above
          console.log && null; // silent
        }
        if (direction === 'SHORT' && hourlyBearish) {
          score += 0.15; // hourly confirms SHORT bias — institutional selling below
        }
        if (direction === 'LONG'  && hourlyBearish) score -= 0.10; // hourly contradicts
        if (direction === 'SHORT' && hourlyBullish) score -= 0.10; // hourly contradicts
      }

      // Hourly signalBias confirmation
      const hBias = hourly?.signals?.bias;
      if (hBias === 'BUY'  && direction === 'LONG')  score += 0.08;
      if (hBias === 'SELL' && direction === 'SHORT') score += 0.08;
      if (hBias === 'BUY'  && direction === 'SHORT') score -= 0.08;
      if (hBias === 'SELL' && direction === 'LONG')  score -= 0.08;
    }
  } catch(e) {}

  // ── Profit Ratio Delta scoring ────────────────────────────────────────────
  // Delta > 2% = spike in profitable traders = manipulation/reversal signal
  // If delta spike AND sellers are winning → BUY confirmed (sellers were squeezed)
  // If delta spike AND buyers are winning → SELL confirmed (buyers were squeezed)
  // If delta spike but neutral → slight boost (something happened, direction unclear)
  // No delta or delta < 2% → no effect
  try {
    const raw3 = data.fxssi_analysis || data.raw_payload;
    if (raw3) {
      const parsed3 = JSON.parse(raw3);
      const fx3 = parsed3.fxssiAnalysis
        ? (typeof parsed3.fxssiAnalysis === 'string' ? JSON.parse(parsed3.fxssiAnalysis) : parsed3.fxssiAnalysis)
        : (parsed3.longPct != null ? parsed3 : null);

      const delta3    = fx3?.profitDelta       || 0;
      const deltaBias = fx3?.deltaReversalBias || 'NEUTRAL';

      if (Math.abs(delta3) > 2) {
        if (deltaBias === 'BUY'  && direction === 'LONG')  {
          score += 0.12; // delta confirms LONG
          console.log && null; // silent
        }
        if (deltaBias === 'SELL' && direction === 'SHORT') {
          score += 0.12; // delta confirms SHORT
        }
        if (deltaBias === 'BUY'  && direction === 'SHORT') score -= 0.08; // delta contradicts SHORT
        if (deltaBias === 'SELL' && direction === 'LONG')  score -= 0.08; // delta contradicts LONG
        if (deltaBias === 'NEUTRAL') score += 0.04; // spike but unclear — slight activity boost
      }
    }
  } catch(e) {}

  // ── Gravity + Absorption combo boost ──────────────────────────────────────
  // Both V1 winning trades had this combination — empirically validated
  // Gravity above price = liquidity magnet pulling UP = bullish pull
  // Absorption at entry = large buyers defending the level = support confirmed
  // Together: institutional support + price magnet above = high conviction LONG
  try {
    const raw2 = data.fxssi_analysis || data.raw_payload;
    if (raw2 && data.ob_absorption) {
      const parsed2 = JSON.parse(raw2);
      const fx2 = parsed2.fxssiAnalysis
        ? (typeof parsed2.fxssiAnalysis === 'string' ? JSON.parse(parsed2.fxssiAnalysis) : parsed2.fxssiAnalysis)
        : (parsed2.longPct != null ? parsed2 : null);
      const gp = fx2?.gravity?.price;
      const cp2 = data.close || 0;
      if (gp && cp2) {
        if (direction === 'LONG'  && gp > cp2) score += 0.18; // gravity above + absorption = strong LONG setup
        if (direction === 'SHORT' && gp < cp2) score += 0.18; // gravity below + absorption = strong SHORT setup
      }
    }
  } catch(e) {}

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
  // Use bias_score (composite -8 to +8) not raw bias (just +/-1)
  // Require minimum ±2 — a score of 1 is too weak to trade
  const score = data.bias_score || data.bias || 0;
  if (score >= 2)  return 'LONG';
  if (score <= -2) return 'SHORT';
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
  // Use snapshotTime from fxssi_analysis — NOT data.ts (Pine's bar close timestamp)
  // Pine fires every bar so data.ts is always fresh even if FXSSI is hours old
  let fxssiAge = Infinity;
  try {
    if (data.fxssi_analysis) {
      const fa = typeof data.fxssi_analysis === 'string'
        ? JSON.parse(data.fxssi_analysis) : data.fxssi_analysis;
      if (fa?.snapshotTime) {
        // snapshotTime is Unix seconds from FXSSI API — convert to ms
        const snapMs = fa.snapshotTime > 1e10 ? fa.snapshotTime : fa.snapshotTime * 1000;
        fxssiAge = Date.now() - snapMs;
      }
    }
  } catch(e) {}
  if (fxssiAge === Infinity && data.ts) fxssiAge = Date.now() - data.ts;
  const hasFxssi = data.fxssi_long_pct != null;
  if (hasFxssi && fxssiAge > FXSSI_MAX_AGE_MS) {
    const ageMin = Math.round(fxssiAge / 60000);
    console.log(`[Scorer] ${symbol} — FXSSI stale (${ageMin}m), scoring without order book`);
    data = { ...data,
      fxssi_long_pct: null, fxssi_short_pct: null,
      fxssi_trapped: null, ob_absorption: 0,
      ob_imbalance: 0, ob_large_orders: 0,
      fxssi_analysis: null
    };
  }

  const w = getWeights(symbol);
  // New 3-weight schema: pine, fxssi (covers both sentiment + OB), session
  const weights = w && w.pine ? {
    pine:    w.pine,
    fxssi:   w.fxssi,
    session: w.session
  } : {
    pine:    cfg.scoringWeights.pine    || 0.40,
    fxssi:   cfg.scoringWeights.fxssi   || 0.45,
    session: cfg.scoringWeights.session || 0.15
  };

  // Learned entry/SL/TP blend weights (how much FXSSI vs Pine for each level)
  // Start 50/50, Claude learns to adjust based on what actually works
  const entryFxssiW = w?.entry_fxssi_weight ?? 0.50;
  const slFxssiW    = w?.sl_fxssi_weight    ?? 0.50;
  const tpFxssiW    = w?.tp_fxssi_weight    ?? 0.50;

  const minScore  = w ? w.min_score_proceed : cfg.minScoreProceed;
  const direction = inferDirection(data);
  if (!direction) return null;

  // ── Hard RSI block ────────────────────────────────────────────────────────
  // Analysis of 26 losses showed RSI opposing direction = 0% win rate
  // These are hard blocks, not penalties — no signal generated at all
  // RSI < 35 on LONG: price in freefall, catching a falling knife
  // RSI > 65 on SHORT: price in strong uptrend, fading momentum
  const rsiCheck = data.rsi || 50;
  if (direction === 'LONG'  && rsiCheck < 40) {
    console.log(`[Scorer] ${symbol} LONG blocked — RSI ${rsiCheck} < 40 (momentum against)`);
    return null;
  }
  // SHORT: only block if RSI extremely overbought (>75) — RSI 50-75 is ideal SHORT zone
  // RSI 60-75 on SHORT = elevated price, not yet extreme = best SHORT entry zone
  // Previous threshold of 60 was incorrectly blocking the best SHORT setups
  if (direction === 'SHORT' && rsiCheck > 75) {
    console.log(`[Scorer] ${symbol} SHORT blocked — RSI ${rsiCheck} > 75 (extreme overbought, chase risk)`);
    return null;
  }

  // ── EMA + Structure trend filter ─────────────────────────────────────────
  // Block when BOTH higher TFs agree against direction — either via EMA or structure
  // EMA lags significantly — also check structural HH/HL pattern from Pine
  // Block if: (1h AND 4h EMA both against) OR (1h AND 4h structure both against)
  try {
    if (data.raw_payload) {
      const rawEma = JSON.parse(data.raw_payload);
      const emaDir = rawEma.emaDir    || {};
      const st     = rawEma.structure || {};
      const ema1h  = emaDir['1h'] || 0;
      const ema4h  = emaDir['4h'] || 0;
      const ema1d  = emaDir['1d'] || 0; // daily EMA — more responsive than daily structure
      const str1h  = typeof st['1h'] === 'number' ? st['1h'] : 0;
      const str4h  = typeof st['4h'] === 'number' ? st['4h'] : 0;
      const str1d  = typeof st['1d'] === 'number' ? st['1d'] : 0;

      // ── CHANGE 1: Daily bias as hard gate ──────────────────────────────────
      // Daily trend = absolute wall. Not a penalty. Not a filter. A wall.
      // dailyBias: -1 = bearish, +1 = bullish, 0 = ranging
      // Priority: daily structure > daily EMA (structure is confirmed swing, EMA is lagging)
      const dailyBias = str1d !== 0 ? str1d : ema1d;

      if (dailyBias === -1 && direction === 'LONG') {
        // Daily is bearish — ONLY SHORT signals allowed. LONG is blocked, full stop.
        console.log(`[Scorer] ${symbol} LONG blocked — daily trend BEARISH (hard gate)`);
        return null;
      }
      if (dailyBias === 1 && direction === 'SHORT') {
        // Daily is bullish — ONLY LONG signals allowed. SHORT is blocked, full stop.
        console.log(`[Scorer] ${symbol} SHORT blocked — daily trend BULLISH (hard gate)`);
        return null;
      }
      // dailyBias === 0 (ranging): both directions allowed but score floor raised to 82 later

      // Intraday filters still apply — both TFs against = no trade
      if (direction === 'LONG') {
        if (ema1h === -1 && ema4h === -1) {
          console.log(`[Scorer] ${symbol} LONG blocked — 1h AND 4h EMA both bearish`);
          return null;
        }
        if (str1h === -1 && str4h === -1) {
          console.log(`[Scorer] ${symbol} LONG blocked — 1h AND 4h structure both bearish`);
          return null;
        }
      }
      if (direction === 'SHORT') {
        if (ema1h === 1 && ema4h === 1) {
          console.log(`[Scorer] ${symbol} SHORT blocked — 1h AND 4h EMA both bullish`);
          return null;
        }
        if (str1h === 1 && str4h === 1) {
          console.log(`[Scorer] ${symbol} SHORT blocked — 1h AND 4h structure both bullish`);
          return null;
        }
      }

      // Store dailyBias for use in score threshold below
      data._dailyBias = dailyBias;
    }
  } catch(e) {}

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

  // ── SHORT momentum path ──────────────────────────────────────────────────
  // In downtrends, SHORT signals don't need crowd traps — momentum continuation works
  // Standard scoring penalises SHORTs for not having 60%+ crowd trapped LONG
  // This path rewards SHORTs that have: bearish structure + RSI confirming + gravity below
  if (direction === 'SHORT') {
    try {
      let shortMomentumBoost = 0;
      const rsiShort = data.rsi || 50;

      // RSI between 45-60 on SHORT = momentum confirming bearish without being extreme
      if (rsiShort >= 45 && rsiShort <= 60) shortMomentumBoost += 0.06;

      // 4h structure bearish = trend confirmed on higher TF
      if (data.raw_payload) {
        const rawSh = JSON.parse(data.raw_payload);
        const stSh = rawSh.structure || {};
        if (typeof stSh['4h'] === 'number' && stSh['4h'] === -1) shortMomentumBoost += 0.08;
        if (typeof stSh['1h'] === 'number' && stSh['1h'] === -1) shortMomentumBoost += 0.05;
      }

      // FXSSI gravity below price = downward pull confirmed
      if (data.fxssi_analysis) {
        const fxSh = typeof data.fxssi_analysis === 'string'
          ? JSON.parse(data.fxssi_analysis) : data.fxssi_analysis;
        const gpSh = fxSh?.gravity?.price;
        const cpSh = data.close || 0;
        if (gpSh && cpSh && gpSh < cpSh) shortMomentumBoost += 0.07;

        // Price above middleOfVolume = overextended = good fade setup
        if (fxSh?.middleOfVolume && cpSh > fxSh.middleOfVolume) shortMomentumBoost += 0.05;
      }

      // Apply boost — only when at least 2 conditions met (avoid boosting weak setups)
      if (shortMomentumBoost >= 0.12) {
        conflictMultiplier = Math.min(conflictMultiplier * (1 + shortMomentumBoost), conflictMultiplier * 1.35);
        console.log(`[Scorer] ${symbol} SHORT momentum path — boost +${Math.round(shortMomentumBoost*100)}%`);
      }
    } catch(e) {}
  }

  // ── FXSSI gravity + bias contradiction check ─────────────────────────────
  // If FXSSI gravity AND signalBias both contradict direction = strong block
  // gravity above price pulling LONG signal SHORT = liquidity hunt in opposite direction
  try {
    if (data.fxssi_analysis) {
      const fxData = typeof data.fxssi_analysis === 'string'
        ? JSON.parse(data.fxssi_analysis) : data.fxssi_analysis;
      const gravityPrice = fxData?.gravity?.price;
      const signalBias   = fxData?.signals?.bias;
      const cp           = data.close || data.price;
      if (gravityPrice && cp) {
        const gravityAbove = gravityPrice > cp;
        const gravityBelow = gravityPrice < cp;
        const biasContradicts = (direction === 'LONG'  && signalBias === 'SELL') ||
                                (direction === 'SHORT' && signalBias === 'BUY');
        const gravityContradicts = (direction === 'LONG'  && gravityBelow) ||
                                   (direction === 'SHORT' && gravityAbove);
        if (biasContradicts && gravityContradicts) {
          console.log(`[Scorer] ${symbol} ${direction} blocked — FXSSI bias AND gravity both contradict`);
          return null;
        }
        if (biasContradicts) conflictMultiplier *= 0.75;
      }
    }
  } catch(e) {}

  // ── Crowd trap override ───────────────────────────────────────────────────
  // When 60%+ crowd is trapped on the OPPOSITE side, that IS the signal
  // Don't penalise — the contrarian setup is valid even if Pine EMA conflicts
  // 65%+ trapped = strong squeeze setup, slight boost
  const longPct  = data.fxssi_long_pct  || 50;
  const shortPct = data.fxssi_short_pct || 50;
  // Asymmetric crowd thresholds — SHORT needs lower bar to trigger
  const crowdWithUs      = (direction === 'LONG'  && longPct  >= 60) ||
                           (direction === 'SHORT' && shortPct >= 55);
  const crowdTrappedOpp  = (direction === 'LONG'  && shortPct >= 60) ||
                           (direction === 'SHORT' && longPct  >= 55);
  const crowdStrongTrap  = (direction === 'LONG'  && shortPct >= 65) ||
                           (direction === 'SHORT' && longPct  >= 60);

  if (crowdWithUs) {
    // Crowd on same side as us = contrarian risk, slight penalty
    conflictMultiplier *= 0.85;
  } else if (crowdStrongTrap) {
    // 65%+ on opposite side = strong squeeze fuel, override EMA conflict penalty
    if (conflictMultiplier < 1.0) conflictMultiplier = Math.min(1.0, conflictMultiplier + 0.15);
    conflictMultiplier *= 1.05;
  } else if (crowdTrappedOpp) {
    // 60-65% on opposite side = moderate contrarian setup
    if (conflictMultiplier < 1.0) conflictMultiplier = Math.min(1.0, conflictMultiplier + 0.08);
  }

  // ── Multi-TF structure alignment ──────────────────────────────────────────
  // structScore -5 to +5: all 5 TFs agreeing = much stronger than single 4h
  let structScore = 0;
  try {
    if (data.raw_payload) {
      const rawS = JSON.parse(data.raw_payload);
      const st = rawS.structure;
      if (st && typeof st.score === 'number') {
        structScore = st.score;
      } else {
        structScore = (st?.['1m']||0) + (st?.['5m']||0) + (st?.['15m']||0) + (st?.['1h']||0) + (st?.['4h']||0) + (st?.['1d']||0);
                      (st?.['1h']||0) + (st?.['4h']||0);
      }
    }
  } catch(e) {}
  if (structScore === 0) {
    const structure = data.structure || 'ranging';
    structScore = structure === 'bullish' ? 2 : structure === 'bearish' ? -2 : 0;
  }

  if (direction === 'LONG') {
    if      (structScore >= 4)  conflictMultiplier *= 1.08;
    else if (structScore >= 2)  conflictMultiplier *= 1.03;
    else if (structScore <= -3) conflictMultiplier *= 0.72;
    else if (structScore <= -1) conflictMultiplier *= 0.88;
  } else {
    if      (structScore <= -4) conflictMultiplier *= 1.08;
    else if (structScore <= -2) conflictMultiplier *= 1.03;
    else if (structScore >= 3)  conflictMultiplier *= 0.72;
    else if (structScore >= 1)  conflictMultiplier *= 0.88;
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

  // Combined FXSSI score = average of sentiment + order book (same source, two perspectives)
  const fxssiCombined = (fxssiSc + obSc) / 2;

  const rawScore = (
    biasSc       * weights.pine +
    fxssiCombined * weights.fxssi +
    sessionSc    * weights.session
  ) * 100;

  // ── Structure-based score ceiling ─────────────────────────────────────────
  // Can't be 90%+ confident if only 0-1 TFs agree on direction
  // Requires multi-TF alignment to justify high scores
  // Within each structure tier, FXSSI signal count differentiates quality
  let structureCap = 95;
  let structTier = 5; // default: 5 TFs aligned
  try {
    if (data.raw_payload) {
      const rawSc = JSON.parse(data.raw_payload);
      const stSc  = rawSc.structure;
      const sc    = typeof stSc?.score === 'number' ? Math.abs(stSc.score)
        : (stSc ? Math.abs((stSc['1m']||0)+(stSc['5m']||0)+(stSc['15m']||0)+(stSc['1h']||0)+(stSc['4h']||0)+(stSc['1d']||0)) : 0);
      structTier = sc;
      if      (sc <= 1) structureCap = 78;
      else if (sc <= 2) structureCap = 84;
      else if (sc <= 3) structureCap = 89;
      else if (sc <= 4) structureCap = 93;
      else if (sc <= 5) structureCap = 94;
      // sc = 6 (all TFs including daily) → max 95
    }
  } catch(e) {}

  // ── FXSSI signal count tiebreaker within structure tier ───────────────────
  // When structure is 0-1/5, FXSSI signal count (0-7) differentiates quality
  // More FXSSI conditions aligned = higher confidence within the same structure tier
  // Prevents weak and strong signals both capping at exactly 78%
  if (structTier <= 1) {
    try {
      let fxssiSigCount = 0;
      if (data.fxssi_analysis) {
        const fxTb = typeof data.fxssi_analysis === 'string'
          ? JSON.parse(data.fxssi_analysis) : data.fxssi_analysis;
        fxssiSigCount = direction === 'LONG'
          ? (fxTb?.signals?.buy  || 0)
          : (fxTb?.signals?.sell || 0);
      }
      // Scale cap within 0/5 tier based on FXSSI conviction:
      // 0-1 signals = 68%  (very weak — barely passes)
      // 2-3 signals = 72%  (moderate FXSSI confirmation)
      // 4-5 signals = 75%  (strong FXSSI confirmation)
      // 6-7 signals = 78%  (maximum allowed at 0/5 structure)
      if      (fxssiSigCount <= 1) structureCap = 68;
      else if (fxssiSigCount <= 3) structureCap = 72;
      else if (fxssiSigCount <= 5) structureCap = 75;
      // 6-7 keeps the existing 78% cap
    } catch(e) {}
  }

  const cappedRaw = Math.min(structureCap, rawScore);
  const score = Math.round(cappedRaw * conflictMultiplier);

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

  // ── CHANGE 5: Raise the bar — PROCEED requires real conviction ──────────────
  // PROCEED: score >= adjustedMinScore (raised to 78 in config)
  // WATCH:   score >= adjustedMinScore - 8 (tight band, not 15 below)
  // SKIP:    everything else — not a trade, not a watch
  // Ranging daily (dailyBias===0): floor raised to 82 for PROCEED
  const dailyBiasForThresh = data._dailyBias !== undefined ? data._dailyBias : 0;
  const rangingPenalty = dailyBiasForThresh === 0 ? 4 : 0; // daily ranging = need higher conviction
  const effectiveMinScore = adjustedMinScore + rangingPenalty;
  const verdict = finalScore >= effectiveMinScore ? 'PROCEED'
    : finalScore >= effectiveMinScore - 8 ? 'WATCH'
    : 'SKIP';
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

  // ── Entry price — 50% OB (FXSSI limit wall) + 50% Pine (FVG/swing/VWAP) ────
  // Average the two sources when both available — neither dominates
  let entry = close;
  let entrySource = 'price';

  let pineOptimalEntry = null;
  let obEntry = null;

  // ── CHANGE 2: Entry = heaviest institutional volume cluster ─────────────────
  // The heaviest ol (limit orders) cluster below price (LONG) or above (SHORT)
  // IS the institutional level — that is where smart money is waiting to buy/sell
  // Priority: heaviest FXSSI volume cluster → FVG level → ATR buffer (last resort)
  const fallbackBuffer = atr * 0.35;

  // Find heaviest ol cluster in the order book
  let heaviestClusterEntry = null;
  try {
    if (data.raw_payload) {
      const rawOB = JSON.parse(data.raw_payload);
      const levels = rawOB.fxssiLevels || rawOB.levels || [];
      if (levels.length > 0 && close > 0) {
        if (direction === 'LONG') {
          // Heaviest ol cluster BELOW price — institutional support
          const below = levels
            .filter(l => l.price < close && (l.ol || 0) > 0.2)
            .sort((a, b) => (b.ol || 0) - (a.ol || 0)); // sort by volume desc
          const best = below[0];
          if (best && (close - best.price) < atr * 3) {
            // Slight buffer just above the cluster (enter just above institutional level)
            heaviestClusterEntry = Math.round((best.price * 1.0002) * 10000) / 10000;
            entrySource = `fxssi_cluster_vol${Math.round((best.ol||0)*10)/10}`;
          }
        } else {
          // Heaviest ol cluster ABOVE price — institutional resistance
          const above = levels
            .filter(l => l.price > close && (l.ol || 0) > 0.2)
            .sort((a, b) => (b.ol || 0) - (a.ol || 0));
          const best = above[0];
          if (best && (best.price - close) < atr * 3) {
            // Slight buffer just below the cluster
            heaviestClusterEntry = Math.round((best.price * 0.9998) * 10000) / 10000;
            entrySource = `fxssi_cluster_vol${Math.round((best.ol||0)*10)/10}`;
          }
        }
      }
    }
  } catch(e) {}

  // Fallback 1: FVG level (if meaningfully away from close)
  let fvgEntry = null;
  try {
    if (data.raw_payload) {
      const raw4 = JSON.parse(data.raw_payload);
      const pe = raw4.entry;
      if (pe) {
        const lvl = direction === 'LONG' ? pe.longOptimal : pe.shortOptimal;
        const src = direction === 'LONG' ? pe.longSource  : pe.shortSource;
        if (lvl && src !== 'close' && Math.abs(lvl - close) >= atr * 0.15) {
          fvgEntry = Math.round(lvl * 10000) / 10000;
          if (!heaviestClusterEntry) entrySource = `pine_${src}`;
        }
      }
    }
  } catch(e) {}

  // Entry selection: cluster > FVG > ATR buffer
  if (heaviestClusterEntry) {
    // Validate cluster entry is actually away from current price (min 0.1×ATR)
    if (Math.abs(heaviestClusterEntry - close) >= atr * 0.10) {
      entry = heaviestClusterEntry;
    } else if (fvgEntry) {
      entry = fvgEntry;
      entrySource = 'fvg_fallback';
    } else {
      entry = direction === 'LONG'
        ? Math.round((close - fallbackBuffer) * 10000) / 10000
        : Math.round((close + fallbackBuffer) * 10000) / 10000;
      entrySource = 'atr_buffer';
    }
  } else if (fvgEntry) {
    entry = fvgEntry;
  } else {
    // Last resort: ATR buffer
    entry = direction === 'LONG'
      ? Math.round((close - fallbackBuffer) * 10000) / 10000
      : Math.round((close + fallbackBuffer) * 10000) / 10000;
    entrySource = 'atr_buffer';
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

    // ── Pine-based SL/TP (50% weight) ────────────────────────────────────────
    // Pine sends swing levels and VWAP bands — use as independent SL/TP source
    let pineSl = null, pineTp = null;
    try {
      const raw5 = JSON.parse(data.raw_payload || '{}');
      const sr = raw5.sr || raw5.structure || {};
      const vwap = raw5.vwap || {};

      if (direction === 'LONG') {
        // Pine SL: nearest swing low below close, or VWAP lower2
        const swingL = sr.swingL1 || sr.swingL2;
        const vwapL  = vwap.lower2 || vwap.lower1;
        if (swingL && swingL < close && swingL > close - atr * 4) {
          pineSl = Math.round((swingL - atr * 0.2) * 10000) / 10000;
        } else if (vwapL && vwapL < close) {
          pineSl = Math.round((vwapL - atr * 0.1) * 10000) / 10000;
        }
        // Pine TP: nearest swing high above close, or VWAP upper2
        const swingH = sr.swingH1 || sr.swingH2;
        const vwapU  = vwap.upper2 || vwap.upper1;
        if (swingH && swingH > close && swingH < close + atr * 6) {
          pineTp = Math.round((swingH - atr * 0.1) * 10000) / 10000;
        } else if (vwapU && vwapU > close) {
          pineTp = Math.round((vwapU - atr * 0.1) * 10000) / 10000;
        }
      } else {
        // Pine SL: nearest swing high above close
        const swingH = sr.swingH1 || sr.swingH2;
        const vwapU  = vwap.upper2 || vwap.upper1;
        if (swingH && swingH > close && swingH < close + atr * 4) {
          pineSl = Math.round((swingH + atr * 0.2) * 10000) / 10000;
        } else if (vwapU && vwapU > close) {
          pineSl = Math.round((vwapU + atr * 0.1) * 10000) / 10000;
        }
        // Pine TP: nearest swing low below close
        const swingL = sr.swingL1 || sr.swingL2;
        const vwapL  = vwap.lower2 || vwap.lower1;
        if (swingL && swingL < close && swingL > close - atr * 6) {
          pineTp = Math.round((swingL + atr * 0.1) * 10000) / 10000;
        } else if (vwapL && vwapL < close) {
          pineTp = Math.round((vwapL + atr * 0.1) * 10000) / 10000;
        }
      }
    } catch(e) {}

    // Blend OB and Pine using learned weights for SL/TP
    // slFxssiW and tpFxssiW start at 0.50 and Claude adjusts from outcomes
    if (pineSl) sl = Math.round((sl * slFxssiW + pineSl * (1 - slFxssiW)) * 10000) / 10000;
    if (pineTp) tp = Math.round((tp * tpFxssiW + pineTp * (1 - tpFxssiW)) * 10000) / 10000;

    // ── TP cap at HTF resistance/support ──────────────────────────────────────
    // Don't set TP beyond the nearest significant S/R level — price won't pass it cleanly
    // Use Pine's nearestResistance/nearestSupport and rangeHigh/rangeLow
    try {
      const raw6 = JSON.parse(data.raw_payload || '{}');
      const sr   = raw6.sr || {};
      if (direction === 'LONG' && tp) {
        // Cap TP at nearest resistance (leave small buffer)
        const res = sr.resistance;
        const rHi = raw6.rangeHigh;
        let cap = null;
        if (res && res > entry && res < tp) cap = Math.round((res - atr * 0.3) * 10000) / 10000;
        if (rHi && rHi > entry && rHi < tp && (!cap || rHi < cap)) cap = Math.round((rHi - atr * 0.2) * 10000) / 10000;
        if (cap && cap > entry) {
          tp = cap;
          console.log(`[Scorer] ${symbol} LONG TP capped at resistance ${cap}`);
        }
      } else if (direction === 'SHORT' && tp) {
        // Cap TP at nearest support (leave small buffer)
        const sup = sr.support;
        const rLo = raw6.rangeLow;
        let cap = null;
        if (sup && sup < entry && sup > tp) cap = Math.round((sup + atr * 0.3) * 10000) / 10000;
        if (rLo && rLo < entry && rLo > tp && (!cap || rLo > cap)) cap = Math.round((rLo + atr * 0.2) * 10000) / 10000;
        if (cap && cap < entry) {
          tp = cap;
          console.log(`[Scorer] ${symbol} SHORT TP capped at support ${cap}`);
        }
      }
    } catch(e) {}

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

  // ── TP sanity gate — cap at 5× ATR ───────────────────────────────────────
  // Analysis showed 16 signals with R:R > 10 (up to 1102:1) — these are not real trades
  // Happens when FXSSI has no cluster above entry and TP falls back to uncapped projection
  // Cap TP at 5× ATR from entry — anything beyond is unrealistic for a swing trade
  const maxTpDist = atr * 5.0;
  if (direction === 'LONG'  && tp && tp - entry > maxTpDist) {
    tp = Math.round((entry + maxTpDist) * 10000) / 10000;
    console.log(`[Scorer] ${symbol} LONG TP capped at 5×ATR: ${tp}`);
  }
  if (direction === 'SHORT' && tp && entry - tp > maxTpDist) {
    tp = Math.round((entry - maxTpDist) * 10000) / 10000;
    console.log(`[Scorer] ${symbol} SHORT TP capped at 5×ATR: ${tp}`);
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

  // ── Minimum R:R hard gate ─────────────────────────────────────────────────
  // Below 1.5 R:R is not worth taking regardless of score
  // Recalculate after all level adjustments are done
  rr = calcRR(entry, sl, tp, direction);
  const minRRGate = cfg.assetClass === 'index' ? 1.8 : 1.5;
  if (!rr || rr < minRRGate) {
    console.log(`[Scorer] ${symbol} ${direction} — R:R ${rr} below minimum ${minRRGate}, skipping`);
    return null;
  }

  // ── Minimum SL distance per asset class ──────────────────────────────────
  // Prevents SL being placed within normal noise range — guaranteed stop-out
  const minSlPct = { crypto: 0.008, commodity: 0.005, index: 0.003 }[cfg.assetClass] || 0.004;
  const slDist = Math.abs(entry - sl) / entry;
  if (slDist < minSlPct) {
    // Widen SL to minimum distance, recalculate TP to maintain R:R
    const minSlDist = entry * minSlPct;
    if (direction === 'LONG') {
      sl = Math.round((entry - minSlDist) * 10000) / 10000;
      tp = Math.round((entry + minSlDist * (rr || 2.0)) * 10000) / 10000;
    } else {
      sl = Math.round((entry + minSlDist) * 10000) / 10000;
      tp = Math.round((entry - minSlDist * (rr || 2.0)) * 10000) / 10000;
    }
    rr = calcRR(entry, sl, tp, direction);
    console.log(`[Scorer] ${symbol} ${direction} — SL widened to min ${(minSlPct*100).toFixed(1)}% distance`);
  }

  // ── Macro context score adjustment ────────────────────────────────────────
  // Apply macro backdrop to final score — not just reasoning text
  // Bearish macro + LONG signal = lower score, Bullish macro + LONG = higher score
  let macroScoreAdj = 0;
  try {
    const macro = global.atlasGetMacroContext?.()[symbol];
    if (macro && macro.sentiment && (Date.now() - macro.ts) < 24 * 3600000) {
      if (direction === 'LONG') {
        if (macro.sentiment === 'BULLISH'  && macro.strength >= 6) macroScoreAdj = +3;
        if (macro.sentiment === 'BULLISH'  && macro.strength >= 3) macroScoreAdj = +1;
        if (macro.sentiment === 'BEARISH'  && macro.strength >= 6) macroScoreAdj = -5;
        if (macro.sentiment === 'BEARISH'  && macro.strength >= 3) macroScoreAdj = -3;
      } else {
        if (macro.sentiment === 'BEARISH'  && macro.strength >= 6) macroScoreAdj = +3;
        if (macro.sentiment === 'BEARISH'  && macro.strength >= 3) macroScoreAdj = +1;
        if (macro.sentiment === 'BULLISH'  && macro.strength >= 6) macroScoreAdj = -5;
        if (macro.sentiment === 'BULLISH'  && macro.strength >= 3) macroScoreAdj = -3;
      }
    }
  } catch(e) {}
  const macroAdjustedScore = Math.min(structureCap, Math.min(95, Math.max(0, finalScore + macroScoreAdj)));
  const macroRangingPenalty = data._dailyBias === 0 ? 4 : 0;
  const macroEffectiveMin = adjustedMinScore + macroRangingPenalty;
  const macroVerdict = macroAdjustedScore >= macroEffectiveMin ? 'PROCEED'
    : macroAdjustedScore >= macroEffectiveMin - 8 ? 'WATCH' : 'SKIP';

  const fxssiStale = hasFxssi && fxssiAge > FXSSI_MAX_AGE_MS;
  const finalReasoning = fxssiStale
    ? `⚠ FXSSI stale (${Math.round(fxssiAge/60000)}m) — OB scoring neutral · ` + reasoning
    : reasoning;

  return {
    symbol, label: cfg.label, direction, score: macroAdjustedScore, verdict: macroVerdict,
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
  // Multi-TF structure breakdown in reasoning
  let structTag = '';
  try {
    if (data.raw_payload) {
      const rawR = JSON.parse(data.raw_payload);
      const st = rawR.structure;
      if (st) {
        const tfs = ['1m','5m','15m','1h','4h','1d'];
        const aligned = tfs.filter(tf => (direction==='LONG' ? st[tf]===1 : st[tf]===-1));
        const opposed = tfs.filter(tf => (direction==='LONG' ? st[tf]===-1 : st[tf]===1));
        const sc = typeof st.score === 'number' ? st.score : 0;
        const maxTFs = st['1d'] !== undefined ? 6 : 5; // 6 TFs if daily is in payload
        structTag = ` · Structure ${aligned.length}/${maxTFs} aligned [${aligned.join(',') || '—'}]${opposed.length ? ' ⚠ opposed:'+opposed.join(',') : ''}`;
      }
    }
  } catch(e) {}
  if (biasSc > 0.7) parts.push(`Strong ${direction} structure on Pine (${Math.round(biasSc * 100)}%)${structTag}`);
  else if (biasSc > 0.4) parts.push(`Moderate ${direction} bias${structTag}`);
  else parts.push(`Weak bias — treat with caution${structTag}`);

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
      // HTF range position
      const rHigh2 = parsed.rangeHigh;
      const rLow2  = parsed.rangeLow;
      const cp3    = parsed.price || data.close;
      if (rHigh2 && rLow2 && cp3 && (rHigh2 - rLow2) > 0) {
        const pos = Math.round(((cp3 - rLow2) / (rHigh2 - rLow2)) * 100);
        if (direction === 'LONG' && pos > 70) parts.push(`⚠ Price at ${pos}% of range — near resistance`);
        if (direction === 'SHORT' && pos < 30) parts.push(`⚠ Price at ${pos}% of range — near support`);
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

  // ── Opposite direction conflict guard ─────────────────────────────────────
  // If an OPEN or ACTIVE signal already exists in the opposite direction,
  // do NOT save this new signal — prevents simultaneous LONG+SHORT on same symbol
  // The existing trade takes priority; the new signal is discarded
  try {
    const { getLatestOpenSignal } = require('./db');
    const oppositeDir = scored.direction === 'LONG' ? 'SHORT' : 'LONG';
    const oppositeSignal = getLatestOpenSignal(scored.symbol, oppositeDir);
    if (oppositeSignal) {
      console.log(`[Scorer] ${scored.symbol} ${scored.direction} blocked — opposite ${oppositeDir} already OPEN/ACTIVE (id:${oppositeSignal.id})`);
      return null;
    }
  } catch(e) {
    console.error('[Scorer] opposite-dir check error:', e.message);
  }

  // Dedup only checks CURRENT CYCLE signals (cycle=0)
  // Retired ACTIVE signals (cycle>0) are completely invisible here —
  // a fresh signal can fire immediately after retirement for same symbol+direction
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
      const { refineSignal } = require('./db');
      const count = refineSignal(last.id, {
        score:         scored.score,
        entry:         scored.entry,
        sl:            scored.sl,
        tp:            scored.tp,
        rr:            scored.rr,
        reasoning:     scored.reasoning,
        scorerVersion: SCORER_VERSION
      });
      console.log(`[Scorer] ${scored.symbol} ${scored.direction} — refined ×${count} (RR:${last.rr}→${scored.rr})`);
      return last.id; // same record, updated in place
    }

    console.log(`[Scorer] ${scored.symbol} ${scored.direction} — keeping existing signal`);
    return null;
  }

  return insertSignal({ ...scored, scorerVersion: SCORER_VERSION });
}

module.exports = { scoreSymbol, scoreAllPriority, saveSignal, SCORER_VERSION };
