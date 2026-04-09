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
  const entry = Math.round(parseFloat(data.entry) * dp) / dp;
  const sl    = Math.round(parseFloat(data.sl)    * dp) / dp;
  const tp    = Math.round(parseFloat(data.tp)    * dp) / dp;
  const rr    = parseFloat(data.rr) || null;

  if (!entry || !sl || !tp) { console.log(`[ABC] ${sym} — missing entry/sl/tp`); return; }

  // Parse OB / swing levels from Pine payload — old payloads won't have these
  const obTop       = data.obTop != null ? Math.round(parseFloat(data.obTop) * dp) / dp : null;
  const obBot       = data.obBot != null ? Math.round(parseFloat(data.obBot) * dp) / dp : null;
  const preBosSwing = data.preBosSwing != null ? Math.round(parseFloat(data.preBosSwing) * dp) / dp : null;

  // Parse condition flags — default false for old payloads
  const conditions = {
    cloudPass:    !!data.cloudPass,
    obPresent:    !!data.obPresent,
    pullbackIn:   !!data.pullbackIn,
    rsiDiv:       !!data.rsiDiv,
    volConfirmed: !!data.volConfirmed,
    rejStrong:    !!data.rejStrong
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

  // Daily bias
  let dailyAligned = false;
  let dailyDirection = null;
  try {
    const bias = db.getDailyBias(sym);
    if (bias) {
      dailyDirection = bias.direction;
      dailyAligned = (direction === 'LONG' && dailyDirection === 'BULL') ||
                     (direction === 'SHORT' && dailyDirection === 'BEAR');
    }
  } catch(e) {}

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
      entry, sl, tp1: tp, tp2: tp, tp3: tp, rr,
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

// ── Process daily bias webhook ──────────────────────────────────────────────
function processDailyBiasWebhook(data, deps) {
  const { db } = deps;

  if (!data || !Object.keys(data).length) { console.log('[Daily Bias] Empty body — skipping'); return; }

  const rawSym = data.symbol || data.ticker || null;
  if (!rawSym) { console.log('[Daily Bias] No symbol'); return; }
  const sym = normalizeSymbol(rawSym);

  const direction = (data.direction || '').toUpperCase();
  if (!['BULL','BEAR','MIXED'].includes(direction)) {
    console.log(`[Daily Bias] ${sym} — invalid direction: ${direction}`); return;
  }

  db.upsertDailyBias(sym, {
    direction,
    close:      data.close || null,
    ema200:     data.ema200 || null,
    aboveCloud: !!data.aboveCloud,
    ts:         data.ts || Date.now()
  });

  console.log(`[Daily Bias] ${sym} → ${direction}`);
}

module.exports = { processAbcWebhook, processDailyBiasWebhook, getAbcDp, ABC_VERSION };
