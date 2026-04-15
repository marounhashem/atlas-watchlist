'use strict';

// ── Mercato Context Engine ────────────────────────────────────────────────────
// Applies Silvia Vianello's daily US500 analysis as a scoring layer.
// US500 only. Tolerance: ±3 points from published level.
// Follows Rule 6: penalises/boosts only, never blocks (except Flow 3 generated
// signals, which are opt-in and hard-gated by detectFlushRecovery).

const MERCATO_SYMBOLS = new Set([
  'US500','US30','US100','DE40','UK100','J225','HK50','CN50',
  'GOLD','SILVER','OILWTI','COPPER','PLATINUM',
  'BTCUSD','ETHUSD',
  'EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD',
  'EURJPY','EURGBP','EURAUD','EURCHF','GBPJPY','GBPCHF','AUDJPY'
]);

// Per-asset-class level tolerance. Returns absolute price distance.
// Indices use fixed point buffer (bigger absolute moves). Commodities + crypto
// use a medium buffer. Forex uses 0.08% of current price (pip-proportional).
const _INDEX_SYMBOLS = new Set(['US500','US30','US100','DE40','UK100','J225','HK50','CN50']);
const _COMMODITY_CRYPTO_SYMBOLS = new Set(['GOLD','SILVER','OILWTI','COPPER','PLATINUM','BTCUSD','ETHUSD']);
const FOREX_TOLERANCE_PCT = 0.0008;

function getSymbolTolerance(symbol, price) {
  if (_INDEX_SYMBOLS.has(symbol)) return 8.0;
  if (_COMMODITY_CRYPTO_SYMBOLS.has(symbol)) return 5.0;
  return Math.max(0, (price || 0) * FOREX_TOLERANCE_PCT);
}

function _fmtTol(symbol, tolerance) {
  return _INDEX_SYMBOLS.has(symbol) || _COMMODITY_CRYPTO_SYMBOLS.has(symbol)
    ? tolerance.toFixed(1)
    : tolerance.toFixed(5);
}

// Score multipliers — same philosophy as existing macro multipliers
const MULT_APPROVED     = 1.12;  // level match + bias align → +12%
const MULT_CONFLICT     = 0.85;  // bias directly opposes direction → −15%

// Generated signal (Flow 3) config
const MERCATO_SIGNAL_SCORE = 90;
const MERCATO_COOLDOWN_MS  = 30 * 60 * 1000;
const MERCATO_TAG          = '📡 MERCATO GENERATED SIGNAL';
const FLUSH_LOOKBACK       = 12;
const _mercatoCooldowns    = new Map();

// ── Flow 1 + 2: context tagging/multiplier ───────────────────────────────────

function checkMercato(symbol, price, direction, db) {
  if (!MERCATO_SYMBOLS.has(symbol)) return null;
  if (!price || !direction) return null;

  const ctx = db.getMercatoContext(symbol);
  if (!ctx) return null;

  const tolerance = getSymbolTolerance(symbol, price);
  const tolLabel  = _fmtTol(symbol, tolerance);
  const allLevels = [...(ctx.levels_res || []), ...(ctx.levels_sup || [])];
  const nearLevel = allLevels.find(l => Math.abs(l - price) <= tolerance);

  const biasAlign =
    (ctx.bias === 'BULL' && direction === 'LONG')  ||
    (ctx.bias === 'BEAR' && direction === 'SHORT') ||
    (ctx.bias === 'NEUTRAL');

  const biasConflict =
    (ctx.bias === 'BULL' && direction === 'SHORT') ||
    (ctx.bias === 'BEAR' && direction === 'LONG');

  if (nearLevel && biasAlign && !biasConflict) {
    return {
      tag:        'APPROVED',
      multiplier: MULT_APPROVED,
      note:       `✅ MERCATO APPROVED — Level ${nearLevel} ±${tolLabel} · Bias ${ctx.bias} aligned`,
      levelHit:   nearLevel,
      bias:       ctx.bias,
      regime:     ctx.regime
    };
  }

  if (biasConflict) {
    return {
      tag:        'CONFLICT',
      multiplier: MULT_CONFLICT,
      note:       `⚠️ MERCATO CONFLICT — Daily bias ${ctx.bias} opposes ${direction}`,
      levelHit:   nearLevel || null,
      bias:       ctx.bias,
      regime:     ctx.regime
    };
  }

  if (nearLevel || biasAlign) {
    const parts = [];
    if (nearLevel) parts.push(`Level ${nearLevel} ±${tolLabel} match`);
    if (biasAlign) parts.push(`Bias ${ctx.bias} aligned`);
    else           parts.push('Bias NEUTRAL');
    return {
      tag:        'PARTIAL',
      multiplier: 1.0,
      note:       `📍 MERCATO PARTIAL — ${parts.join(' · ')}`,
      levelHit:   nearLevel || null,
      bias:       ctx.bias,
      regime:     ctx.regime
    };
  }

  return null;
}

