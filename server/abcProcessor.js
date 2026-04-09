'use strict';

// ── ABC Processor — moved from index.js ─────────────────────────────────────
// Handles Pine ABC webhook signals, daily bias ingestion, and Class C routing.

const ABC_VERSION = '20260409.1';

const { runAbcGates } = require('./abcGates');
const { buildAbcScore, buildAbcBreakdown, buildAbcReasoning } = require('./abcReasoning');
const { sendAbcSignalAlert } = require('./telegram');
const { getSessionNow, SYMBOLS: _SYMBOLS } = require('./config');

// ── Symbol alias normalization ──────────────────────────────────────────────
function normalizeSymbol(raw) {
  if (!raw) return null;
  return raw.toUpperCase()
    .replace('XAUUSD','GOLD').replace('XAGUSD','SILVER')
    .replace('USOIL','OILWTI').replace('WTI','OILWTI').replace('OIL_CRUDE','OILWTI')
    .replace('SPX500USD','US500').replace('ETHUSDT','ETHUSD')
    .replace('NAS100USD','US100').replace('DE30EUR','DE40')
    .replace('UK100GBP','UK100').replace('JP225USD','J225')
    .replace('HK50USD','HK50').replace('CN50USD','CN50');
}

// ── Decimal precision per symbol ────────────────────────────────────────────
function getAbcDp(symbol) {
  const JPY_PAIRS = ['USDJPY','EURJPY','GBPJPY','AUDJPY'];
  const INDICES   = ['US30','US100','US500','DE40','UK100','J225','HK50','CN50'];
  const CRYPTO    = ['BTCUSD','ETHUSD'];
  if (JPY_PAIRS.includes(symbol))  return 1000;    // 3dp for JPY
  if (INDICES.includes(symbol))    return 100;      // 2dp
  if (CRYPTO.includes(symbol))     return 10;       // 1dp
  if (symbol === 'GOLD')           return 100;      // 2dp
  if (symbol === 'SILVER')         return 1000;     // 3dp
  if (symbol === 'OILWTI')         return 100;      // 2dp
  if (symbol === 'COPPER')         return 100;      // 2dp
  if (symbol === 'PLATINUM')       return 100;      // 2dp
  return 100000; // 5dp forex majors/minors
}

// ── Asset class caps for SL and TP distance ─────────────────────────────────
function getSlMaxPct(symbol) {
  const INDICES = ['US30','US100','US500','DE40','UK100','J225','HK50','CN50'];
  const CRYPTO  = ['BTCUSD','ETHUSD'];
  const COMMODITIES = ['GOLD','SILVER','OILWTI','COPPER','PLATINUM'];
  if (INDICES.includes(symbol))    return 0.02;  // 2%
  if (CRYPTO.includes(symbol))     return 0.05;  // 5%
  if (COMMODITIES.includes(symbol)) return 0.03; // 3%
  return 0.015; // 1.5% forex
}

function getTpMaxPct(symbol) {
  const INDICES = ['US30','US100','US500','DE40','UK100','J225','HK50','CN50'];
  const CRYPTO  = ['BTCUSD','ETHUSD'];
  const COMMODITIES = ['GOLD','SILVER','OILWTI','COPPER','PLATINUM'];
  if (INDICES.includes(symbol))    return 0.05;  // 5%
  if (CRYPTO.includes(symbol))     return 0.15;  // 15%
  if (COMMODITIES.includes(symbol)) return 0.08; // 8%
  return 0.03; // 3% forex
}