function applyMercatoToScore(score, mercatoResult) {
  if (!mercatoResult || mercatoResult.multiplier === 1.0) return score;
  const newScore = Math.round(score * mercatoResult.multiplier);
  const floor    = Math.round(score * 0.70); // respect CLAUDE.md multiplier floor
  return Math.max(floor, newScore);
}

// ── Flow 3: Mercato Generated Signals ────────────────────────────────────────

// Scan last ~1h of 5-min snapshots for a flush/recovery or breakout retest at
// the target level. Hard gate for buildMercatoSignal. Not used by Flow 1 or 2.
function detectFlushRecovery(level, direction, symbol, db) {
  const bars = db.getRecentMarketHistory(symbol, FLUSH_LOOKBACK);
  if (!bars || bars.length < 3) {
    console.log(`[Mercato] detectFlushRecovery — insufficient history for ${symbol}: ${bars ? bars.length : 0} bars`);
    return null;
  }

  const tolerance = getSymbolTolerance(symbol, level);
  const current   = bars[0];

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];

    if (direction === 'LONG') {
      const flushed      = bar.low   < level - tolerance;
      const recovered    = bar.close > level;
      const stillHolding = current.close > level;
      if (flushed && recovered && stillHolding) {
        const flushDepth = +(level - bar.low).toFixed(1);
        const quality    = i <= 2 ? 'A+' : i <= 4 ? 'A' : 'B';
        console.log(`[Mercato] FAILED_BREAKDOWN at ${level} on ${symbol} — depth ${flushDepth}, ${i} bars ago ⭐${quality}`);
        return {
          pattern:     'FAILED_BREAKDOWN',
          flush_price: +bar.low.toFixed(2),
          flush_depth: flushDepth,
          bars_ago:    i,
          quality,
          note: `Failed Breakdown @ ${level} — flush −${flushDepth}pts (${i} bars ago) ⭐${quality}`
        };
      }
    }

    if (direction === 'SHORT') {
      const flushed    = bar.high  > level + tolerance;
      const recovered  = bar.close < level;
      const stillBelow = current.close < level;
      if (flushed && recovered && stillBelow) {
        const flushDepth = +(bar.high - level).toFixed(1);
        const quality    = i <= 2 ? 'A+' : i <= 4 ? 'A' : 'B';
        console.log(`[Mercato] FAILED_BREAKOUT at ${level} on ${symbol} — depth ${flushDepth}, ${i} bars ago ⭐${quality}`);
        return {
          pattern:     'FAILED_BREAKOUT',
          flush_price: +bar.high.toFixed(2),
          flush_depth: flushDepth,
          bars_ago:    i,
          quality,
          note: `Failed Breakout @ ${level} — wick +${flushDepth}pts (${i} bars ago) ⭐${quality}`
        };
      }
    }
  }

  // Breakout retest fallback — price previously crossed level, now retesting
  const crossedBelow = bars.slice(1).some(b => b.close < level);
  const crossedAbove = bars.slice(1).some(b => b.close > level);
  const nearLevel    = Math.abs(current.close - level) <= tolerance;

  if (direction === 'LONG' && crossedBelow && current.close > level && nearLevel) {
    console.log(`[Mercato] BREAKOUT_RETEST bullish at ${level} on ${symbol}`);
    return {
      pattern:  'BREAKOUT_RETEST',
      bars_ago: null,
      quality:  'B',
      note:     `Breakout Retest @ ${level} — retesting from above ⭐B`
    };
  }

  if (direction === 'SHORT' && crossedAbove && current.close < level && nearLevel) {
    console.log(`[Mercato] BREAKOUT_RETEST bearish at ${level} on ${symbol}`);
    return {
      pattern:  'BREAKOUT_RETEST',
      bars_ago: null,
      quality:  'B',
      note:     `Breakout Retest @ ${level} — retesting from below ⭐B`
    };
  }

  console.log(`[Mercato] No pattern at level ${level} direction ${direction} on ${symbol} — signal suppressed`);
  return null;
}

// Which level-type should be scanned for a given (bias, direction) pair?
// BULL   LONG  → supports (bias-aligned bounce)
// BULL   SHORT → resistances (failed breakout rejection)
// BEAR   LONG  → resistances (reverse of BULL)
// BEAR   SHORT → supports    (reverse of BULL)
// NEUTRAL both → scan supports and resistances (no bias constraint)
function _levelsForProbe(ctx, direction) {
  const sup = ctx.levels_sup || [];
  const res = ctx.levels_res || [];
  if (ctx.bias === 'BULL')    return direction === 'LONG' ? sup : res;
  if (ctx.bias === 'BEAR')    return direction === 'LONG' ? res : sup;
  /* NEUTRAL */               return [...sup, ...res];
}

function buildMercatoSignal(ctx, currentPrice, direction, db) {
  const symbol      = ctx.symbol || 'US500';
  const cooldownKey = `${symbol}_${direction}`;
  const lastFired   = _mercatoCooldowns.get(cooldownKey) || 0;
  if (Date.now() - lastFired < MERCATO_COOLDOWN_MS) return null;

  const tolerance = getSymbolTolerance(symbol, currentPrice);
  const tolLabel  = _fmtTol(symbol, tolerance);

  const scanLevels = _levelsForProbe(ctx, direction);
  const hitLevel   = scanLevels.find(l => Math.abs(l - currentPrice) <= tolerance);
  if (!hitLevel) return null;

  // Hard gate — require flush/recovery or breakout retest pattern
  const patternResult = detectFlushRecovery(hitLevel, direction, symbol, db);
  if (!patternResult) return null;

  // SL from invalidation level, or 0.3% fallback
  let sl = direction === 'LONG'
    ? (ctx.bull_inv || currentPrice - currentPrice * 0.003)
    : (ctx.bear_inv || currentPrice + currentPrice * 0.003);
  sl = Math.round(sl * 100) / 100;

  // TP: catalyst level, else next resistance/support, else 2R fallback
  let tp;
  const slDist = Math.abs(currentPrice - sl);

  if (ctx.catalyst) {
    tp = ctx.catalyst;
  } else if (direction === 'LONG') {
    const above = (ctx.levels_res || []).filter(l => l > currentPrice).sort((a, b) => a - b);
    tp = above[0] || currentPrice + slDist * 2;
  } else {
    const below = (ctx.levels_sup || []).filter(l => l < currentPrice).sort((a, b) => b - a);
    tp = below[0] || currentPrice - slDist * 2;
  }
  tp = Math.round(tp * 100) / 100;

  const tpDist = Math.abs(tp - currentPrice);
  const rr     = slDist > 0 ? Math.round((tpDist / slDist) * 10) / 10 : 0;
  if (rr < 1.5) {
    console.log(`[Mercato] Generated signal skipped — RR ${rr} < 1.5`);
    return null;
  }

  const tp1 = Math.round((direction === 'LONG' ? currentPrice + slDist : currentPrice - slDist) * 100) / 100;
  const tp2 = tp;
  const tp3 = Math.round((direction === 'LONG' ? tp + slDist * 0.5 : tp - slDist * 0.5) * 100) / 100;

  const reasoning = [
    MERCATO_TAG,
    patternResult.note,
    `Level ${hitLevel} confirmed ±${tolLabel}`,
    `Bias: ${ctx.bias} | Regime: ${ctx.regime || 'N/A'}`,
    ctx.notes ? `📝 ${ctx.notes}` : null,
    `RR: ${rr}R | SL from ${direction === 'LONG' ? 'bull' : 'bear'} invalidation`
  ].filter(Boolean).join('\n');

  return {
    symbol,
    direction,
    entry:          Math.round(currentPrice * 100) / 100,
    sl,
    tp:             tp2,
    tp1,
    tp2,
    tp3,
    score:          MERCATO_SIGNAL_SCORE,
    verdict:        'PROCEED',
    rr,
    session:        'MERCATO',
    reasoning,
    quality:        'A',
    weightedStructScore:    5.0,
    macroContextAvailable:  true,
    expiresAt:      Date.now() + 4 * 60 * 60 * 1000,
    breakdown:      { bias: 1.0, fxssi: 0.0, ob: 0.0, session: 0.5 },
    scoreTrace:     `Mercato(90)→LevelHit(${hitLevel})→Bias(${ctx.bias})→${patternResult.pattern}`,
    eventRiskTag:   null,
    pattern:        patternResult.pattern,
    pattern_quality: patternResult.quality,
    mercato_level:  hitLevel
  };
}

async function checkAndFireMercatoSignal(symbol, currentPrice, db, insertSignalFn, sendTelegramFn) {
  try {
    if (!symbol || !currentPrice) return;
    const ctx = db.getMercatoContext(symbol);
    if (!ctx) return;

    // Always probe both directions — buildMercatoSignal routes to the correct
    // level type (support vs resistance) based on bias + direction:
    //   BULL  → LONG@sup + SHORT@res (failed breakout)
    //   BEAR  → LONG@res + SHORT@sup (reverse)
    //   NEUTRAL → both legs scan both level types
    const directions = ['LONG', 'SHORT'];

    for (const direction of directions) {
      const sig = buildMercatoSignal(ctx, currentPrice, direction, db);
      if (!sig) continue;

      const id = insertSignalFn(sig);
      if (!id) continue;

      _mercatoCooldowns.set(`${symbol}_${direction}`, Date.now());
      console.log(`[Mercato] Signal fired: ${symbol} ${direction} @ ${currentPrice} level=${sig.mercato_level} pattern=${sig.pattern} ⭐${sig.pattern_quality}`);

      if (sendTelegramFn) {
        try {
          await sendTelegramFn({ ...sig, id });
        } catch(e) {
          console.error('[Mercato] Telegram send error:', e.message);
        }
      }
    }
  } catch(e) {
    console.error('[Mercato] checkAndFireMercatoSignal error:', e.message);
  }
}

module.exports = {
  checkMercato,
  applyMercatoToScore,
  detectFlushRecovery,
  buildMercatoSignal,
  checkAndFireMercatoSignal
};