// ── Process ABC webhook ─────────────────────────────────────────────────────
function processAbcWebhook(data, deps) {
  const { db, broadcast, SYMBOLS } = deps;

  if (!data || !Object.keys(data).length) { console.log('[ABC] Empty body — skipping'); return; }

  const ws = process.env.WEBHOOK_SECRET;
  if (ws && data.secret !== ws) { console.warn('[ABC] Auth failed'); return; }

  const rawSym = data.symbol || data.ticker || null;
  if (!rawSym) { console.log('[ABC] No symbol'); return; }
  const sym = normalizeSymbol(rawSym);

  if (!SYMBOLS[sym]) { console.log('[ABC] Not in priority list:', sym); return; }

  const pineClass = data.class;
  if (!['A','B','C'].includes(pineClass)) {
    console.log(`[ABC] ${sym} — missing or invalid class field: ${pineClass}`); return;
  }

  const direction = (data.direction || '').toUpperCase();
  if (!['LONG','SHORT'].includes(direction)) {
    console.log(`[ABC] ${sym} — invalid direction: ${direction}`); return;
  }

  const cfg = SYMBOLS[sym];
  const dp = getAbcDp(sym);

  // ── Structural entry/SL/TP calculation ────────────────────────────
  const obTop = parseFloat(data.obTop) || null;
  const obBot = parseFloat(data.obBot) || null;
  const obMid = parseFloat(data.obMid) || (obTop && obBot ? (obTop + obBot) / 2 : null);
  const atr   = parseFloat(data.atr) || 0;
  const preBosSwing = parseFloat(data.preBosSwing) || null;
  const swing1 = parseFloat(data.swing1) || null;
  const swing2 = parseFloat(data.swing2) || null;

  // Entry — order block midpoint or fallback to Pine's entry
  let entry;
  if (obMid && !isNaN(obMid)) {
    entry = Math.round(obMid * dp) / dp;
  } else {
    // Fallback for old Pine payloads
    let rawEntry = parseFloat(data.entry || data.close || 0);
    entry = direction === 'LONG'
      ? Math.round((rawEntry - atr * 0.3) * dp) / dp
      : Math.round((rawEntry + atr * 0.3) * dp) / dp;
  }

  // SL — pre-BOS swing with ATR buffer, or OB edge fallback
  const slAtr = atr || (obTop && obBot ? Math.abs(obTop - obBot) : entry * 0.003);
  let sl;
  if (preBosSwing && !isNaN(preBosSwing)) {
    sl = direction === 'LONG'
      ? Math.round((preBosSwing - slAtr * 0.25) * dp) / dp
      : Math.round((preBosSwing + slAtr * 0.25) * dp) / dp;
  } else if (obBot && obTop) {
    sl = direction === 'LONG'
      ? Math.round((obBot - slAtr * 0.25) * dp) / dp
      : Math.round((obTop + slAtr * 0.25) * dp) / dp;
  } else {
    // Final fallback — Pine's SL or ATR-based
    sl = parseFloat(data.sl) || (direction === 'LONG'
      ? Math.round((entry - slAtr * 1.5) * dp) / dp
      : Math.round((entry + slAtr * 1.5) * dp) / dp);
  }

  // ── SL distance cap by asset class ──────────────────────────────────────
  const slMaxPct = getSlMaxPct(sym);
  let slDist = Math.abs(entry - sl);
  const slPct = entry > 0 ? slDist / entry : 0;
  if (slPct > slMaxPct && entry > 0) {
    const cappedDist = entry * slMaxPct;
    console.log(`[ABC] ${sym} SL capped at ${(slMaxPct*100).toFixed(1)}% (structural SL was ${(slPct*100).toFixed(2)}% away)`);
    sl = direction === 'LONG'
      ? Math.round((entry - cappedDist) * dp) / dp
      : Math.round((entry + cappedDist) * dp) / dp;
    slDist = cappedDist;
  }

  // TP1 — 1:1 RR
  let tp1 = direction === 'LONG'
    ? Math.round((entry + slDist) * dp) / dp
    : Math.round((entry - slDist) * dp) / dp;

  // ── TP distance cap by asset class ────────────────────────────────────
  const tpMaxPct = getTpMaxPct(sym);
  const tpMaxDist = entry * tpMaxPct;

  // TP2 — structural swing target or 2.5R fallback
  let tp2;
  const swing1Valid = swing1 && !isNaN(swing1)
    && (direction === 'LONG' ? swing1 > entry : swing1 < entry)
    && Math.abs(swing1 - entry) <= tpMaxDist;
  if (swing1Valid) {
    tp2 = Math.round(swing1 * dp) / dp;
  } else {
    tp2 = direction === 'LONG'
      ? Math.round((entry + slDist * 2.5) * dp) / dp
      : Math.round((entry - slDist * 2.5) * dp) / dp;
  }

  // TP3 — second swing or 3.5R fallback
  let tp3;
  const swing2Valid = swing2 && !isNaN(swing2)
    && (direction === 'LONG' ? swing2 > tp2 : swing2 < tp2)
    && Math.abs(swing2 - entry) <= tpMaxDist;
  if (swing2Valid) {
    tp3 = Math.round(swing2 * dp) / dp;
  } else {
    tp3 = direction === 'LONG'
      ? Math.round((entry + slDist * 3.5) * dp) / dp
      : Math.round((entry - slDist * 3.5) * dp) / dp;
  }

  let tp = tp2;  // main TP = structural target

  // RR gate — after structural placement + caps
  let rr = slDist > 0
    ? Math.round((Math.abs(tp - entry) / slDist) * 10) / 10
    : 0;
  if (rr < 1.5) {
    console.log(`[ABC] ${sym} — RR ${rr} below 1.5 after structural placement — SKIP`);
    return;
  }

  if (!entry || !sl || !tp) { console.log(`[ABC] ${sym} — missing entry/sl/tp`); return; }

  // Parse condition flags — default false for old payloads
  const conditions = {
    cloudPass:    data.cloudPass === true || data.cloudPass === 1 || data.cloudPass === '1' || data.cloudPass === 'true',
    obPresent:    data.obPresent === true || data.obPresent === 1 || data.obPresent === '1' || data.obPresent === 'true',
    pullbackIn:   data.pullbackIn === true || data.pullbackIn === 1 || data.pullbackIn === '1' || data.pullbackIn === 'true',
    rsiDiv:       data.rsiDiv === true || data.rsiDiv === 1 || data.rsiDiv === '1' || data.rsiDiv === 'true',
    volConfirmed: data.volConfirmed === true || data.volConfirmed === 1 || data.volConfirmed === '1' || data.volConfirmed === 'true',
    rejStrong:    data.rejStrong === true || data.rejStrong === 1 || data.rejStrong === '1' || data.rejStrong === 'true'
  };

  // Cooldown — 30min same symbol + direction
  try {
    const recent = db.getAbcSignals(20).find(s =>
      s.symbol === sym && s.direction === direction && (Date.now() - s.ts) < 30 * 60 * 1000
    );
    if (recent) {
      console.log(`[ABC] ${sym} ${direction} cooldown (${Math.round((Date.now() - recent.ts) / 60000)}m) — skipping`);
      return;
    }
  } catch(e) {}

  // Get FXSSI / crowd data
  const fxssiData = (() => {
    try {
      const md = db.getLatestMarketData(sym);
      if (!md) return null;
      // Parse gravity from fxssi_analysis JSON (no gravity_price column on market_data)
      let gravPrice = null;
      try {
        const fa = md.fxssi_analysis ? JSON.parse(md.fxssi_analysis) : null;
        const fx = fa?.fxssiAnalysis ? (typeof fa.fxssiAnalysis === 'string' ? JSON.parse(fa.fxssiAnalysis) : fa.fxssiAnalysis) : (fa?.longPct != null ? fa : null);
        gravPrice = fx?.gravity?.price || null;
      } catch(e) {}
      return {
        fxssi_long_pct:  md.fxssi_long_pct,
        fxssi_short_pct: md.fxssi_short_pct,
        fxssi_trapped:   md.fxssi_trapped,
        gravity_price:   gravPrice
      };
    } catch(e) { return null; }
  })();

  // Compute crowdGate (same logic as fxssiGate but renamed)
  const hasAnyFxssiData = fxssiData &&
    (fxssiData.fxssi_long_pct != null || fxssiData.fxssi_short_pct != null);
  const crowdGate = !hasAnyFxssiData ? 'NO_DATA'
    : fxssiData.fxssi_trapped == null ? 'NO_TRAP'
    : ((direction === 'LONG'  && fxssiData.fxssi_trapped === 'SHORT') ||
       (direction === 'SHORT' && fxssiData.fxssi_trapped === 'LONG'))  ? 'ALIGNED' : 'MISALIGNED';

  // Daily bias — calculated from market_data on every ABC webhook
  let dailyDirection = calculateDailyBias(sym, db);
  let dailyAligned = (direction === 'LONG' && dailyDirection === 'BULL') ||
                     (direction === 'SHORT' && dailyDirection === 'BEAR') ||
                     dailyDirection === 'MIXED';

  // Session
  const session = getSessionNow ? getSessionNow() : 'unknown';

  // ── CLASS C ROUTING ─────────────────────────────────────────────────────────
  if (pineClass === 'C') {
    const score = buildAbcScore('C', conditions, crowdGate, dailyAligned);
    const breakdown = buildAbcBreakdown(conditions, crowdGate, dailyAligned);
    const reasoning = buildAbcReasoning('C', direction, sym, crowdGate,
                                         conditions, dailyDirection, fxssiData, score);
    const expiryHours = cfg?.type?.includes('forex') ? 4 : cfg?.type?.includes('crypto') ? 8 : 6;
    const expiresAt = Date.now() + expiryHours * 3600000;

    const signalId = db.insertClassCSignal({
      symbol: sym, direction, score, verdict: 'OBSERVE',
      entry, sl, tp1, tp2, tp3, rr,
      session, reasoning,
      breakdown: JSON.stringify(breakdown),
      crowdGate, abcVersion: ABC_VERSION,
      obTop, obBot, preBosSwing, expiresAt,
      rawPayload: JSON.stringify(data)
    });

    console.log(`[ABC] ${sym} ${direction} ClassC → OBSERVE (class_c_signals id:${signalId})`);

    broadcast({
      type: 'CLASS_C_SIGNAL', signalId, symbol: sym, direction,
      verdict: 'OBSERVE', entry, sl, tp,
      rr, score, session, reasoning, ts: Date.now()
    });
    return;
  }

  // ── CLASS A / B — run gates ────────────────────────────────────────────────
  const payload = { pineClass, direction, entry, sl, tp, rr };
  const gates   = runAbcGates(sym, payload, fxssiData, db);

  console.log(`[ABC] ${sym} ${direction} Class${pineClass} → ${gates.verdict} | ${gates.reason}`);

  if (gates.blocked || gates.verdict === 'SKIP') return;

  // Score, breakdown, reasoning
  const score     = buildAbcScore(pineClass, conditions, crowdGate, dailyAligned);
  const breakdown = buildAbcBreakdown(conditions, crowdGate, dailyAligned);
  const reasoning = buildAbcReasoning(pineClass, direction, sym, crowdGate,
                                       conditions, dailyDirection, fxssiData, score);

  // Expiry
  const expiryHours = cfg?.type?.includes('forex') ? 4 : cfg?.type?.includes('crypto') ? 8 : 6;
  const expiresAt = Date.now() + expiryHours * 3600000;

  // Save
  const signalId = db.insertAbcSignal({
    symbol: sym, direction, pineClass, score,
    verdict: gates.verdict, entry, sl, tp,
    rr: gates.rr || rr, session,
    reasoning, breakdown: JSON.stringify(breakdown),
    expiresAt,
    fxssiStale: !fxssiData, crowdGate,
    abcVersion: ABC_VERSION,
    obTop, obBot, preBosSwing,
    rawPayload: JSON.stringify(data)
  });

  if (!signalId) { console.log(`[ABC] ${sym} — failed to save`); return; }
  console.log(`[ABC] Saved to abc_signals id:${signalId}`);

  // Telegram — A+B to swing channel
  if (pineClass === 'A' || pineClass === 'B') {
    sendAbcSignalAlert({
      symbol: sym, direction, pineClass, score,
      verdict: gates.verdict, entry, sl, tp,
      rr: gates.rr || rr, session, reasoning
    }).catch(e => console.error('[Telegram] ABC alert error:', e.message));
  }

  // WebSocket
  broadcast({
    type: 'ABC_SIGNAL', signalId, symbol: sym, direction, pineClass,
    verdict: gates.verdict, entry, sl, tp,
    rr: gates.rr || rr, score, session, reasoning, ts: Date.now()
  });
}

// ── Calculate daily bias from existing market_data ──────────────────────────
// No separate Pine script needed — reads ema200, bias, close from market_data
function calculateDailyBias(symbol, db) {
  try {
    const md = db.getLatestMarketData(symbol);
    if (!md || !md.close) return 'MIXED';

    const close = md.close;
    const ema200 = md.ema200;
    const bias = md.bias || 0;

    let direction = 'MIXED';
    if (close > ema200 && bias >= 1) direction = 'BULL';
    else if (close < ema200 && bias <= -1) direction = 'BEAR';

    // Store in daily_bias table for stats/debug
    db.upsertDailyBias(symbol, {
      direction,
      close,
      ema200: ema200 || null,
      aboveCloud: 0,
      ts: Date.now()
    });

    return direction;
  } catch(e) {
    return 'MIXED';
  }
}

module.exports = { processAbcWebhook, calculateDailyBias, getAbcDp, ABC_VERSION };
