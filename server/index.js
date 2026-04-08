console.log('[Startup] 1 — process started', Date.now());
require('dotenv').config();
const express = require('express');
const compression = require('compression');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const { upsertMarketData, getAllSignals, getWeights, getLearningLog, updateOutcome, updatePaperOutcome, getPaperTradeStats, retireActiveCycle, getCurrentCycleSignals, getPastCycleSignals } = db;
const { isMarketOpen, getMarketStatus } = require('./marketHours');
const { scoreAllPriority, saveSignal } = require('./scorer');
const { checkOutcomes } = require('./outcome');
const { runLearningCycle } = require('./learner');
const claudeLearner = require('./claudeLearner');
const { runFXSSIScrape, processBridgePayload, getFxssiCacheAge } = require('./fxssiScraper');
const { runCOTFetch, getLatestCOT, getCOTSummary, getCOTCurrencies } = require('./cotFetcher');
const { runRateFetch, loadRatesFromDB, getLatestRates, getRateDifferential } = require('./rateFetcher');
const { getUpcomingMeetings, isPairEventRisk, getMeetingContext } = require('./centralBankCalendar');
const { sendSignalAlert, sendRecAlert, sendMorningBrief, sendHealthAlert, sendTest, sendAbcSignalAlert } = require('./telegram');
const { runCalendarCheck, runCalendarFetch, isPreEventRisk, isPostEventSuppressed, getUpcomingHighImpactEvents } = require('./forexCalendar');
const { collectFullHistory, collectRecentHistory, querySnapshot, cancelCollection, isCollecting } = require('./fxssi-history-collector');
const { runAbcGates } = require('./abcGates');
const { SYMBOLS } = require('./config');

console.log('[Startup] 2 — modules loaded', Date.now());

const app = express();
const server = http.createServer((req, res) => {
  // Intercept webhook POSTs at HTTP level — respond 200 BEFORE Express touches them
  // This guarantees TradingView gets 200 OK in <1ms regardless of server load
  if (req.method === 'POST' && req.url.startsWith('/webhook/')) {
    // Send 200 immediately — before reading body, before any middleware
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    // Read body async — stream is still open even after response sent
    // because we used res.end() on the RESPONSE, not closed the REQUEST stream
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      let parsed = {};
      try {
        const sanitized = body
          .replace(/:NaN([,}\]])/g, ':null$1')
          .replace(/: NaN([,}\]])/g, ':null$1')
          .replace(/:NaN$/g, ':null')
          .replace(/:Infinity/g, ':null')
          .replace(/:-Infinity/g, ':null');
        parsed = JSON.parse(sanitized);
      } catch(e) { parsed = {}; }

      // Route to correct handler
      if (req.url === '/webhook/pine') {
        try { processPineWebhook(parsed); }
        catch(e) { console.error('[Webhook] Pine error:', e.message); }
      } else if (req.url === '/webhook/pine-abc') {
        try { processAbcWebhook(parsed); }
        catch(e) { console.error('[Webhook] ABC error:', e.message); }
      } else if (req.url === '/webhook/fxssi') {
        try { processFxssiWebhook(parsed); }
        catch(e) { console.error('[Webhook] FXSSI error:', e.message); }
      } else if (req.url === '/webhook/fxssi-rich') {
        try { processFxssiRichWebhook(parsed); }
        catch(e) { console.error('[Webhook] FXSSI-rich error:', e.message); }
      }
    });
    return; // Don't pass to Express
  }

  // All non-webhook requests go through Express normally
  app(req, res);
});
const wss = new WebSocket.Server({ noServer: true });

// Handle WS upgrade with error protection
server.on('upgrade', (req, socket, head) => {
  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } catch(e) {
    console.error('[WS] Upgrade error:', e.message);
    socket.destroy();
  }
});

// WebSocket keepalive — prevents Railway from dropping idle connections
setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.ping();
  });
}, 30000);

// DB ready flag — webhook queues until DB is initialised
let dbReady = false;

// Custom body parser that handles Pine Script's invalid NaN values
// Body parser — sanitize NaN/Infinity BEFORE JSON.parse (TradingView sends these)
// This is the original working parser. express.json() cannot handle NaN literals.
// Parses body for ALL POST routes including webhooks. Webhook handlers respond
// 200 OK immediately after parsing completes (~5ms), then process async.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', () => {
    try {
      const sanitized = body
        .replace(/:NaN([,}\]])/g, ':null$1')
        .replace(/: NaN([,}\]])/g, ':null$1')
        .replace(/:NaN$/g, ':null')
        .replace(/:Infinity/g, ':null')
        .replace(/:-Infinity/g, ':null');
      req.body = JSON.parse(sanitized);
    } catch(e) {
      req.body = {};
    }
    next();
  });
});
// Gzip/deflate compression — 156KB HTML → ~30KB over the wire
app.use(compression());
app.use(express.static(path.join(__dirname, '../client'), {
  maxAge: '10m',              // cache static assets for 10 minutes
  etag: true
}));

console.log('[Startup] 3 — Express + WS ready', Date.now());

// Fast health endpoint — no DB calls, responds in <5ms
// Railway health checks hit this to determine if the service is up
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), uptime: process.uptime() });
});

// ── WebSocket broadcast ──────────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', ws => {
  console.log('[WS] Client connected, dbReady=' + dbReady);

  function sendInit() {
    if (!dbReady) { setTimeout(sendInit, 500); return; }
    try {
      const signals     = db.getAllSignals(100);
      const pastSignals = db.getPastCycleSignals(200);
      console.log('[WS] Sending INIT: signals=' + signals.length + ' past=' + pastSignals.length);
      ws.send(JSON.stringify({ type: 'INIT', signals, pastSignals, symbols: Object.keys(SYMBOLS) }));
    } catch(e) {
      console.error('[WS] INIT error:', e.message);
      ws.send(JSON.stringify({ type: 'INIT', signals: [], pastSignals: [], symbols: Object.keys(SYMBOLS) }));
    }
  }

  sendInit();
});

// ── Webhook handlers ────────────────────────────────────────────────────────
// Pine/FXSSI webhooks are intercepted at HTTP level (see http.createServer above)
// They respond 200 BEFORE Express middleware runs. These Express routes are kept
// as fallback only — the HTTP handler should catch them first.

function processPineWebhook(data) {
  if (!data || !Object.keys(data).length) { console.log('[Webhook] Empty body — skipping'); return; }
  const sym0 = data.symbol || data.ticker || 'unknown';
  console.log(`[Webhook] ${sym0} received`);
  if (!dbReady) { console.log(`[Webhook] ${sym0} — DB not ready, skipping`); return; }
  const ws = process.env.WEBHOOK_SECRET;
  if (ws && data.secret !== ws) {
    console.warn(`[Webhook] ${sym0} — Auth failed. WEBHOOK_SECRET is set but payload secret=${data.secret ? 'wrong' : 'missing'}. Clear env var to disable.`);
    return;
  }
  const rawSym = data.symbol || data.ticker || null;
  if (!rawSym) { console.log('[Webhook] No symbol field in body'); return; }
  const sym = rawSym.toUpperCase()
    .replace('XAUUSD','GOLD').replace('XAGUSD','SILVER')
    .replace('USOIL','OILWTI').replace('WTI','OILWTI').replace('OIL_CRUDE','OILWTI')
    .replace('SPX500USD','US500').replace('ETHUSDT','ETHUSD')
    .replace('NAS100USD','US100').replace('DE30EUR','DE40')
    .replace('UK100GBP','UK100').replace('JP225USD','J225')
    .replace('HK50USD','HK50').replace('CN50USD','CN50');

  // DXY — reference signal only, do not score
  if (sym === 'DXY') {
    try {
      // bias may arrive as number or object {score, bull, bear} from Pine
      const rawBias = typeof data.bias === 'object' && data.bias !== null ? data.bias.score : data.bias;
      const biasNum = Number(rawBias) || 0;
      const trend = biasNum > 0 ? 'bullish' : biasNum < 0 ? 'bearish' : 'neutral';
      const close = data.close || data.price;
      if (close == null) { console.warn('[Webhook] DXY missing close/price:', JSON.stringify(data)); return; }
      db.upsertDXY({ close, bias: biasNum, ema_score: data.biasScore || 0, trend });
      console.log(`[Webhook] DXY reference updated: ${close} bias:${biasNum} trend:${trend}`);
    } catch(e) { console.error('[Webhook] DXY error:', e.message); }
    return;
  }

  if (!SYMBOLS[sym]) { console.log('[Webhook] Not in priority list:', sym); return; }
  if (!isMarketOpen(sym)) { console.log(`[Webhook] ${sym} — market closed, skipping`); return; }

  // Map ATLAS//FIVE fields → watchlist fields
  const price   = data.price  || data.close;
  const ema200  = data.ema200 ? (typeof data.ema200 === 'object' ? data.ema200['1d'] || data.ema200['4h'] || data.ema200['1h'] : data.ema200) : null;
  const rsi     = data.rsi    ? (typeof data.rsi    === 'object' ? data.rsi['5m']   || data.rsi['1h']   : data.rsi)    : null;
  const vwap    = data.vwap   ? (typeof data.vwap   === 'object' ? data.vwap.mid    || data.vwap.upper1  : data.vwap)   : null;

  let bias = 0;
  if (data.bias !== null && data.bias !== undefined) {
    if (typeof data.bias === 'object') {
      bias = data.bias.score || (data.bias.bear ? -3 : data.bias.bull ? 3 : 0);
    } else {
      bias = Number(data.bias) || 0;
    }
  } else if (data.emaDir) {
    const d = data.emaDir;
    bias = (typeof d === 'object') ? ((d['5m']||0) + (d['1h']||0) + (d['4h']||0)) : Number(d) || 0;
  }

  let fvg = false, fvgHigh = null, fvgLow = null, fvgMid = null;
  if (data.fvg && typeof data.fvg === 'object') {
    fvg = data.fvg.bullActive || data.fvg.bearActive || false;
    if (bias < 0 && data.fvg.bearActive) { fvgHigh = data.fvg.bearTop; fvgLow = data.fvg.bearBot; fvgMid = data.fvg.bearMid; }
    else if (bias > 0 && data.fvg.bullActive) { fvgHigh = data.fvg.bullTop; fvgLow = data.fvg.bullBot; fvgMid = data.fvg.bullMid; }
  } else {
    fvg = data.fvgPresent || false;
    fvgHigh = data.fvgHigh || null; fvgLow = data.fvgLow || null; fvgMid = data.fvgMid || null;
  }

  const rawStructureObj = (data.structure && typeof data.structure === 'object') ? data.structure : null;
  let structure = data.structure || 'ranging';
  if (typeof structure === 'object') structure = structure.bull ? 'bullish' : structure.bear ? 'bearish' : 'ranging';

  const macdHist = data.macd ? (data.macd.hist || data.macd.histogram || null) : (data.macdHist || null);
  const atr1h = data.atr ? (data.atr['1h'] || data.atr['4h'] || null) : null;
  const aboveUpper2 = data.vwap?.aboveUpper2 || false;
  const belowLower2 = data.vwap?.belowLower2 || false;
  const momScore = data.momScore != null ? Number(data.momScore) : null;

  const existing = require('./db').getLatestMarketData(sym);
  upsertMarketData(sym, {
    close: price, high: data.high, low: data.low, volume: data.volume,
    ema200, vwap, rsi, macdHist, bias,
    biasScore: data.biasScore || Math.abs(bias) / 3,
    structure, fvgPresent: fvg, fvgHigh, fvgLow, fvgMid,
    fxssiLongPct:  data.fxssiLongPct  || existing?.fxssi_long_pct  || null,
    fxssiShortPct: data.fxssiShortPct || existing?.fxssi_short_pct || null,
    fxssiTrapped:  data.fxssiTrapped  || existing?.fxssi_trapped   || null,
    obAbsorption:  data.obAbsorption  || existing?.ob_absorption   || false,
    obImbalance:   data.obImbalance   || existing?.ob_imbalance    || 0,
    obLargeOrders: data.obLargeOrders || existing?.ob_large_orders || false,
    fxssiAnalysis: existing?.fxssi_analysis || null,
    rawExtra: {
      momScore, structure: rawStructureObj,
      rsi: data.rsi && typeof data.rsi === 'object' ? data.rsi : null,
      rangeHigh: data.rangeHigh || null, rangeLow: data.rangeLow || null,
      sr: { resistance: data.sr?.resistance, support: data.sr?.support,
            swingH1: data.sr?.swingH1, swingH2: data.sr?.swingH2,
            swingL1: data.sr?.swingL1, swingL2: data.sr?.swingL2 },
      atr: data.atr || atr1h,
      vwap: { mid: vwap, upper1: data.vwap?.upper1, lower1: data.vwap?.lower1,
              upper2: data.vwap?.upper2, lower2: data.vwap?.lower2, aboveUpper2, belowLower2 }
    }
  });

  const check = require('./db').getLatestMarketData(sym);
  console.log('[Webhook] ' + sym + ':', check ? 'SAVED @ ' + check.close : 'FAILED');
  broadcast({ type: 'MARKET_UPDATE', symbol: sym, close: price, ts: Date.now() });
}

// ── Webhook: ABC Pine signals ────────────────────────────────────────────────
function processAbcWebhook(data) {
  if (!data || !Object.keys(data).length) { console.log('[ABC] Empty body — skipping'); return; }
  if (!dbReady) { console.log('[ABC] DB not ready — skipping'); return; }

  const ws = process.env.WEBHOOK_SECRET;
  if (ws && data.secret !== ws) { console.warn('[ABC] Auth failed'); return; }

  const rawSym = data.symbol || data.ticker || null;
  if (!rawSym) { console.log('[ABC] No symbol'); return; }
  const sym = rawSym.toUpperCase()
    .replace('XAUUSD','GOLD').replace('XAGUSD','SILVER')
    .replace('USOIL','OILWTI').replace('WTI','OILWTI').replace('OIL_CRUDE','OILWTI')
    .replace('SPX500USD','US500').replace('ETHUSDT','ETHUSD')
    .replace('NAS100USD','US100').replace('DE30EUR','DE40')
    .replace('UK100GBP','UK100').replace('JP225USD','J225')
    .replace('HK50USD','HK50').replace('CN50USD','CN50');

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
  const dp = cfg?.type?.includes('forex') ? 10000 : cfg?.type?.includes('index') ? 100 : 1000;
  const entry = Math.round(parseFloat(data.entry) * dp) / dp;
  const sl    = Math.round(parseFloat(data.sl)    * dp) / dp;
  const tp    = Math.round(parseFloat(data.tp)    * dp) / dp;
  const rr    = parseFloat(data.rr) || null;
  const score = parseInt(data.score) || (pineClass === 'A' ? 88 : pineClass === 'B' ? 75 : 62);

  if (!entry || !sl || !tp) { console.log(`[ABC] ${sym} — missing entry/sl/tp`); return; }

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

  // Get FXSSI data
  const fxssiData = (() => {
    try {
      const md = db.getLatestMarketData(sym);
      if (!md) return null;
      return {
        fxssi_long_pct:  md.fxssi_long_pct,
        fxssi_short_pct: md.fxssi_short_pct,
        fxssi_trapped:   md.fxssi_trapped,
        gravity_price:   md.gravity_price
      };
    } catch(e) { return null; }
  })();

  // Compute fxssi_gate for stats tracking
  const fxssiGate = !fxssiData || fxssiData.fxssi_trapped == null ? 'NO_DATA'
    : ((direction === 'LONG'  && fxssiData.fxssi_trapped === 'SHORT') ||
       (direction === 'SHORT' && fxssiData.fxssi_trapped === 'LONG'))  ? 'ALIGNED' : 'MISALIGNED';

  // Run gates
  const payload = { pineClass, direction, entry, sl, tp, rr };
  const gates   = runAbcGates(sym, payload, fxssiData, db);

  console.log(`[ABC] ${sym} ${direction} Class${pineClass} → ${gates.verdict} | ${gates.reason}`);

  if (gates.blocked || gates.verdict === 'SKIP') return;

  // Expiry
  const expiryHours = cfg?.type?.includes('forex') ? 4 : cfg?.type?.includes('crypto') ? 8 : 6;
  const expiresAt = Date.now() + expiryHours * 3600000;

  const { getSessionNow } = require('./config');
  const session = getSessionNow ? getSessionNow() : 'unknown';

  // Save
  const signalId = db.insertAbcSignal({
    symbol: sym, direction, pineClass, score,
    verdict: gates.verdict, entry, sl, tp,
    rr: gates.rr || rr, session,
    reasoning: gates.reason, expiresAt,
    fxssiStale: !fxssiData, fxssiGate, rawPayload: JSON.stringify(data)
  });

  if (!signalId) { console.log(`[ABC] ${sym} — failed to save`); return; }
  console.log(`[ABC] Saved to abc_signals id:${signalId}`);

  // Telegram — A+B to swing channel
  if (pineClass === 'A' || pineClass === 'B') {
    sendAbcSignalAlert({
      symbol: sym, direction, pineClass, score,
      verdict: gates.verdict, entry, sl, tp,
      rr: gates.rr || rr, session, reasoning: gates.reason
    }).catch(e => console.error('[Telegram] ABC alert error:', e.message));
  }

  // WebSocket
  broadcast({
    type: 'ABC_SIGNAL', signalId, symbol: sym, direction, pineClass,
    verdict: gates.verdict, entry, sl, tp,
    rr: gates.rr || rr, score, session, reasoning: gates.reason, ts: Date.now()
  });
}

// ── Webhook: FXSSI manual paste ──────────────────────────────────────────────
function processFxssiWebhook(data) {
  if (!data || !data.symbol) return;
  const sym = data.symbol.toUpperCase();
  const latest = require('./db').getLatestMarketData(sym);
  if (latest) {
    upsertMarketData(sym, {
      close: latest.close, high: latest.high, low: latest.low, volume: latest.volume,
      ema200: latest.ema200, vwap: latest.vwap, rsi: latest.rsi, macdHist: latest.macd_hist,
      bias: latest.bias, biasScore: latest.bias_score, structure: latest.structure,
      fvgPresent: latest.fvg_present === 1,
      fvgHigh: latest.fvg_high, fvgLow: latest.fvg_low, fvgMid: latest.fvg_mid,
      fxssiLongPct: data.longPct, fxssiShortPct: data.shortPct, fxssiTrapped: data.trapped,
      obAbsorption: latest.ob_absorption, obImbalance: latest.ob_imbalance,
      obLargeOrders: latest.ob_large_orders, fxssiAnalysis: latest.fxssi_analysis
    });
    console.log(`[Webhook] FXSSI ${sym} updated`);
  }
}

// ── REST API ─────────────────────────────────────────────────────────────────
// Returns saved signals + latest scoring results for immediate dashboard render
// Cache last scoring results for instant HTTP response
let _lastScoringResults = [];

app.get('/api/signals', (req, res) => {
  try {
    const saved = db.getAllSignals(100);
    if (saved.length > 0) {
      console.log(`[/api/signals] returning ${saved.length} saved signals`);
      return res.json(saved);
    }
    // No saved signals — return cached scoring results (populated by cron)
    if (_lastScoringResults.length > 0) {
      console.log(`[/api/signals] returning ${_lastScoringResults.length} cached scoring results`);
      return res.json(_lastScoringResults);
    }
    console.log('[/api/signals] no data available yet');
    res.json([]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// EMERGENCY: reset all signal cycles back to 0 so they reappear on main board
app.post('/api/reset-cycles', (req, res) => {
  try {
    db.run('UPDATE signals SET cycle=0, retired_at=NULL');
    db.persist();
    const count = db.getAllSignals(200).length;
    res.json({ ok: true, message: `Reset cycle=0 on all signals`, count });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Debug: show DB state
app.get('/api/debug', (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  try {
    const now = Date.now();
    const report = {};

    // ── 1. PINE DATA FRESHNESS ──
    const pineCheck = {};
    let isBankHolidayFn;
    try { isBankHolidayFn = require('./marketHours').isBankHoliday; } catch(e) {}

    for (const sym of Object.keys(SYMBOLS)) {
      try {
        const md = db.getLatestMarketData(sym);
        if (!md) { pineCheck[sym] = 'NO_DATA'; continue; }
        const ageMin = Math.round((now - md.ts) / 60000);
        const market = isMarketOpen(sym);
        const holiday = isBankHolidayFn ? isBankHolidayFn(sym) : false;
        pineCheck[sym] = { ageMin, stale: market && !holiday && ageMin > 5, marketOpen: market, holiday };
      } catch(e) { pineCheck[sym] = 'ERROR'; }
    }
    const staleSyms = Object.entries(pineCheck).filter(([,v]) => v.stale).map(([k]) => k);
    const holidaySyms = Object.entries(pineCheck).filter(([,v]) => typeof v === 'object' && v.holiday).map(([k]) => k);
    const missingPine = Object.entries(pineCheck)
      .filter(([,v]) => typeof v === 'object' && v.ageMin > 500 && !v.holiday)
      .map(([k]) => k);
    report.pine = {
      ok: staleSyms.length === 0,
      staleCount: staleSyms.length,
      staleSymbols: staleSyms,
      holidaySymbols: holidaySyms,
      missingPineAlerts: missingPine,
      maxAgeMin: Math.max(0, ...Object.values(pineCheck).filter(v => typeof v === 'object').map(v => v.ageMin || 0))
    };

    // ── 2. FXSSI FRESHNESS ──
    const fxssiStale = [];
    for (const sym of Object.keys(SYMBOLS)) {
      if (SYMBOLS[sym].noOrderBook) continue;
      try {
        const md = db.getLatestMarketData(sym);
        if (!md?.fxssi_analysis) continue;
        const fa = JSON.parse(md.fxssi_analysis);
        const ageMin = fa.fetchedAt ? Math.round((now - fa.fetchedAt) / 60000) : 999;
        if (ageMin > 25) fxssiStale.push({ symbol: sym, ageMin });
      } catch(e) {}
    }
    report.fxssi = { ok: fxssiStale.length === 0, staleCount: fxssiStale.length, staleSymbols: fxssiStale };

    // ── 3. SIGNAL QUALITY ──
    const signals = db.getAllSignals(50).filter(s => ['ACTIVE', 'OPEN'].includes(s.outcome));
    const zeroSL = signals.filter(s => Math.abs((s.sl || 0) - (s.entry || 0)) < 0.0001);
    const nullBreakdown = signals.filter(s => !s.breakdown || s.breakdown === 'null');
    const noMacro = signals.filter(s => !s.macro_context_available);
    const lowRR = signals.filter(s => s.verdict === 'PROCEED' && (s.rr || 0) < 2.0);
    const corr = {};
    signals.filter(s => s.outcome === 'ACTIVE').forEach(s => {
      corr[s.direction] = corr[s.direction] || [];
      corr[s.direction].push(s.symbol);
    });
    report.signals = {
      ok: zeroSL.length === 0 && lowRR.length === 0,
      total: signals.length,
      active: signals.filter(s => s.outcome === 'ACTIVE').length,
      zeroSL: zeroSL.map(s => s.symbol),
      nullBreakdown: nullBreakdown.length,
      noMacro: noMacro.map(s => s.symbol),
      lowRR: lowRR.map(s => ({ symbol: s.symbol, rr: s.rr })),
      correlatedLong: corr['LONG'] || [],
      correlatedShort: corr['SHORT'] || []
    };

    // ── 4. MACRO CONTEXT ──
    const macroCtx = db.getStoredMacroContext() || {};
    const macroKeys = Object.keys(macroCtx);
    const macroAge = macroKeys.length ? Math.round((now - macroCtx[macroKeys[0]].ts) / 3600000) : null;
    report.macro = {
      ok: macroKeys.length > 0 && macroAge !== null && macroAge < 26,
      symbolCount: macroKeys.length,
      ageHours: macroAge,
      stale: macroAge > 20 || macroKeys.length === 0,
      symbols: macroKeys.reduce((acc, k) => {
        acc[k] = { sentiment: macroCtx[k].sentiment, strength: macroCtx[k].strength };
        return acc;
      }, {})
    };

    // ── 5. CALENDAR ──
    const events = (db.getAllEconomicEvents() || []).filter(e => e.event_date >= new Date(now - 86400000).toISOString().slice(0, 10)).slice(0, 20);
    const pastNotFired = events.filter(e => {
      const eTs = new Date(e.event_date + 'T' + (e.event_time || '00:00:00') + 'Z').getTime();
      return eTs < now && !e.fired && !e.actual;
    });
    report.calendar = {
      ok: pastNotFired.length === 0,
      totalEvents: events.length,
      pastNotFired: pastNotFired.map(e => ({ title: e.title, time: e.event_time, date: e.event_date })),
      upcoming: events
        .filter(e => {
          const eTs = new Date(e.event_date + 'T' + (e.event_time || '00:00:00') + 'Z').getTime();
          return eTs > now && !e.fired;
        })
        .slice(0, 5)
        .map(e => {
          const eTs = new Date(e.event_date + 'T' + (e.event_time || '00:00:00') + 'Z').getTime();
          const minsUntil = Math.round((eTs - now) / 60000);
          let uaeTime = '';
          try { uaeTime = new Date(eTs).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit' }); } catch(e) {}
          return { title: e.title, utcTime: e.event_time, uaeTime, minsUntil, forecast: e.forecast, previous: e.previous };
        })
    };

    // ── 6. MARKET INTEL ──
    const intel = db.getActiveIntel();
    report.intel = {
      ok: true, count: intel.length,
      items: intel.map(i => ({
        bias: i.bias, horizon: i.time_horizon,
        summary: (i.summary || '').slice(0, 60),
        symbols: (() => { try { return JSON.parse(i.affected_symbols || '[]'); } catch(e) { return []; } })(),
        expiresInHours: Math.round((i.expires_at - now) / 3600000)
      }))
    };

    // ── 7. DB HEALTH ──
    const allSignals = db.getAllSignals(1000);
    const closedSignals = allSignals.filter(s => ['WIN', 'LOSS'].includes(s.outcome));
    report.database = {
      ok: true,
      totalSignals: allSignals.length,
      closedSignals: closedSignals.length,
      wins: closedSignals.filter(s => s.outcome === 'WIN').length,
      losses: closedSignals.filter(s => s.outcome === 'LOSS').length,
      nullCategory: closedSignals.filter(s => !s.outcome_category).length,
      learningReady: closedSignals.length >= 20
    };

    // ── 8. API COSTS ──
    const learningLog = db.getLearningLog(5);
    report.api = {
      lastLearningCycle: learningLog[0]?.ts ? new Date(learningLog[0].ts).toISOString() : 'never',
      learningCycles: learningLog.length
    };

    // ── 9. WEBHOOK HEALTH ──
    const webhookHealth = {};
    let timeoutCount = 0;
    for (const sym of Object.keys(SYMBOLS)) {
      const md = db.getLatestMarketData(sym);
      if (md) {
        const ageMin = Math.round((now - md.ts) / 60000);
        if (ageMin > 5 && isMarketOpen(sym)) {
          webhookHealth[sym] = 'STALE_' + ageMin + 'm';
          timeoutCount++;
        }
      }
    }
    report.webhooks = { ok: timeoutCount === 0, staleCount: timeoutCount, staleSymbols: webhookHealth };

    // ── OVERALL SCORE ──
    const checks = [report.pine.ok, report.fxssi.ok, report.signals.ok, report.macro.ok, report.calendar.ok, report.database.ok, report.webhooks.ok];
    const score = Math.round(checks.filter(Boolean).length / checks.length * 100);
    report.overall = {
      score: score + '%',
      status: score === 100 ? 'HEALTHY' : score >= 70 ? 'DEGRADED' : 'CRITICAL',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      issues: [
        !report.pine.ok && `Pine stale: ${staleSyms.join(', ')}`,
        !report.fxssi.ok && `FXSSI stale: ${report.fxssi.staleCount} symbols`,
        zeroSL.length > 0 && `Zero SL: ${zeroSL.map(s => s.symbol).join(', ')}`,
        lowRR.length > 0 && `Low R:R PROCEEDs: ${lowRR.map(s => s.symbol).join(', ')}`,
        macroKeys.length === 0 && 'Macro context empty — no symbols loaded',
        report.macro.stale && macroKeys.length > 0 && `Macro stale: ${macroAge}h`,
        !report.calendar.ok && `Events not fired: ${pastNotFired.map(e => e.title).join(', ')}`,
        (corr['LONG'] || []).length > 3 && `${corr['LONG'].length} correlated LONGs active`,
        (corr['SHORT'] || []).length > 3 && `${corr['SHORT'].length} correlated SHORTs active`,
      ].filter(Boolean)
    };

    res.json(report);
  } catch(e) {
    console.error('[Debug] Error:', e.message);
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 3) });
  }
});

app.get('/api/past-signals', (req, res) => {
  res.json(getPastCycleSignals(200));
});

app.get('/api/abc-signals', (req, res) => {
  try { res.json(db.getAbcSignals(200)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/abc-outcome', (req, res) => {
  const { id, outcome, pnl_pct, notes } = req.body || {};
  if (!id || !['WIN','LOSS'].includes(outcome)) return res.status(400).json({ error: 'Missing id or invalid outcome' });
  db.updateAbcOutcome(id, outcome, pnl_pct || null, notes || null);
  console.log(`[ABC] Outcome logged: id:${id} → ${outcome}`);
  if (broadcast) broadcast({ type: 'ABC_OUTCOME', signalId: id, outcome, ts: Date.now() });
  res.json({ ok: true });
});

app.get('/api/abc-stats', (req, res) => {
  try { res.json(db.getAbcStats()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/abc-ignore', (req, res) => {
  const { id, reason } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing id' });
  db.updateAbcOutcome(id, 'IGNORED', null, 'Not taken by trader' + (reason ? ' — ' + reason : ''));
  if (broadcast) broadcast({ type: 'ABC_OUTCOME', signalId: id, outcome: 'IGNORED', ts: Date.now() });
  res.json({ ok: true });
});

// Manual retirement trigger
app.post('/api/retire-now', async (req, res) => {
  await runRetirementCycle(broadcast);
  res.json({ ok: true, message: 'Retirement cycle complete' });
});

app.get('/api/weights', (req, res) => {
  const weights = {};
  for (const sym of Object.keys(SYMBOLS)) {
    weights[sym] = getWeights(sym);
  }
  res.json(weights);
});

app.get('/api/learning-log', (req, res) => {
  res.json(getLearningLog(30));
});

app.post('/api/outcome', (req, res) => {
  const { signalId, outcome } = req.body;
  if (!signalId || !outcome) return res.status(400).json({ error: 'Missing signalId or outcome' });
  updateOutcome(signalId, outcome, req.body.pnlPct || 0);
  broadcast({ type: 'OUTCOME_MANUAL', signalId, outcome, ts: Date.now() });
  res.json({ ok: true });
});

// Force close signal at current price — calculates real P&L
app.post('/api/signal-force-close', (req, res) => {
  const { id, reason } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const sig = db.getAllSignals(500).find(s => s.id === id);
  if (!sig) return res.status(404).json({ error: 'Signal not found' });
  const md = db.getLatestMarketData(sig.symbol);
  const currentPrice = md?.close || sig.entry;
  let pnl_pct = sig.direction === 'LONG'
    ? (currentPrice - sig.entry) / sig.entry * 100
    : (sig.entry - currentPrice) / sig.entry * 100;
  const outcome = pnl_pct >= 0 ? 'WIN' : 'LOSS';
  const rounded = Math.round(pnl_pct * 100) / 100;
  const notes = 'Force closed at ' + currentPrice + (reason ? ' — ' + reason : '');
  db.run("UPDATE signals SET outcome=?, outcome_ts=?, pnl_pct=?, outcome_category='FORCE_CLOSE', outcome_notes=? WHERE id=?",
    [outcome, Date.now(), rounded, notes, id]);
  db.persist();
  console.log(`[Signal] Force closed: ${sig.symbol} ${sig.direction} ${outcome} ${rounded}% at ${currentPrice}`);
  broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction: sig.direction, outcome, pnlPct: rounded, ts: Date.now() });
  res.json({ ok: true, outcome, pnl_pct: rounded, price: currentPrice });
});

// Ignore signal — not taken by trader, remove from dashboard
app.post('/api/signal-ignore', (req, res) => {
  const { id, reason } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const notes = 'Not taken by trader' + (reason ? ' — ' + reason : '');
  db.run("UPDATE signals SET outcome='EXPIRED', outcome_ts=?, outcome_category='IGNORED', outcome_notes=? WHERE id=?",
    [Date.now(), notes, id]);
  db.persist();
  broadcast({ type: 'OUTCOME', signalId: id, outcome: 'EXPIRED', ts: Date.now() });
  res.json({ ok: true });
});

app.get('/api/market-status', (req, res) => {
  res.json(getMarketStatus());
});

// Agent endpoint — runs Research, Predict, or Risk agent for a signal
app.post('/api/agent', async (req, res) => {
  const { type, prompt, symbol, accountSize } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    const tools = type === 'research' ? [{
      type: 'web_search_20250305',
      name: 'web_search'
    }] : undefined;

    const body = {
      model: 'claude-haiku-4-5-20251001', // Haiku — 20x cheaper for agents
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    };
    if (tools) body.tools = tools;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    // Extract text from content blocks (may include tool_use blocks for search)
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    console.log(`[Agent] ${type} for ${symbol} — ${text.length} chars`);
    res.json({ ok: true, result: text });
  } catch (e) {
    console.error('[Agent] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Manual FXSSI fetch trigger
app.get('/api/fxssi-fetch', async (req, res) => {
  try {
    process.env.FXSSI_FORCE_FETCH = '1';
    await runFXSSIScrape(broadcast);
    process.env.FXSSI_FORCE_FETCH = '0';
    res.json({ ok: true, message: 'FXSSI fetch complete' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// FXSSI historical data collection for backtesting
app.get('/api/fxssi-history/collect', (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  if (isCollecting()) return res.json({ error: 'Collection already in progress — use /api/fxssi-history/stop to cancel' });
  // Default to recent (72 offsets ~5min) — full (360 offsets ~38min) requires explicit ?mode=full
  const mode = req.query.mode === 'full' ? 'full' : 'recent';
  res.json({ started: true, mode });
  (mode === 'full' ? collectFullHistory() : collectRecentHistory())
    .then(r => console.log(`[FXSSI-Hist] ${mode} collection done:`, r))
    .catch(e => console.error(`[FXSSI-Hist] ${mode} collection error:`, e.message));
});

app.get('/api/fxssi-history/status', (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  try {
    const rows = db.getFxssiHistoryStatus();
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    res.json({ total, symbols: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fxssi-history/query', (req, res) => {
  const { symbol, timestamp } = req.query;
  if (!symbol || !timestamp) return res.status(400).json({ error: 'Missing symbol or timestamp' });
  try {
    const result = querySnapshot(symbol, Number(timestamp));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Backtest analysis — correlate trades with FXSSI historical snapshots
app.post('/api/backtest-analyze', (req, res) => {
  const trades = req.body;
  if (!Array.isArray(trades) || trades.length === 0) return res.status(400).json({ error: 'Expected array of trades' });

  const aligned = { count: 0, wins: 0, losses: 0 };
  const conflicted = { count: 0, wins: 0, losses: 0 };
  const neutral = { count: 0, wins: 0, losses: 0 };
  const lpAligned = { count: 0, wins: 0, losses: 0 };
  const lpConflicted = { count: 0, wins: 0, losses: 0 };
  const lpNeutral = { count: 0, wins: 0, losses: 0 };
  const trAligned = { count: 0, wins: 0, losses: 0 };
  const trConflicted = { count: 0, wins: 0, losses: 0 };
  const trNeutral = { count: 0, wins: 0, losses: 0 };
  const obImbAligned = { count: 0, wins: 0, losses: 0 };
  const obImbConflicted = { count: 0, wins: 0, losses: 0 };
  const obImbNeutral = { count: 0, wins: 0, losses: 0 };
  const absAligned = { count: 0, wins: 0, losses: 0 };
  const absConflicted = { count: 0, wins: 0, losses: 0 };
  const absNeutral = { count: 0, wins: 0, losses: 0 };
  const gravClose = { count: 0, wins: 0, losses: 0 };
  const gravMedium = { count: 0, wins: 0, losses: 0 };
  const gravFar = { count: 0, wins: 0, losses: 0 };
  const gravNone = { count: 0, wins: 0, losses: 0 };
  const gravBelow = { count: 0, wins: 0, losses: 0 };
  const gravAbove = { count: 0, wins: 0, losses: 0 };
  const gravAgainst = { count: 0, wins: 0, losses: 0 };
  const comboTrappedAbs = { count: 0, wins: 0, losses: 0 };
  const comboTrappedOb = { count: 0, wins: 0, losses: 0 };
  const comboTrappedGravFar = { count: 0, wins: 0, losses: 0 };
  const comboTrappedGravNotClose = { count: 0, wins: 0, losses: 0 };
  const gravCloseBlocked = { count: 0, wins: 0, losses: 0 };
  let noSnapshot = 0;
  const results = [];

  for (const trade of trades) {
    const ts = Math.floor(new Date(trade.entry_time).getTime() / 1000);
    const snap = querySnapshot(trade.symbol, ts);
    const isWin = trade.outcome === 'WIN';
    const isLoss = trade.outcome === 'LOSS';

    let alignment = 'no_snapshot';
    let fxssi_data = null;
    let lpAlignment = 'long_pct_neutral';

    // Debug first 3 trades
    if (results.length < 3) {
      console.log(`[backtest-analyze] trade ${results.length}: symbol=${trade.symbol} ts=${ts} snap.match=${!!snap.match} snap.reason=${snap.reason || 'none'} snap.rounded_to=${snap.rounded_to || 'n/a'} snap.fuzzy=${snap.fuzzy || false}`);
    }

    if (snap.match) {
      let fullAnalysis = null;
      try { fullAnalysis = typeof snap.match.full_analysis === 'string' ? JSON.parse(snap.match.full_analysis) : snap.match.full_analysis; } catch(e) {}

      const longPct = snap.match.long_pct ?? fullAnalysis?.longPct ?? null;
      const shortPct = snap.match.short_pct ?? fullAnalysis?.shortPct ?? null;
      // Recompute sentiment from long_pct/short_pct with tighter 52/53 thresholds
      const sent = longPct > 52 ? 'BEARISH' : (shortPct > 53 ? 'BULLISH' : 'NEUTRAL');

      if (results.length < 3) {
        console.log(`[backtest-analyze] trade ${results.length}: snapshot found=true sentiment=${sent} long_pct=${longPct} gravity_raw=${JSON.stringify(fullAnalysis?.gravity)}`);
      }

      // Extract trapped trader data from full_analysis JSON
      const inProfitPct = fullAnalysis?.inProfitPct ?? null;
      const inLossPct = fullAnalysis?.inLossPct ?? null;
      const buyersInProfitPct = fullAnalysis?.buyersInProfitPct ?? null;
      const sellersInProfitPct = fullAnalysis?.sellersInProfitPct ?? null;
      const losingClusters = fullAnalysis?.losingClusters || [];
      const nearestLosingCluster = losingClusters[0] || null;

      // gravity: row has scalar gravity_price; full_analysis has object {price,volume} or scalar
      const rawGrav = fullAnalysis?.gravity;
      const gravityPrice = (typeof rawGrav === 'object' && rawGrav !== null) ? rawGrav.price : (rawGrav ?? snap.match.gravity_price ?? null);

      fxssi_data = {
        snapshot_time: snap.match.snapshot_time,
        raw_sentiment: snap.match.sentiment,
        sentiment: sent,
        trapped: snap.match.trapped || fullAnalysis?.trapped || null,
        long_pct: longPct,
        short_pct: shortPct,
        gravity_price: gravityPrice,
        ob_imbalance: snap.match.ob_imbalance,
        gap_minutes: snap.gap_minutes,
        in_profit_pct: inProfitPct,
        in_loss_pct: inLossPct,
        buyers_in_profit_pct: buyersInProfitPct,
        sellers_in_profit_pct: sellersInProfitPct,
        losing_cluster_count: losingClusters.length,
        nearest_losing_cluster_price: nearestLosingCluster?.price || null
      };

      // Sentiment alignment
      if ((sent === 'BULLISH' && trade.direction === 'LONG') || (sent === 'BEARISH' && trade.direction === 'SHORT')) {
        alignment = 'aligned';
        aligned.count++; if (isWin) aligned.wins++; if (isLoss) aligned.losses++;
      } else if ((sent === 'BEARISH' && trade.direction === 'LONG') || (sent === 'BULLISH' && trade.direction === 'SHORT')) {
        alignment = 'conflicted';
        conflicted.count++; if (isWin) conflicted.wins++; if (isLoss) conflicted.losses++;
      } else {
        alignment = 'neutral';
        neutral.count++; if (isWin) neutral.wins++; if (isLoss) neutral.losses++;
      }

      // long_pct alignment (contrarian)
      if (longPct != null) {
        if ((trade.direction === 'SHORT' && longPct >= 52) || (trade.direction === 'LONG' && longPct <= 48)) {
          lpAlignment = 'long_pct_aligned';
          lpAligned.count++; if (isWin) lpAligned.wins++; if (isLoss) lpAligned.losses++;
        } else if ((trade.direction === 'SHORT' && longPct <= 48) || (trade.direction === 'LONG' && longPct >= 52)) {
          lpAlignment = 'long_pct_conflicted';
          lpConflicted.count++; if (isWin) lpConflicted.wins++; if (isLoss) lpConflicted.losses++;
        } else {
          lpNeutral.count++; if (isWin) lpNeutral.wins++; if (isLoss) lpNeutral.losses++;
        }
      }

      // Trapped trader alignment — who is losing and will capitulate?
      let trAlignment = 'trapped_neutral';
      if (buyersInProfitPct != null && sellersInProfitPct != null) {
        if ((trade.direction === 'SHORT' && buyersInProfitPct <= 35) || (trade.direction === 'LONG' && sellersInProfitPct <= 35)) {
          trAlignment = 'trapped_aligned';
          trAligned.count++; if (isWin) trAligned.wins++; if (isLoss) trAligned.losses++;
        } else if ((trade.direction === 'SHORT' && sellersInProfitPct <= 35) || (trade.direction === 'LONG' && buyersInProfitPct <= 35)) {
          trAlignment = 'trapped_conflicted';
          trConflicted.count++; if (isWin) trConflicted.wins++; if (isLoss) trConflicted.losses++;
        } else {
          trNeutral.count++; if (isWin) trNeutral.wins++; if (isLoss) trNeutral.losses++;
        }
      }
      fxssi_data.trapped_alignment = trAlignment;

      // OB Imbalance alignment
      const obImb = fullAnalysis?.obImbalance ?? snap.match.ob_imbalance ?? null;
      let obImbAlignment = 'ob_imbalance_neutral';
      if (obImb != null) {
        if ((trade.direction === 'LONG' && obImb >= 0.1) || (trade.direction === 'SHORT' && obImb <= -0.1)) {
          obImbAlignment = 'ob_imbalance_aligned';
          obImbAligned.count++; if (isWin) obImbAligned.wins++; if (isLoss) obImbAligned.losses++;
        } else if ((trade.direction === 'LONG' && obImb <= -0.1) || (trade.direction === 'SHORT' && obImb >= 0.1)) {
          obImbAlignment = 'ob_imbalance_conflicted';
          obImbConflicted.count++; if (isWin) obImbConflicted.wins++; if (isLoss) obImbConflicted.losses++;
        } else {
          obImbNeutral.count++; if (isWin) obImbNeutral.wins++; if (isLoss) obImbNeutral.losses++;
        }
      }
      fxssi_data.ob_imbalance_alignment = obImbAlignment;

      // Absorption alignment
      const absorption = fullAnalysis?.obAbsorption ?? (snap.match.ob_absorption === 1);
      let absAlignment = 'absorption_neutral';
      if (absorption) {
        if (trade.direction === 'LONG') {
          absAlignment = 'absorption_aligned';
          absAligned.count++; if (isWin) absAligned.wins++; if (isLoss) absAligned.losses++;
        } else {
          absAlignment = 'absorption_conflicted';
          absConflicted.count++; if (isWin) absConflicted.wins++; if (isLoss) absConflicted.losses++;
        }
      } else {
        absNeutral.count++; if (isWin) absNeutral.wins++; if (isLoss) absNeutral.losses++;
      }
      fxssi_data.absorption_alignment = absAlignment;

      // Gravity proximity + direction
      const gravPrice = gravityPrice;
      const entryPrice = Number(trade.entry_price) || Number(trade.entry) || Number(trade.price) || null;
      let gravProximity = 'gravity_none';
      let gravDirection = 'gravity_against';
      if (gravPrice && entryPrice) {
        const dist = Math.abs(entryPrice - gravPrice) / entryPrice * 100;
        if (dist <= 0.3) { gravProximity = 'gravity_close'; gravClose.count++; if (isWin) gravClose.wins++; if (isLoss) gravClose.losses++; }
        else if (dist <= 1.0) { gravProximity = 'gravity_medium'; gravMedium.count++; if (isWin) gravMedium.wins++; if (isLoss) gravMedium.losses++; }
        else { gravProximity = 'gravity_far'; gravFar.count++; if (isWin) gravFar.wins++; if (isLoss) gravFar.losses++; }

        if ((trade.direction === 'LONG' && gravPrice < entryPrice) || (trade.direction === 'SHORT' && gravPrice > entryPrice)) {
          gravDirection = trade.direction === 'LONG' ? 'gravity_below' : 'gravity_above';
          const b = trade.direction === 'LONG' ? gravBelow : gravAbove;
          b.count++; if (isWin) b.wins++; if (isLoss) b.losses++;
        } else {
          gravAgainst.count++; if (isWin) gravAgainst.wins++; if (isLoss) gravAgainst.losses++;
        }
      } else {
        gravNone.count++; if (isWin) gravNone.wins++; if (isLoss) gravNone.losses++;
      }
      fxssi_data.gravity_proximity = gravProximity;
      fxssi_data.gravity_direction = gravDirection;
      fxssi_data.gravity_price = gravPrice;

      // Combination analysis
      const isTrAligned = fxssi_data.trapped_alignment === 'trapped_aligned';
      const isAbsAligned = absAlignment === 'absorption_aligned';
      const isObAligned = obImbAlignment === 'ob_imbalance_aligned';
      if (isTrAligned && isAbsAligned) { comboTrappedAbs.count++; if (isWin) comboTrappedAbs.wins++; if (isLoss) comboTrappedAbs.losses++; }
      if (isTrAligned && isObAligned) { comboTrappedOb.count++; if (isWin) comboTrappedOb.wins++; if (isLoss) comboTrappedOb.losses++; }
      // Gravity distance combos
      const isGravFar = gravProximity === 'gravity_far';
      const isGravNotClose = gravProximity === 'gravity_far' || gravProximity === 'gravity_medium';
      const isGravClose = gravProximity === 'gravity_close';
      if (isTrAligned && isGravFar) { comboTrappedGravFar.count++; if (isWin) comboTrappedGravFar.wins++; if (isLoss) comboTrappedGravFar.losses++; }
      if (isTrAligned && isGravNotClose) { comboTrappedGravNotClose.count++; if (isWin) comboTrappedGravNotClose.wins++; if (isLoss) comboTrappedGravNotClose.losses++; }
      if (isGravClose) { gravCloseBlocked.count++; if (isWin) gravCloseBlocked.wins++; if (isLoss) gravCloseBlocked.losses++; }
    } else {
      noSnapshot++;
      if (results.length < 3) {
        console.log(`[backtest-analyze] trade ${results.length}: NO snapshot — reason=${snap.reason} rounded_to=${snap.rounded_to}`);
      }
    }

    results.push({ ...trade, fxssi_data, alignment, long_pct_alignment: lpAlignment, trapped_alignment: fxssi_data?.trapped_alignment || 'trapped_neutral', snapshot_reason: snap.reason || null });
  }

  const wr = (b) => b.count > 0 ? Math.round(b.wins / (b.wins + b.losses || 1) * 100) : null;
  res.json({
    total: trades.length,
    fxssi_aligned: { ...aligned, win_rate: wr(aligned) },
    fxssi_conflicted: { ...conflicted, win_rate: wr(conflicted) },
    fxssi_neutral: { ...neutral, win_rate: wr(neutral) },
    long_pct_aligned: { ...lpAligned, win_rate: wr(lpAligned) },
    long_pct_conflicted: { ...lpConflicted, win_rate: wr(lpConflicted) },
    long_pct_neutral: { ...lpNeutral, win_rate: wr(lpNeutral) },
    trapped_aligned: { ...trAligned, win_rate: wr(trAligned) },
    trapped_conflicted: { ...trConflicted, win_rate: wr(trConflicted) },
    trapped_neutral: { ...trNeutral, win_rate: wr(trNeutral) },
    ob_imbalance_aligned: { ...obImbAligned, win_rate: wr(obImbAligned) },
    ob_imbalance_conflicted: { ...obImbConflicted, win_rate: wr(obImbConflicted) },
    ob_imbalance_neutral: { ...obImbNeutral, win_rate: wr(obImbNeutral) },
    absorption_aligned: { ...absAligned, win_rate: wr(absAligned) },
    absorption_conflicted: { ...absConflicted, win_rate: wr(absConflicted) },
    absorption_neutral: { ...absNeutral, win_rate: wr(absNeutral) },
    gravity_close: { ...gravClose, win_rate: wr(gravClose) },
    gravity_medium: { ...gravMedium, win_rate: wr(gravMedium) },
    gravity_far: { ...gravFar, win_rate: wr(gravFar) },
    gravity_none: { ...gravNone, win_rate: wr(gravNone) },
    gravity_below: { ...gravBelow, win_rate: wr(gravBelow) },
    gravity_above: { ...gravAbove, win_rate: wr(gravAbove) },
    gravity_against: { ...gravAgainst, win_rate: wr(gravAgainst) },
    trapped_AND_absorption: { ...comboTrappedAbs, win_rate: wr(comboTrappedAbs) },
    trapped_AND_ob: { ...comboTrappedOb, win_rate: wr(comboTrappedOb) },
    trapped_AND_gravity_far: { ...comboTrappedGravFar, win_rate: wr(comboTrappedGravFar) },
    trapped_AND_gravity_not_close: { ...comboTrappedGravNotClose, win_rate: wr(comboTrappedGravNotClose) },
    gravity_close_blocked: { ...gravCloseBlocked, win_rate: wr(gravCloseBlocked) },
    no_snapshot: { count: noSnapshot },
    trades: results
  });
});

// Debug: sample raw fxssi_history rows to inspect sentiment values
app.get('/api/fxssi-history/sample', (req, res) => {
  try {
    const rows = db.run ? null : null; // use all() directly
    const samples = require('./db').isReady() ?
      (() => { const db2 = require('./db'); return [
        ...(['GOLD','EURUSD','GBPUSD'].flatMap(sym => {
          const r = db2.getFxssiHistorySnapshot(sym,
            (() => { const s = db2.getFxssiHistoryStatus().find(s => s.symbol === sym); return s ? s.latest : 0; })()
          );
          return r ? [{ symbol: sym, snapshot_time: r.snapshot_time, sentiment: r.sentiment, long_pct: r.long_pct, short_pct: r.short_pct, trapped: r.trapped }] : [];
        }))
      ]; })() : [];
    res.json({ samples });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug: full raw full_analysis JSON for 3 symbols
app.get('/api/fxssi-history/sample-full', (req, res) => {
  try {
    const samples = [];
    for (const sym of ['EURUSD', 'GOLD', 'GBPUSD']) {
      const status = db.getFxssiHistoryStatus().find(s => s.symbol === sym);
      if (!status) continue;
      const row = db.getFxssiHistorySnapshot(sym, status.latest);
      if (!row) continue;
      let parsed = null;
      try { parsed = typeof row.full_analysis === 'string' ? JSON.parse(row.full_analysis) : row.full_analysis; } catch(e) {}
      samples.push({
        symbol: sym,
        snapshot_time: row.snapshot_time,
        gravity_price_column: row.gravity_price,
        sr_wall_price_column: row.sr_wall_price,
        ob_imbalance_column: row.ob_imbalance,
        ob_absorption_column: row.ob_absorption,
        full_analysis: parsed
      });
    }
    res.json({ samples });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fxssi-history/stop', (req, res) => {
  if (!isCollecting()) return res.json({ stopped: false, reason: 'not_running' });
  cancelCollection();
  res.json({ stopped: true });
});

// Reset — wipe signals and market data, keep weights and schema
// Signals-only reset — clears trades but preserves market data (Pine + FXSSI)
// Use this when you want a clean slate without losing live order book data
// Watch signals — read-only endpoint for dashboard
app.get('/api/watch-signals', (req, res) => {
  try {
    const { getRecentWatchSignals } = require('./db');
    const watches = getRecentWatchSignals(100);
    res.json({ ok: true, signals: watches });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reset-signals', (req, res) => {
  try {
    const db = require('./db');
    db.run('DELETE FROM signals');
    db.run('DELETE FROM learning_log');
    db.persist();
    console.log('[Reset] Signals and learning log cleared — market data preserved');
    res.json({ ok: true, message: 'Signals cleared. Market data and weights preserved.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reset-data', (req, res) => {
  try {
    const db = require('./db');
    db.run('DELETE FROM signals');
    db.run('DELETE FROM market_data');
    db.run('DELETE FROM learning_log');
    console.log('[Reset] Signals, market data and learning log cleared');
    res.json({ ok: true, message: 'Signals, market data and learning log cleared. Weights preserved.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Full reset — wipes everything including weights, reseeds from config defaults
// Use this when changing weight schema or starting completely fresh
app.post('/api/reset-all', (req, res) => {
  try {
    const db = require('./db');
    const { SYMBOLS } = require('./config');

    db.run('DELETE FROM signals');
    db.run('DELETE FROM market_data');
    db.run('DELETE FROM learning_log');
    db.run('DELETE FROM weights');

    // Reseed weights from current config defaults
    for (const [sym, cfg] of Object.entries(SYMBOLS)) {
      const w = cfg.scoringWeights;
      db.run(
        `INSERT INTO weights (symbol,ts,pine,fxssi,session,min_score_proceed,entry_fxssi_weight,sl_fxssi_weight,tp_fxssi_weight)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [sym, Date.now(), w.pine, w.fxssi, w.session, cfg.minScoreProceed, 0.50, 0.50, 0.50]
      );
    }

    db.persist();
    console.log('[Reset] Full reset complete — all data wiped, weights reseeded from config');
    res.json({ ok: true, message: 'Full reset complete. All signals, market data, learning log and weights cleared. Weights reseeded from config defaults.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual extract — generates a human-readable trading session report
// Paste the output into Claude for analysis and suggestions
app.get('/api/extract', async (req, res) => {
  try {
    const db = require('./db');
    const signals = db.getAllSignals(50);
    const closed  = signals.filter(s => s.outcome === 'WIN' || s.outcome === 'LOSS');
    const open    = signals.filter(s => s.outcome === 'OPEN' || s.outcome === 'ACTIVE');

    const wins   = closed.filter(s => s.outcome === 'WIN').length;
    const losses = closed.filter(s => s.outcome === 'LOSS').length;
    const winRate = closed.length > 0 ? Math.round(wins / closed.length * 100) : 0;

    // Build per-signal detail
    const signalDetails = closed.slice(0, 20).map(s => {
      let fxssi = null;
      try {
        const md = db.getLatestMarketData(s.symbol);
        if (md?.fxssi_analysis) fxssi = JSON.parse(md.fxssi_analysis);
      } catch(e) {}

      return {
        symbol:    s.symbol,
        direction: s.direction,
        outcome:   s.outcome,
        score:     s.score,
        verdict:   s.verdict,
        session:   s.session,
        entry:     s.entry,
        sl:        s.sl,
        tp:        s.tp,
        rr:        s.rr,
        pnl_pct:   s.pnl_pct,
        reasoning: s.reasoning,
        fxssi_snapshot: fxssi ? {
          longPct:       fxssi.longPct,
          shortPct:      fxssi.shortPct,
          trapped:       fxssi.trapped,
          inProfitPct:   fxssi.inProfitPct,
          signalBias:    fxssi.signals?.bias,
          gravity:       fxssi.gravity?.price,
          slClusters:    fxssi.slClusters?.slice(0,3).map(c => c.price),
          losingClusters: fxssi.losingClusters?.slice(0,3).map(c => c.price),
          middleOfVolume: fxssi.middleOfVolume
        } : null
      };
    });

    // Current weights
    const weights = {};
    const { SYMBOLS } = require('./config');
    for (const sym of Object.keys(SYMBOLS)) {
      const w = db.getWeights(sym);
      if (w) weights[sym] = {
        pine_bias: w.pine_bias,
        fxssi:     w.fxssi_sentiment,
        ob:        w.order_book,
        session:   w.session_quality,
        min_score: w.min_score_proceed
      };
    }

    // Learning log summary
    const learningLog = db.getLearningLog(10);

    // Open signals
    const openDetails = open.slice(0, 10).map(s => ({
      symbol: s.symbol, direction: s.direction,
      score: s.score, verdict: s.verdict,
      entry: s.entry, sl: s.sl, tp: s.tp, rr: s.rr,
      session: s.session, reasoning: s.reasoning
    }));

    const extract = {
      generated_at: new Date().toISOString(),
      summary: {
        total_closed: closed.length,
        wins, losses, win_rate_pct: winRate,
        total_open: open.length
      },
      current_weights: weights,
      closed_signals: signalDetails,
      open_signals:   openDetails,
      learning_log:   learningLog.slice(0, 5).map(l => ({
        ts:       new Date(l.ts).toISOString(),
        symbol:   l.symbols_analysed,
        outcomes: l.outcomes_used,
        reasoning: l.reasoning
      })),
      instructions: 'Paste this into Claude and ask: analyse my trading performance and suggest specific changes to improve win rate'
    };

    // Return as pretty JSON
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(extract, null, 2));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// FXSSI force scrape — trigger immediately regardless of schedule
app.get('/api/fxssi-force', async (req, res) => {
  try {
    const { runFXSSIScrape } = require('./fxssiScraper');
    // Temporarily override shouldFetch
    process.env.FXSSI_FORCE = '1';
    await runFXSSIScrape(null);
    process.env.FXSSI_FORCE = '';
    res.json({ ok: true, message: 'Scrape triggered — check /api/fxssi-status' });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Trade monitor — dismiss a recommendation
app.post('/api/signals/:id/dismiss-rec/:recId', (req, res) => {
  try {
    const { dismissRecommendation } = require('./db');
    dismissRecommendation(parseInt(req.params.id), req.params.recId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Claude learning endpoints
app.get('/api/claude/regime', (req, res) => {
  const fn = claudeLearner.getRegime;
  res.json((typeof fn === 'function' ? fn() : null) || { regime: 'UNKNOWN', summary: 'Not enough data yet' });
});

app.get('/api/claude/insights', (req, res) => {
  const fn = claudeLearner.getInsights;
  res.json(typeof fn === 'function' ? fn() : []);
});

app.get('/api/claude/patterns', (req, res) => {
  const fp = claudeLearner.getSessionPatterns; res.json(typeof fp === 'function' ? fp() : {});
});

app.get('/api/claude/optimisations', (req, res) => {
  const fo = claudeLearner.getAllOptimisations; res.json(typeof fo === 'function' ? fo() : {});
});

app.post('/api/claude/optimise/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const result = await claudeLearner.optimiseEntryLevels(symbol);
  res.json(result || { error: 'Not enough data (need 5+ closed trades)' });
});

app.post('/api/claude/regime-now', async (req, res) => {
  const detectFn = claudeLearner.detectRegime; const regime = typeof detectFn === 'function' ? await detectFn() : null;
  res.json(regime || { error: 'Not enough data' });
});

// FXSSI direct test — call the API right now and return raw result
app.get('/api/fxssi-test', async (req, res) => {
  const token  = process.env.FXSSI_TOKEN;
  const userId = process.env.FXSSI_USER_ID || '118460';
  if (!token) return res.json({ error: 'No FXSSI_TOKEN set' });

  try {
    const url = `https://c.fxssi.com/api/order-book?pair=XAUUSD&view=all&rand=${Math.random()}&token=${token}&user_id=${userId}&period=1200`;
    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://fxssi.com/'
      }
    });
    const status = r.status;
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch(e) {}
    // Show first level to verify field names
    const firstLevel = parsed?.levels?.[0] || null;
    const midLevel = parsed?.levels?.[Math.floor((parsed?.levels?.length||0)/2)] || null;
    res.json({
      httpStatus: status,
      hasLevels: parsed?.levels?.length || 0,
      price: parsed?.price || null,
      time: parsed?.time || null,
      snapshotAge: parsed?.time ? Math.round((Date.now()/1000 - parsed.time)/60) + 'm' : null,
      firstLevel,
      midLevel,
      fieldNames: firstLevel ? Object.keys(firstLevel) : []
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// FXSSI Rich webhook — accepts payload from browser extension as backup
function processFxssiRichWebhook(payload) {
  if (!payload || !payload.fxssi) return;
  const result = processBridgePayload(payload);
  if (!result) return;
  broadcast({ type: 'FXSSI_UPDATE', symbol: result.symbol, analysed: result.analysed, ts: Date.now() });
  console.log(`[Webhook] FXSSI-rich ${result.symbol} processed`);
}

app.post('/webhook/fxssi-rich', (req, res) => {
  // Fallback if HTTP interceptor misses this route
  res.status(200).json({ ok: true });
  setImmediate(() => {
    try { processFxssiRichWebhook(req.body || {}); }
    catch(e) { console.error('[Webhook] FXSSI-rich error:', e.message); }
  });
});

// FXSSI status — check what's cached
app.get('/api/fxssi-status', (req, res) => {
  const db = require('./db');
  const symbols = ['GOLD','SILVER','OILWTI','BTCUSD','US100','US30'];
  const status = {};
  for (const sym of symbols) {
    const data = db.getLatestMarketData(sym);
    let fx = null;
    try {
      // Try fxssi_analysis column first, fall back to raw_payload
      const raw = data?.fxssi_analysis || data?.raw_payload;
      if (raw) {
        const parsed = JSON.parse(raw);
        // raw_payload has {fxssiAnalysis: "...json..."} or fxssi_analysis has the object directly
        if (parsed.fxssiAnalysis) {
          fx = typeof parsed.fxssiAnalysis === 'string'
            ? JSON.parse(parsed.fxssiAnalysis)
            : parsed.fxssiAnalysis;
        } else if (parsed.longPct != null) {
          fx = parsed; // fxssi_analysis column stores object directly
        }
      }
    } catch(e) {}
    status[sym] = {
      hasData:        !!data,
      longPct:        data?.fxssi_long_pct  ?? null,
      shortPct:       data?.fxssi_short_pct ?? null,
      trapped:        data?.fxssi_trapped   ?? null,
      absorption:     data?.ob_absorption   ?? null,
      imbalance:      data?.ob_imbalance    ?? null,
      signalBias:     fx?.signals?.bias     ?? null,
      gravity:        fx?.gravity?.price    ?? null,
      nearestSLAbove: fx?.nearestSLAbove?.price ?? null,
      nearestSLBelow: fx?.nearestSLBelow?.price ?? null,
      inProfitPct:    fx?.inProfitPct       ?? null,
      lastUpdate:     data?.ts ? new Date(data.ts).toISOString() : null
    };
  }
  res.json({ token_set: !!process.env.FXSSI_TOKEN, status });
});

// Debug: check latest market data for a symbol
app.get('/api/data/:symbol', (req, res) => {
  const { getLatestMarketData } = require('./db');
  const data = getLatestMarketData(req.params.symbol.toUpperCase());
  res.json(data || { error: 'No data found for ' + req.params.symbol });
});

// Manual score trigger — for testing
app.get('/api/score-now', async (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  let results;
  try { results = scoreAllPriority(); }
  catch(e) { console.error('[Score-now] error:', e); return res.json({ error: 'Scoring failed' }); }
  const proceeds = results.filter(r => r.verdict === 'PROCEED');
  const watches  = results.filter(r => r.verdict === 'WATCH');
  for (const r of [...proceeds, ...watches]) {
    const id = saveSignal(r);
    if (id) r.id = id;
  }
  broadcast({ type: 'SCORES', results, ts: Date.now() });
  res.json({ ok: true, scored: results.length, proceeds: proceeds.length, watches: watches.length, results });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    db: dbReady ? 'ready' : 'initialising',
    symbols: Object.keys(SYMBOLS).length,
    uptime: Math.round(process.uptime()),
    ts: Date.now()
  });
});

// ── Health check — Pine alert + FXSSI freshness per symbol ───────────────────
// Flags symbols where no Pine data received >2h during market hours,
// or FXSSI data is stale. Use this to detect TradingView alert failures.
// MTF bias — multi-timeframe structure direction for all symbols
app.get('/api/mtf-bias', (req, res) => {
  try {
    const result = {};
    for (const sym of Object.keys(SYMBOLS)) {
      const md = db.getLatestMarketData(sym);
      if (!md) continue;
      let emaDir = {}, struct = {};
      try { const raw = JSON.parse(md.raw_payload || '{}'); emaDir = raw.emaDir || raw.structure || {}; struct = raw.structure || {}; } catch(e) {}
      const getDir = (v) => v === 1 || v === 'bull' ? 1 : v === -1 || v === 'bear' ? -1 : 0;
      // Compute weighted struct score from structure data
      const SW = {'1d':3,'4h':2,'1h':1.5,'15m':1,'5m':0.5,'1m':0.5};
      let wScore = 0;
      for (const [tf, w] of Object.entries(SW)) { wScore += (getDir(struct[tf]) || 0) * w; }
      result[sym] = {
        '1m': getDir(emaDir['1m'] || struct['1m']),
        '5m': getDir(emaDir['5m'] || struct['5m']),
        '15m': getDir(emaDir['15m'] || struct['15m']),
        '1h': getDir(emaDir['1h'] || struct['1h']),
        '4h': getDir(emaDir['4h'] || struct['4h']),
        '1d': getDir(emaDir['1d'] || struct['1d']),
        score: Math.round(Math.abs(wScore) * 10) / 10,
        price: md.close || 0,
        ageMin: Math.round((Date.now() - (md.ts || 0)) / 60000)
      };
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Performance stats — win rate, MFE, sessions, score bands, loss categories
app.get('/api/stats', (req, res) => {
  try {
    const signals = db.getAllSignals(500);
    const closed = signals.filter(s => ['WIN','LOSS'].includes(s.outcome));
    if (closed.length === 0) return res.json({ empty: true });
    const wins = closed.filter(s => s.outcome === 'WIN');
    const losses = closed.filter(s => s.outcome === 'LOSS');
    const winRate = Math.round(wins.length / closed.length * 100);
    const bySess = {};
    for (const s of closed) { const sess = s.session || 'unknown'; if (!bySess[sess]) bySess[sess] = {w:0,l:0}; s.outcome === 'WIN' ? bySess[sess].w++ : bySess[sess].l++; }
    const mfes = closed.filter(s => s.mfe_pct > 0);
    const avgMFE = mfes.length ? Math.round(mfes.reduce((a,b) => a + (b.mfe_pct||0), 0) / mfes.length * 100) / 100 : 0;
    const avgPNL = wins.length ? wins.reduce((a,b) => a + (b.pnl_pct||0), 0) / wins.length : 0;
    const mfeCapture = avgMFE > 0 ? Math.round(avgPNL / avgMFE * 100) : 0;
    const holdTimes = closed.filter(s => s.ts && s.outcome_ts).map(s => (s.outcome_ts - s.ts) / 3600000);
    const avgHold = holdTimes.length ? Math.round(holdTimes.reduce((a,b) => a+b, 0) / holdTimes.length * 10) / 10 : 0;
    const lossCats = {};
    for (const s of losses) { const cat = s.outcome_category || 'UNKNOWN'; lossCats[cat] = (lossCats[cat]||0) + 1; }
    res.json({ total: closed.length, wins: wins.length, losses: losses.length, winRate, avgMFE, mfeCapture, avgHoldH: avgHold, bySess, lossCats });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Backtest — replay historical market data through scorer
app.get('/api/backtest', (req, res) => {
  try {
    const { symbol = 'ALL', minScore = 80, session = 'ALL', direction = 'ALL', followRecs = 'false' } = req.query;
    let signals = db.getAllSignals(1000).filter(s => s.verdict === 'PROCEED' || s.verdict === 'WATCH');
    if (symbol !== 'ALL') signals = signals.filter(s => s.symbol === symbol);
    if (session !== 'ALL') signals = signals.filter(s => s.session === session);
    if (direction !== 'ALL') signals = signals.filter(s => s.direction === direction);
    signals = signals.filter(s => (s.score || 0) >= Number(minScore));
    signals.sort((a, b) => a.ts - b.ts);

    const simulated = signals.map(sig => {
      const recs = (() => { try { return JSON.parse(sig.recommendations || '[]'); } catch(e) { return []; } })();
      let simOutcome = sig.outcome, simPnl = sig.pnl_pct || 0;
      if (followRecs === 'true' && recs.length) {
        const highClose = recs.find(r => r.type === 'CLOSE' && r.urgency === 'HIGH' && !r.resolved_reason?.includes('rsi-normalised'));
        if (highClose && highClose.price) {
          simPnl = sig.direction === 'LONG' ? Math.round((highClose.price - sig.entry) / sig.entry * 10000) / 100 : Math.round((sig.entry - highClose.price) / sig.entry * 10000) / 100;
          simOutcome = simPnl >= 0 ? 'WIN' : 'LOSS';
        }
      }
      if (['ACTIVE', 'OPEN'].includes(sig.outcome)) { simOutcome = 'PENDING'; simPnl = sig.mfe_pct || 0; }
      if (sig.outcome === 'EXPIRED') { simOutcome = 'EXPIRED'; simPnl = 0; }
      return { id: sig.id, symbol: sig.symbol, direction: sig.direction, score: sig.score, verdict: sig.verdict, session: sig.session, rr: sig.rr, struct: sig.weighted_struct_score, entry: sig.entry, sl: sig.sl, tp: sig.tp, mfe_pct: sig.mfe_pct || 0, outcome: sig.outcome, outcome_category: sig.outcome_category, simOutcome, simPnl, ts: sig.ts, outcome_ts: sig.outcome_ts, recs_count: recs.length, high_recs: recs.filter(r => r.urgency === 'HIGH').length };
    });

    const closed = simulated.filter(s => ['WIN', 'LOSS'].includes(s.simOutcome));
    const wins = closed.filter(s => s.simOutcome === 'WIN');
    const losses = closed.filter(s => s.simOutcome === 'LOSS');
    const winRate = closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0;
    const totalPnl = Math.round(closed.reduce((a, b) => a + (b.simPnl || 0), 0) * 100) / 100;
    const avgWin = wins.length ? Math.round(wins.reduce((a, b) => a + (b.simPnl || 0), 0) / wins.length * 100) / 100 : 0;
    const avgLoss = losses.length ? Math.round(Math.abs(losses.reduce((a, b) => a + (b.simPnl || 0), 0) / losses.length) * 100) / 100 : 0;
    const profitFactor = avgLoss > 0 ? Math.round((avgWin * wins.length) / (avgLoss * losses.length) * 100) / 100 : null;
    let peak = 0, maxDD = 0, running = 0;
    const equity = [];
    for (const s of closed) { running += s.simPnl || 0; if (running > peak) peak = running; const dd = peak - running; if (dd > maxDD) maxDD = dd; equity.push({ ts: s.outcome_ts || s.ts, pnl: Math.round(running * 100) / 100, symbol: s.symbol, outcome: s.simOutcome }); }

    const byScore = { '80-82': { w: 0, l: 0 }, '83-84': { w: 0, l: 0 }, '85-87': { w: 0, l: 0 }, '88+': { w: 0, l: 0 } };
    for (const s of closed) { const b = s.score >= 88 ? '88+' : s.score >= 85 ? '85-87' : s.score >= 83 ? '83-84' : '80-82'; s.simOutcome === 'WIN' ? byScore[b].w++ : byScore[b].l++; }
    const bySession = {};
    for (const s of closed) { const ss = s.session || 'unknown'; if (!bySession[ss]) bySession[ss] = { w: 0, l: 0 }; s.simOutcome === 'WIN' ? bySession[ss].w++ : bySession[ss].l++; }
    const bySymbol = {};
    for (const s of closed) { if (!bySymbol[s.symbol]) bySymbol[s.symbol] = { w: 0, l: 0 }; s.simOutcome === 'WIN' ? bySymbol[s.symbol].w++ : bySymbol[s.symbol].l++; }

    res.json({
      summary: { total: simulated.length, closed: closed.length, wins: wins.length, losses: losses.length, expired: simulated.filter(s => s.simOutcome === 'EXPIRED').length, pending: simulated.filter(s => s.simOutcome === 'PENDING').length, winRate, totalPnl, avgWin, avgLoss, profitFactor, maxDrawdown: Math.round(maxDD * 100) / 100, avgRR: simulated.length > 0 ? Math.round(simulated.reduce((a, b) => a + (b.rr || 0), 0) / simulated.length * 10) / 10 : 0 },
      equity, byScore, bySession, bySymbol, signals: simulated
    });
  } catch(e) { console.error('[Backtest]', e.message); res.status(500).json({ error: e.message }); }
});

// Trade journal — auto-generated entries for every outcome
app.get('/api/journal', (req, res) => {
  try { res.json(db.getJournalEntries(100)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => {
  const { isMarketOpen } = require('./marketHours');
  const db2 = require('./db');
  const PINE_STALE_MS  = 5 * 60 * 1000;   // 5 minutes — alerts now 1m, 5 missed = problem
  const FXSSI_STALE_MS = 25 * 60 * 1000;  // 25 minutes — scrape every 20min + buffer

  const now = Date.now();
  const symbolHealth = {};

  for (const sym of Object.keys(SYMBOLS)) {
    const data    = db2.getLatestMarketData(sym);
    const isOpen  = isMarketOpen(sym);
    const lastSeen  = data?.ts || null;
    const pineAge   = lastSeen ? (now - lastSeen) : null;
    // FXSSI has its own scrape cycle — use actual cache timestamp, not Pine alert time
    // Pine stale ≠ FXSSI stale (they run on different schedules)
    const fxssiAge  = getFxssiCacheAge(sym);

    const pineStale  = isOpen && pineAge != null && pineAge > PINE_STALE_MS;
    // Only flag FXSSI stale if: market is open AND we've scraped before AND it's old
    const fxssiStale = isOpen && fxssiAge != null && fxssiAge > FXSSI_STALE_MS;
    const noData     = isOpen && !data;

    symbolHealth[sym] = {
      ok:          !pineStale && !fxssiStale && !noData,
      marketOpen:  isOpen,
      lastPineTs:  lastSeen ? new Date(lastSeen).toISOString() : null,
      pineAgeMin:  pineAge != null ? Math.round(pineAge / 60000) : null,
      pineStale,
      fxssiPresent: data?.fxssi_long_pct != null,
      fxssiAgeMin:  fxssiAge != null ? Math.round(fxssiAge / 60000) : null,
      fxssiStale,
      alerts: [
        ...(noData     ? ['NO_DATA — no Pine alert received yet']          : []),
        ...(pineStale  ? [`PINE_STALE — last alert ${Math.round(pineAge/60000)}m ago (>${PINE_STALE_MS/60000}m threshold)`] : []),
        ...(fxssiStale ? [`FXSSI_STALE — order book ${Math.round(fxssiAge/60000)}m old`] : [])
      ]
    };
  }

  const allOk    = Object.values(symbolHealth).every(s => s.ok || !s.marketOpen);
  const problems = Object.entries(symbolHealth)
    .filter(([, s]) => !s.ok && s.marketOpen)
    .map(([sym, s]) => ({ symbol: sym, alerts: s.alerts }));

  // Also fire email check on manual health poll if degraded
  if (!allOk) {
    runHealthCheck().catch(e => console.error('[Health] Manual trigger error:', e.message));
  }

  res.json({
    status:    allOk ? 'OK' : 'DEGRADED',
    checkedAt: new Date().toISOString(),
    problems,
    symbols:   symbolHealth
  });
});

// Paper trade stats — WATCH signal win rate if they had been taken
app.get('/api/paper-trades', (req, res) => {
  res.json(getPaperTradeStats());
});

// Macro context — current macro environment per symbol
app.get('/api/macro-context', (req, res) => {
  res.json(getMacroContext());
});

// Macro single-symbol test — fetches GOLD only, persists to DB, returns result (1 API call)
app.get('/api/macro-test', async (req, res) => {
  try {
    const symbol = 'GOLD';
    const query = 'gold XAU price macro outlook DXY Fed rates today';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a macro analyst. Search for current market conditions and return ONLY a JSON object. No markdown, no explanation.',
        messages: [{ role: 'user', content: `Search: "${query}". Return ONLY this JSON:
{"sentiment":"BULLISH|BEARISH|NEUTRAL","strength":5,"summary":"one sentence","key_risks":["risk1"],"supports_long":true,"supports_short":false,"avoid_until":"none"}` }]
      })
    });
    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed = null, parseError = null, persisted = false;
    try {
      parsed = JSON.parse(clean);
      macroContext[symbol] = { ...parsed, ts: Date.now() };
      db.upsertMacroContext(symbol, macroContext[symbol]);
      persisted = true;
    } catch(e) { parseError = e.message; }

    // Verify DB write
    const dbCheck = db.getStoredMacroContext();

    res.json({
      apiStatus: response.status,
      stopReason: data.stop_reason,
      blockTypes: data.content?.map(b => b.type),
      textLength: text.length,
      cleanJson: clean.slice(0, 300),
      parsed: parsed ? { sentiment: parsed.sentiment, strength: parsed.strength } : null,
      parseError,
      persisted,
      dbCount: Object.keys(dbCheck).length,
      dbSymbols: Object.keys(dbCheck),
      inMemoryCount: Object.keys(getMacroContext()).length
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/api/macro-debug', (req, res) => {
  try {
    const stored = db.getStoredMacroContext();
    const age = db.getMacroContextAge();
    const inMemory = getMacroContext();
    res.json({
      dbCount: Object.keys(stored).length,
      dbSymbols: Object.keys(stored),
      dbSample: Object.entries(stored).slice(0, 2).map(([k, v]) => ({ symbol: k, sentiment: v.sentiment, strength: v.strength, ts: v.ts })),
      dbAgeHours: Math.round(age / 3600000),
      inMemoryCount: Object.keys(inMemory).length,
      inMemorySymbols: Object.keys(inMemory),
      inMemorySample: Object.entries(inMemory).slice(0, 2).map(([k, v]) => ({ symbol: k, sentiment: v.sentiment, strength: v.strength, ts: v.ts }))
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Force macro context refresh (GET + POST for browser + curl compatibility)
// macro-refresh: fire-and-forget (fast response)
const macroRefreshHandler = async (req, res) => {
  res.json({ ok: true, message: 'Macro refresh started' });
  runMacroContextFetch(broadcast, 'macro_refresh').catch(e => console.error('[Macro] Manual refresh error:', e.message));
};
app.get('/api/macro-refresh', macroRefreshHandler);
app.post('/api/macro-refresh', macroRefreshHandler);
// macro-force: waits and returns result (for debugging)
const macroForceHandler = async (req, res) => {
  try {
    await runMacroContextFetch(broadcast, 'macro_force');
    const ctx = getMacroContext();
    res.json({ ok: true, symbols: Object.keys(ctx).length, data: ctx });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
};
app.get('/api/macro-force', macroForceHandler);
app.post('/api/macro-force', macroForceHandler);

// ── Morning brief builder ─────────────────────────────────────────────────────
async function buildMorningBrief() {
  const macro = getMacroContext();
  const lines = [];
  lines.push(`<b>🌅 ATLAS // MORNING BRIEF</b>`);
  lines.push(`${new Date().toUTCString().slice(0, 16)} — Dubai ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit' })}`);
  lines.push('');

  // Macro biases
  lines.push('<b>📊 MACRO BIAS</b>');
  for (const sym of ['GOLD', 'SILVER', 'OILWTI', 'BTCUSD', 'US30', 'US100']) {
    const m = macro[sym];
    if (!m) continue;
    const icon = m.sentiment === 'BULLISH' ? '↑' : m.sentiment === 'BEARISH' ? '↓' : '○';
    let bias;
    if (m.sentiment === 'BULLISH') bias = 'LONG';
    else if (m.sentiment === 'BEARISH') bias = 'SHORT';
    else if (m.supports_long && !m.supports_short) bias = 'LONG (cautious)';
    else if (m.supports_short && !m.supports_long) bias = 'SHORT (cautious)';
    else bias = 'AVOID (no edge)';
    lines.push(`${icon} <b>${sym}</b> — ${m.sentiment} (${m.strength}/10) → ${bias}`);
  }
  lines.push('');

  // COT extremes
  lines.push('<b>📈 COT EXTREMES</b>');
  let cotCount = 0;
  for (const sym of ['GOLD', 'SILVER', 'OIL', 'EUR', 'GBP', 'JPY', 'AUD']) {
    try {
      const cot = getLatestCOT(sym);
      if (!cot || Math.abs(cot.netNonComm) < 50000) continue;
      const dir = cot.netNonComm > 0 ? 'LONG' : 'SHORT';
      const chg = cot.changeNetNonComm > 0 ? `↑${Math.abs(Math.round(cot.changeNetNonComm / 1000))}k` : `↓${Math.abs(Math.round(cot.changeNetNonComm / 1000))}k`;
      lines.push(`⚠ <b>${sym}</b> specs NET ${dir} ${Math.round(cot.netNonComm / 1000)}k (${chg} WoW)`);
      cotCount++;
    } catch(e) {}
  }
  if (cotCount === 0) lines.push('No extreme positioning detected');
  lines.push('');

  // Rate differentials — extremes only
  lines.push('<b>💰 CARRY EXTREMES</b>');
  let carryCount = 0;
  for (const pair of ['USDJPY', 'USDCHF', 'GBPJPY', 'AUDJPY', 'GBPCHF']) {
    const diff = getRateDifferential(pair);
    if (!diff || diff.strength === 'WEAK' || diff.direction === 'NEUTRAL') continue;
    lines.push(`${diff.summary}`);
    carryCount++;
  }
  if (carryCount === 0) lines.push('No extreme carry differentials');
  lines.push('');

  // Forecast bias signals — directional pre-release analysis
  try {
    const { getForecastBias } = require('./forexCalendar');
    const forecastSignals = [];
    for (const sym of ['EURUSD','GBPUSD','USDJPY','AUDUSD','GOLD','SILVER','US30','US100','OILWTI','BTCUSD']) {
      const fb = getForecastBias(sym);
      if (fb) forecastSignals.push({ symbol: sym, ...fb });
    }
    if (forecastSignals.length > 0) {
      lines.push('<b>📊 FORECAST SIGNALS</b>');
      for (const f of forecastSignals) {
        const icon = f.bias > 0 ? '📈' : f.bias < 0 ? '📉' : '➡️';
        lines.push(`${icon} <b>${f.symbol}</b> — ${f.summary}`);
        lines.push(`   Fires in: ${f.firesIn}`);
      }
      lines.push('');
    }
  } catch(e) {}

  // Merged events: CB meetings + Forex Factory HIGH impact
  const cbMeetings = getUpcomingMeetings(14).map(m => ({
    label: m.isEconomicEvent ? m.bank : `🏦 ${m.bank}`,
    currency: m.currency,
    date: m.date,
    time: null,
    daysUntil: m.daysUntil,
    isCB: !m.isEconomicEvent
  }));
  const ffEvents = getUpcomingHighImpactEvents(7).map(e => ({
    label: `${e.currency} ${e.title}`,
    currency: e.currency,
    date: e.date,
    time: e.time,
    daysUntil: e.daysUntil,
    isCB: false
  }));
  const allEvents = [...cbMeetings, ...ffEvents]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 10);

  if (allEvents.length > 0) {
    const { FEED_ICONS } = require('./forexCalendar');
    lines.push('<b>📅 UPCOMING EVENTS</b>');
    for (const e of allEvents) {
      const icon = e.daysUntil <= 0 ? '🚨' : e.daysUntil <= 1 ? '⚠️'
        : e.isCB ? '🏦' : (e.feedIcon || '📊');
      const timeStr = e.time ? ' ' + e.time.slice(0, 5) : '';
      const srcTag = e.sources ? ` [${e.sources}]` : '';
      const note = e.daysUntil <= 1 ? ' ← event risk' : '';
      lines.push(`${icon} ${e.label} — ${e.date}${timeStr} (${e.daysUntil}d)${srcTag}${note}`);
    }
    lines.push('');
  }

  // Recent fired events with outcomes
  try {
    const { getRecentFiredEvents } = require('./db');
    const recentFired = getRecentFiredEvents(12).filter(e => e.sentiment !== 0);
    if (recentFired.length > 0) {
      lines.push('<b>📊 RECENT EVENT OUTCOMES</b>');
      for (const e of recentFired.slice(0, 5)) {
        const icon = e.sentiment > 0 ? '📈' : e.sentiment < 0 ? '📉' : '➡️';
        lines.push(`${icon} ${e.sentiment_summary || e.title}`);
      }
      lines.push('');
    }
  } catch(e) {}

  // Active market intel
  try {
    const activeIntel = db.getActiveIntel();
    if (activeIntel.length > 0) {
      lines.push('<b>📡 ACTIVE MARKET INTEL</b>');
      for (const item of activeIntel.slice(0, 4)) {
        const biasIcon = item.bias === 'BULLISH' ? '📈' : item.bias === 'BEARISH' ? '📉' : '➡️';
        lines.push(`${biasIcon} ${item.summary || item.content?.slice(0, 80)}`);
        try { const syms = JSON.parse(item.affected_symbols || '[]'); if (syms.length) lines.push(`   Affects: ${syms.join(', ')}`); } catch(e) {}
      }
      lines.push('');
    }
  } catch(e) {}

  // Active signals
  const activeSignals = getCurrentCycleSignals(20).filter(s =>
    s.outcome === 'OPEN' || s.outcome === 'ACTIVE'
  );
  if (activeSignals.length > 0) {
    lines.push('<b>📋 ACTIVE POSITIONS</b>');
    for (const s of activeSignals) {
      const dir = s.direction === 'LONG' ? '🟢' : '🔴';
      const mfe = s.mfe_pct ? ` | MFE:+${s.mfe_pct}%` : '';
      const state = s.outcome === 'ACTIVE' ? '● ACTIVE' : '○ OPEN';
      lines.push(`${dir} <b>${s.symbol}</b> ${s.direction} @ ${s.entry} | SL:${s.sl} | TP:${s.tp}${mfe} [${state}]`);
      // Show pending recommendations
      try {
        const recs = JSON.parse(s.recommendations || '[]');
        const pending = recs.find(r => !r.resolved);
        if (pending) lines.push(`   ⚠ ${pending.type} — ${(pending.reason || '').slice(0, 60)}`);
      } catch(e) {}
    }
  } else {
    lines.push('<b>📋 No active positions</b>');
  }

  // Today's HIGH impact events
  try {
    const todayEvents = (db.getAllEconomicEvents() || []).filter(e => {
      const today = new Date().toISOString().slice(0, 10);
      return e.event_date === today && e.impact === 'High' && !e.fired;
    });
    if (todayEvents.length > 0) {
      lines.push('');
      lines.push('<b>📅 TODAY\'S EVENTS</b>');
      const { getForecastBias } = require('./forexCalendar');
      for (const e of todayEvents) {
        const utcH = parseInt(e.event_time || '0');
        const uaeH = (utcH + 4) % 24;
        const uaeTime = String(uaeH).padStart(2, '0') + ':' + (e.event_time || '00:00').slice(3, 5) + ' UAE';
        let icon = '📊';
        try {
          const fb = getForecastBias ? getForecastBias(e.currency) : null;
          if (fb?.bias > 0) icon = '📈';
          else if (fb?.bias < 0) icon = '📉';
        } catch(fe) {}
        lines.push(`${icon} ${uaeTime} — <b>${e.title}</b>`);
        if (e.forecast && e.previous) lines.push(`   Forecast: ${e.forecast} | Prev: ${e.previous}`);
      }
    }
  } catch(e) {}

  return lines.join('\n');
}

// Telegram test
app.get('/api/telegram-test', async (req, res) => {
  const ok = await sendTest();
  res.json({ ok, message: ok ? 'Message sent' : 'Failed — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID' });
});

// Morning brief preview (returns HTML text, doesn't send)
app.get('/api/morning-brief', async (req, res) => {
  const brief = await buildMorningBrief();
  res.json({ brief });
});

// Send morning brief via Telegram
app.post('/api/morning-brief-send', async (req, res) => {
  const brief = await buildMorningBrief();
  const ok = await sendMorningBrief(brief);
  res.json({ ok, brief });
});

// COT data status — currency-level positioning + pair-level summaries
app.get('/api/cot-status', (req, res) => {
  const { getAllCOTData } = require('./db');
  const rows = getAllCOTData();
  const currencies = {};
  for (const row of rows) {
    currencies[row.symbol] = {
      reportDate: row.report_date,
      netNonComm: row.net_noncomm,
      netComm: row.net_comm,
      openInterest: row.open_interest,
      changeNetNonComm: row.change_net_noncomm,
      ts: row.ts
    };
  }
  // Build pair-level summaries for all ATLAS symbols that have COT coverage
  const pairs = {};
  for (const sym of Object.keys(SYMBOLS)) {
    const summary = getCOTSummary(sym);
    if (summary) pairs[sym] = summary;
  }
  res.json({ currencies, pairs });
});

// Force COT fetch — waits for completion and returns results with per-currency errors
app.post('/api/cot-force', async (req, res) => {
  try {
    const result = await runCOTFetch();
    const { getAllCOTData } = require('./db');
    const rows = getAllCOTData();
    res.json({ ok: true, ...result, stored: rows.length, currencies: rows.map(r => r.symbol) });
  } catch(e) {
    console.error('[COT] Manual fetch error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});
app.get('/api/cot-force', async (req, res) => {
  try {
    const result = await runCOTFetch();
    const { getAllCOTData } = require('./db');
    const rows = getAllCOTData();
    res.json({ ok: true, ...result, stored: rows.length, currencies: rows.map(r => r.symbol) });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Raw CFTC API test — pass ?currency=GBP to test one, or omit for EUR+GOLD+OIL
app.get('/api/cot-test', async (req, res) => {
  const allCurrencies = getCOTCurrencies();
  const qCurrency = req.query.currency?.toUpperCase();
  let tests;
  if (qCurrency && allCurrencies[qCurrency]) {
    tests = { [qCurrency]: allCurrencies[qCurrency] };
  } else {
    tests = {
      EUR:  allCurrencies.EUR,
      GOLD: allCurrencies.GOLD,
      OIL:  allCurrencies.OIL
    };
  }
  const results = {};
  for (const [label, name] of Object.entries(tests)) {
    const testUrl = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?$where=market_and_exchange_names='${encodeURIComponent(name)}'&$order=report_date_as_yyyy_mm_dd DESC&$limit=1`;
    try {
      const r = await fetch(testUrl, { headers: { 'Accept': 'application/json' } });
      const text = await r.text();
      try {
        const parsed = JSON.parse(text);
        const rec = Array.isArray(parsed) && parsed[0];
        results[label] = {
          status: r.status,
          records: Array.isArray(parsed) ? parsed.length : 0,
          date: rec?.report_date_as_yyyy_mm_dd?.slice(0,10),
          noncomm_long: rec?.noncomm_positions_long_all,
          noncomm_short: rec?.noncomm_positions_short_all,
          name: rec?.market_and_exchange_names
        };
      } catch(e) {
        results[label] = { status: r.status, raw: text.slice(0, 300) };
      }
    } catch(e) {
      results[label] = { error: e.message };
    }
  }
  res.json(results);
});

// Rate data status — all currencies + pair differentials
app.get('/api/rate-status', (req, res) => {
  const rates = getLatestRates();
  const differentials = {};
  for (const sym of Object.keys(SYMBOLS)) {
    const diff = getRateDifferential(sym);
    if (diff) differentials[sym] = diff;
  }
  res.json({ rates, differentials });
});

// ── Market intel API ──────────────────────────────────────────────────────────
app.get('/api/market-intel', (req, res) => {
  res.json(db.getActiveIntel());
});

app.post('/api/market-intel', async (req, res) => {
  const { content, symbol, expiresInHours } = req.body;
  if (!content) return res.status(400).json({ error: 'Need content' });

  // Clean input before processing
  const cleaned = content
    .replace(/\[\d+\/\d+\/\d{4}\s+\d+:\d+\s+[AP]M\]/g, '')
    .replace(/Capital\.com International:/g, '')
    .replace(/[├└│┌┐┘┤┬┴┼─]/g, '-')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{3,}/g, ' ')
    .replace(/CFDs are complex instruments.*?money\./gs, '')
    .replace(/Past performance.*?results\)/g, '')
    .replace(/Opinions shared.*?only\./g, '')
    .trim();

  const { resolveSymbol } = require('./symbolAliases');
  const resolvedSym = symbol || resolveSymbol(cleaned) || null;
  const validExpiries = [4, 8, 24, 48, 72, 168];
  let expiry = validExpiries.includes(Number(expiresInHours)) ? Number(expiresInHours) : 24;

  // Analyse with Haiku (system + user message for better instruction following)
  let analysis = null;
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const sysPrompt = 'You are a market research analyser for a trading system. Extract the key trading insight from research notes. Ignore timestamps, disclaimers, source attribution. Focus only on: market direction, affected assets, key price levels, and time horizon. Return ONLY valid JSON. No markdown. No explanation.';
      const userPrompt = `Analyse this market research. Return ONLY this JSON:\n{"summary":"<2 sentences max — key trading insight only>","bias":"BULLISH|BEARISH|NEUTRAL|MIXED","affected_symbols":["SYMBOL"],"key_levels":["level"],"time_horizon":"INTRADAY|SWING|LONG_TERM"}\n\nValid symbols: GOLD,SILVER,OILWTI,BTCUSD,ETHUSD,US30,US100,US500,DE40,UK100,J225,HK50,CN50,COPPER,PLATINUM,EURUSD,GBPUSD,USDJPY,USDCHF,USDCAD,AUDUSD,NZDUSD,EURJPY,EURGBP,EURAUD,EURCHF,GBPJPY,GBPCHF,AUDJPY\nAliases: NKD/Nikkei=J225, WTI/Crude=OILWTI, Dow=US30, Nasdaq=US100, S&P=US500, DAX=DE40, FTSE=UK100, BTC=BTCUSD\n\nResearch:\n${cleaned}`;
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: sysPrompt, messages: [{ role: 'user', content: userPrompt }] })
      });
      const apiData = await apiRes.json();
      const text = apiData.content?.[0]?.text || '{}';
      analysis = JSON.parse(text.replace(/```json|```/g, '').trim());
      console.log(`[Intel] Haiku: ${analysis.bias} — ${analysis.summary?.slice(0, 80)}`);
    }
  } catch(e) { console.error('[Intel] Haiku error:', e.message); }

  const suggestedExpiry = analysis?.time_horizon === 'INTRADAY' ? 8 : analysis?.time_horizon === 'SWING' ? 72 : analysis?.time_horizon === 'LONG_TERM' ? 168 : 24;
  if (!expiresInHours) expiry = suggestedExpiry;

  // Store CLEANED content + analysis
  const id = db.insertMarketIntel(cleaned, resolvedSym || analysis?.affected_symbols?.[0] || null, analysis, expiry);
  res.json({
    ok: true, id, symbol: resolvedSym || 'global',
    summary: analysis?.summary, bias: analysis?.bias,
    affected_symbols: analysis?.affected_symbols, key_levels: analysis?.key_levels,
    time_horizon: analysis?.time_horizon,
    suggested_expiry_hours: suggestedExpiry, expires_in_hours: expiry
  });
});

app.delete('/api/market-intel/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  db.deleteIntel(id);
  console.log(`[Intel] Deleted intel id:${id}`);
  res.json({ ok: true, deleted: id });
});

app.delete('/api/market-intel', (req, res) => {
  db.clearExpiredIntel(); // clear expired
  db.run('DELETE FROM market_intel'); // clear all
  db.persist();
  console.log('[Intel] All intel cleared');
  res.json({ ok: true, message: 'All intel cleared' });
});

// Loss/Win taxonomy
app.get('/api/taxonomy', (req, res) => {
  try {
    const signals = db.getAllSignals(500).filter(s => s.outcome === 'WIN' || s.outcome === 'LOSS');
    const losses = {}, wins = {};
    let lossTotal = 0, winTotal = 0;
    for (const s of signals) {
      const cat = s.outcome_category || 'UNKNOWN';
      if (s.outcome === 'LOSS') { losses[cat] = (losses[cat] || 0) + 1; lossTotal++; }
      else { wins[cat] = (wins[cat] || 0) + 1; winTotal++; }
    }
    const total = lossTotal + winTotal;
    const mostCommonLoss = Object.entries(losses).sort((a, b) => b[1] - a[1])[0]?.[0] || 'NONE';
    const insights = {
      IGNORED_RECS: 'Following HIGH urgency CLOSE recs is your #1 improvement opportunity',
      WEAK_STRUCTURE: 'Raise minimum structure threshold — lower TF signals are not working',
      MFE_CAPTURE_FAILURE: 'Partial TP at 1:1 R:R would convert these losses to breakevens',
      EVENT_RISK: 'Pre-event suppression is working but post-event re-entry needs work',
      COUNTER_TREND: 'Counter-trend trades are underperforming — consider tighter filtering'
    };
    res.json({
      losses, wins, lossTotal, winTotal,
      winRate: total > 0 ? Math.round((winTotal / total) * 100) : null,
      mostCommonLoss,
      insight: insights[mostCommonLoss] || 'Review loss patterns to find improvement areas'
    });
  } catch(e) { res.json({ error: e.message }); }
});

// Calendar debug — shows stored events with computed UTC and fired status
app.get('/api/calendar-debug', (req, res) => {
  try {
    const now = new Date();
    const events = db.getAllEconomicEvents().slice(0, 15);
    res.json({
      server_utc: now.toISOString(),
      server_ts: now.getTime(),
      events: events.map(e => {
        const dtStr = e.event_date + 'T' + (e.event_time || '00:00:00') + 'Z';
        const eventTs = new Date(dtStr).getTime();
        const minutesUntil = Math.round((eventTs - now.getTime()) / 60000);
        return {
          title: e.title, currency: e.currency,
          stored_date: e.event_date, stored_time: e.event_time,
          fired_in_db: e.fired, actual: e.actual,
          computed_utc: dtStr,
          minutes_until: minutesUntil,
          should_be_fired: eventTs < now.getTime()
        };
      })
    });
  } catch(e) { res.json({ error: e.message }); }
});

// DB recovery — restore from .bak file if signals were lost
app.get('/api/db-recover', async (req, res) => {
  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/atlas.db');
    const dataDir = path.dirname(dbPath);
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    // Scan ALL files in data directory for potential backups
    const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
    const candidates = files
      .filter(f => f.endsWith('.db') || f.endsWith('.bak') || f.endsWith('.bloated'))
      .map(f => ({ name: f, path: path.join(dataDir, f), size: fs.statSync(path.join(dataDir, f)).size }))
      .filter(f => f.size > 1000 && f.size < 50 * 1024 * 1024) // skip empty and bloated (>50MB)
      .sort((a, b) => b.size - a.size);

    const currentSignals = db.getAllSignals(1000).length;
    const results = [];

    for (const c of candidates) {
      try {
        const buf = fs.readFileSync(c.path);
        const testDb = new SQL.Database(buf);
        const check = testDb.exec("PRAGMA integrity_check")[0]?.values?.[0]?.[0];
        let signals = 0, intel = 0;
        try { signals = testDb.exec("SELECT COUNT(*) FROM signals")[0]?.values?.[0]?.[0] || 0; } catch(e) {}
        try { intel = testDb.exec("SELECT COUNT(*) FROM market_intel")[0]?.values?.[0]?.[0] || 0; } catch(e) {}
        results.push({ name: c.name, sizeKB: Math.round(c.size/1024), integrity: check, signals, intel });
        testDb.close();
      } catch(e) {
        results.push({ name: c.name, sizeKB: Math.round(c.size/1024), error: e.message });
      }
    }

    // Find best backup (most signals)
    const best = results.filter(r => r.integrity === 'ok' && r.signals > currentSignals).sort((a, b) => b.signals - a.signals)[0];

    if (best && req.query.restore === 'true') {
      const bestPath = path.join(dataDir, best.name);
      fs.copyFileSync(bestPath, dbPath);
      res.json({ ok: true, restored: best.name, signals: best.signals, intel: best.intel, message: 'Restored. Restart server to load.' });
    } else {
      res.json({ currentSignals, backups: results, best: best || null, hint: best ? 'Add ?restore=true to restore from ' + best.name : 'No backup has more signals than current DB' });
    }
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// DB protection verification — test that persist actually works
app.get('/api/db-verify', async (req, res) => {
  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/atlas.db');
    const before = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const signalsBefore = db.getAllSignals(1000).length;
    const marketDataCount = (() => { try { return db.run ? 0 : 0; } catch(e) { return -1; } })();

    // Check startup protection state
    const startupComplete = typeof global._dbStartupComplete !== 'undefined' ? global._dbStartupComplete : 'unknown';

    // Try a test write to settings (harmless)
    db.setSetting('_db_verify_ts', String(Date.now()));
    const readBack = db.getSetting('_db_verify_ts');

    // Wait 2s for async persist to complete
    await new Promise(r => setTimeout(r, 2000));

    const after = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const bakExists = fs.existsSync(dbPath + '.bak');
    const bakSize = bakExists ? fs.statSync(dbPath + '.bak').size : 0;

    res.json({
      protection: {
        startupComplete,
        persistWorking: readBack === db.getSetting('_db_verify_ts'),
        bakExists,
        bakSizeKB: Math.round(bakSize / 1024)
      },
      db: {
        signals: signalsBefore,
        fileSizeBefore: Math.round(before / 1024) + 'KB',
        fileSizeAfter: Math.round(after / 1024) + 'KB',
        fileGrew: after >= before
      },
      status: after >= before ? 'HEALTHY — persist working, file not shrinking' : 'WARNING — file shrank after persist'
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// DB status — current file sizes and signal count
app.get('/api/db-status', (req, res) => {
  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/atlas.db');
    const bakPath = dbPath + '.bak';
    const dataDir = path.dirname(dbPath);
    const files = {};
    if (fs.existsSync(dbPath)) files.db = { size: fs.statSync(dbPath).size, sizeKB: Math.round(fs.statSync(dbPath).size/1024) };
    if (fs.existsSync(bakPath)) files.bak = { size: fs.statSync(bakPath).size, sizeKB: Math.round(fs.statSync(bakPath).size/1024) };
    const backups = fs.readdirSync(dataDir).filter(f => f.includes('_backup_')).sort().reverse();
    const signals = db.getAllSignals(1000).length;
    res.json({ signals, files, dailyBackups: backups });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// DXY reference
app.get('/api/dxy-status', (req, res) => {
  res.json(db.getLatestDXY() || { error: 'No DXY data yet' });
});

// ── Trade idea feedback (no Claude API call) ─────────────────────────────────
app.post('/api/trade-feedback', (req, res) => {
  const { idea } = req.body;
  if (!idea) return res.status(400).json({ error: 'Need idea text' });

  // ── Parse price levels, confidence, direction ──────────────────────────────
  function parseIdeaLevels(text) {
    const clean = text.replace(/[^\x00-\x7F\s]/g, ' ');
    const result = {};
    // Entry
    const entryM = clean.match(/(?:buy|sell|entry|enter|limit|stop order)\s+(?:at\s+)?([\d.]+)/i) || clean.match(/\bat\s+([\d.]+)/i);
    if (entryM) result.entry = parseFloat(entryM[1]);
    // SL
    const slM = clean.match(/(?:stop|sl|stop.?loss)[:\s]+([\d.]+)/i);
    if (slM) result.sl = parseFloat(slM[1]);
    // TP1
    const tp1M = clean.match(/(?:target\s*1|tp\s*1|first.?target)[:\s]+([\d.]+)/i) || clean.match(/(?:target|tp|take.?profit)[:\s]+([\d.]+)/i);
    if (tp1M) result.tp = parseFloat(tp1M[1]);
    // TP2
    const tp2M = clean.match(/(?:target\s*2|tp\s*2)[:\s]+([\d.]+)/i);
    if (tp2M) result.tp2 = parseFloat(tp2M[1]);
    // Confidence stars
    const starM = text.match(/⭐/g);
    if (starM) result.external_confidence = Math.min(5, starM.length);
    // R:R
    if (result.entry && result.sl && result.tp) {
      const risk = Math.abs(result.entry - result.sl);
      const reward = Math.abs(result.tp - result.entry);
      result.rr = risk > 0 ? Math.round((reward / risk) * 10) / 10 : null;
    }
    return result;
  }

  // Auto-detect symbol using alias mapping
  const { resolveSymbol } = require('./symbolAliases');
  let symbol = resolveSymbol(idea);

  // Direction — includes Buy Limit / Sell Limit
  let direction = null;
  if (/\b(short|sell|bear|down|bearish)\b/i.test(idea) || /sell\s*limit|sell\s*stop/i.test(idea)) direction = 'SHORT';
  if (/\b(long|buy|bull|up|bullish)\b/i.test(idea) || /buy\s*limit|buy\s*stop/i.test(idea)) direction = 'LONG';

  const levels = parseIdeaLevels(idea);
  if (!symbol) return res.json({ error: 'Could not detect symbol from idea text' });

  // Load system data
  const data = db.getLatestMarketData(symbol);
  const macro = getMacroContext()[symbol] || null;
  let cot = null, rateDiff = null, dxy = null;
  try { cot = getLatestCOT(symbol); } catch(e) {}
  try { rateDiff = getRateDifferential(symbol); } catch(e) {}
  try { dxy = global.atlasGetDXY?.(); } catch(e) {}
  const intel = global.atlasGetActiveIntel?.(symbol) || [];
  const latestSignal = db.getAllSignals(10).find(s => s.symbol === symbol && s.outcome !== 'EXPIRED');
  const upcomingEvents = getUpcomingHighImpactEvents(2);

  // ── Build analysis ─────────────────────────────────────────────────────────
  const analysis = { symbol, direction,
    idea_entry: levels.entry, idea_sl: levels.sl, idea_tp: levels.tp, idea_tp2: levels.tp2, idea_rr: levels.rr,
    external_confidence: levels.external_confidence || null,
    strengths: [], risks: [], warnings: [], checks: [], alignment: 'UNKNOWN', conviction: 0, verdict: 'WAIT' };
  let score = 0, maxScore = 0;

  // Check 1: Technical structure
  if (data?.raw_payload && direction) {
    try {
      const raw = JSON.parse(data.raw_payload);
      const st = raw.structure || {};
      const SW = { '1d': 3.0, '4h': 2.0, '1h': 1.5, '15m': 1.0, '5m': 0.5, '1m': 0.5 };
      let ss = 0;
      for (const [tf, w] of Object.entries(SW)) {
        const v = st[tf] || 0;
        if ((direction === 'LONG' && v === 1) || (direction === 'SHORT' && v === -1)) ss += w;
      }
      maxScore += 3;
      if (ss >= 5.0) { score += 3; analysis.strengths.push(`Strong structure ${ss}/8.5 — higher TFs aligned`); }
      else if (ss >= 2.0) { score += 1.5; analysis.checks.push(`Moderate structure ${ss}/8.5 — lower TFs only`); }
      else analysis.risks.push(`Weak structure ${ss}/8.5 — no higher TF confirmation`);
    } catch(e) {}
  }

  // Check 2: RSI
  if (data?.rsi && direction) {
    const rsi = data.rsi; maxScore += 2;
    if (direction === 'LONG' && rsi > 55 && rsi < 70) { score += 2; analysis.strengths.push(`RSI ${Math.round(rsi)} — confirms LONG`); }
    else if (direction === 'SHORT' && rsi < 45 && rsi > 30) { score += 2; analysis.strengths.push(`RSI ${Math.round(rsi)} — confirms SHORT`); }
    else if (direction === 'LONG' && rsi < 40) analysis.risks.push(`RSI ${Math.round(rsi)} — momentum against LONG`);
    else if (direction === 'SHORT' && rsi > 65) analysis.risks.push(`RSI ${Math.round(rsi)} — momentum against SHORT`);
  }

  // Check 3: Retail OB (fix: parse fxssi_analysis if direct fields empty)
  let longPct = data?.fxssi_long_pct, shortPct = data?.fxssi_short_pct;
  if (!longPct && data?.fxssi_analysis) {
    try {
      const fxP = typeof data.fxssi_analysis === 'string' ? JSON.parse(data.fxssi_analysis) : data.fxssi_analysis;
      longPct = fxP.longPct; shortPct = fxP.shortPct || (100 - longPct);
    } catch(e) {}
  }
  if (longPct && direction) {
    maxScore += 2; shortPct = shortPct || (100 - longPct);
    if (direction === 'LONG' && shortPct > 55) { score += 2; analysis.strengths.push(`Retail crowd ${shortPct}% short — contrarian LONG`); }
    else if (direction === 'SHORT' && longPct > 55) { score += 2; analysis.strengths.push(`Retail crowd ${longPct}% long — contrarian SHORT`); }
    else if (direction === 'LONG' && longPct > 65) analysis.risks.push(`Retail crowd ${longPct}% long — crowded`);
  }

  // Check 4: Macro
  if (macro && direction) {
    maxScore += 3;
    const confirms = (direction === 'LONG' && macro.supports_long && !macro.supports_short) || (direction === 'SHORT' && macro.supports_short && !macro.supports_long);
    const conflicts = (direction === 'LONG' && macro.supports_short && !macro.supports_long) || (direction === 'SHORT' && macro.supports_long && !macro.supports_short);
    if (confirms) { score += 3; analysis.strengths.push(`Macro ${macro.sentiment} (${macro.strength}/10) confirms — ${macro.summary}`); }
    else if (conflicts) { score -= 1; analysis.risks.push(`Macro ${macro.sentiment} (${macro.strength}/10) conflicts — ${macro.summary}`); }
    if (macro.avoid_until) analysis.checks.push(`Avoid until: ${macro.avoid_until}`);
  } else {
    analysis.checks.push('No macro context for this symbol — consider web search for current macro bias.');
  }

  // Check 5-9 (COT, rates, events, signal alignment, intel) — unchanged logic
  if (cot && direction) { maxScore += 2; const net = cot.netNonComm || 0;
    if ((direction === 'LONG' && net < -100000) || (direction === 'SHORT' && net > 100000)) { score += 2; analysis.strengths.push(`COT extreme — contrarian edge for ${direction}`); }
    else if ((direction === 'LONG' && net > 100000) || (direction === 'SHORT' && net < -100000)) { score -= 1; analysis.risks.push(`COT extreme crowding against ${direction}`); }
  }
  if (rateDiff && direction) { maxScore += 1;
    if (rateDiff.differential > 200 && direction === 'LONG') { score += 1; analysis.strengths.push(`Rate +${rateDiff.differential}bps — carry favours LONG`); }
    else if (rateDiff.differential < -200 && direction === 'LONG') analysis.risks.push(`Rate ${rateDiff.differential}bps — carry against LONG`);
  }
  const relevantEvents = upcomingEvents.filter(e => e.daysUntil <= 2);
  if (relevantEvents.length > 0) analysis.warnings.push(`⚠ ${relevantEvents[0].title} in ${relevantEvents[0].daysUntil}d — event risk`);
  if (latestSignal && direction) {
    if (latestSignal.direction === direction && latestSignal.verdict === 'PROCEED') { score += 2; analysis.strengths.push(`System also flagged ${symbol} ${direction} (${latestSignal.score}%) — aligned`); }
    else if (latestSignal.direction !== direction && latestSignal.verdict === 'PROCEED') analysis.risks.push(`System has active ${latestSignal.direction} signal — counter-direction`);
  }
  if (intel.length > 0) analysis.checks.push(`📡 Intel: ${intel.slice(0, 2).join(' | ')}`);
  if (levels.rr && levels.rr < 1.5) { analysis.verdict = 'AVOID'; analysis.warnings.push(`R:R ${levels.rr} below minimum 1.5`); }

  // External confidence cross-check
  if (levels.external_confidence >= 4 && analysis.verdict === 'AVOID') {
    analysis.warnings.push(`Source rates this ${'⭐'.repeat(levels.external_confidence)} (${levels.external_confidence}/5) — high external conviction but system disagrees. Review carefully.`);
  }
  if (levels.external_confidence && levels.external_confidence <= 2) {
    analysis.checks.push(`Source rates this ${'⭐'.repeat(levels.external_confidence)} (${levels.external_confidence}/5) — low external conviction. Size down.`);
  }

  // Stale entry detection
  if (data?.close && levels.entry && direction) {
    const currentPrice = data.close;
    if (direction === 'LONG' && currentPrice > levels.entry * 1.05) {
      analysis.warnings.push(`Current price ${currentPrice} is >5% above entry ${levels.entry} — chasing this entry carries risk.`);
    }
    if (direction === 'SHORT' && currentPrice < levels.entry * 0.95) {
      analysis.warnings.push(`Current price ${currentPrice} is >5% below entry ${levels.entry} — entry already surpassed.`);
    }
  }

  // Verdict
  const pct = maxScore > 0 ? score / maxScore : 0;
  analysis.alignment = pct >= 0.7 ? 'ALIGNED' : pct >= 0.4 ? 'PARTIAL' : score < 0 ? 'AGAINST' : 'NEUTRAL';
  analysis.conviction = Math.min(10, Math.max(1, Math.round(pct * 10)));
  if (analysis.verdict !== 'AVOID') {
    analysis.verdict = pct >= 0.65 && analysis.warnings.length === 0 ? 'TAKE IT' : pct >= 0.40 ? 'WAIT' : 'AVOID';
  }

  // supports_signal consistency
  analysis.supports_signal = analysis.verdict === 'TAKE IT';
  if (score < 0) { analysis.supports_signal = false; analysis.verdict = 'AVOID'; }

  // ── Full Claude export ─────────────────────────────────────────────────────
  let techData = {}; try { if (data?.raw_payload) techData = JSON.parse(data.raw_payload); } catch(e) {}
  const st = techData.structure || {};
  const tfs = ['1m','5m','15m','1h','4h','1d'];
  const structLines = tfs.map(tf => {
    const s = st[tf] || 0;
    return `  ${tf.padEnd(4)}: ${s === 1 ? '↑ Bullish' : s === -1 ? '↓ Bearish' : '→ Ranging'}`;
  }).join('\n');

  let fxssi = null;
  try { const raw = data?.fxssi_analysis; if (raw) fxssi = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch(e) {}

  const confStr = levels.external_confidence ? `${'⭐'.repeat(levels.external_confidence)} (${levels.external_confidence}/5)` : 'not provided';

  const exportLines = [
    '=== ATLAS // TRADE IDEA — FULL SYSTEM EXPORT ===',
    `Symbol: ${symbol} | Direction: ${direction || 'unknown'}`,
    `Analysed: ${new Date().toISOString()}`, '',
    '--- ORIGINAL IDEA ---', idea, '',
    '--- PARSED LEVELS ---',
    `Entry: ${levels.entry || 'not specified'} | Stop: ${levels.sl || 'not specified'} | Target: ${levels.tp || 'not specified'}`,
    levels.tp2 ? `Target 2: ${levels.tp2}` : null,
    `R:R: ${levels.rr || 'not calculated'} | Source confidence: ${confStr}`, '',
    '--- SYSTEM VERDICT ---',
    `Verdict: ${analysis.verdict} | Alignment: ${analysis.alignment} | Conviction: ${analysis.conviction}/10`, '',
    analysis.strengths.length ? '+ STRENGTHS:\n' + analysis.strengths.map(s => `  + ${s}`).join('\n') : null,
    analysis.risks.length ? '- RISKS:\n' + analysis.risks.map(r => `  - ${r}`).join('\n') : null,
    analysis.warnings.length ? '! WARNINGS:\n' + analysis.warnings.map(w => `  ! ${w}`).join('\n') : null,
    analysis.checks.length ? '? CHECKS:\n' + analysis.checks.map(c => `  ? ${c}`).join('\n') : null, '',
    '--- TECHNICAL STRUCTURE ---',
    `RSI: ${data?.rsi ? Math.round(data.rsi * 10)/10 : 'N/A'} | Bias: ${techData.biasScore || data?.bias_score || 'N/A'}`,
    'Timeframes:', structLines, '',
    '--- RETAIL ORDER BOOK ---',
    fxssi ? `Long: ${fxssi.longPct}% | Short: ${fxssi.shortPct}% | Signals: ${fxssi.signals?.bias || 'N/A'}` : 'No OB data', '',
    '--- MACRO CONTEXT ---',
    macro ? `${macro.sentiment} (${macro.strength}/10) — ${macro.summary}\nRisks: ${(macro.key_risks||[]).join('; ')}` : 'No macro data', '',
    '--- COT ---',
    cot ? `Net: ${cot.netNonComm?.toLocaleString()} | Change: ${cot.changeNetNonComm?.toLocaleString()} WoW` : 'No COT data', '',
    '--- RATE DIFFERENTIAL ---',
    rateDiff ? rateDiff.summary : 'N/A', '',
    '--- DXY ---',
    dxy ? `${dxy.close} | Trend: ${dxy.trend}` : 'No DXY data', '',
    '--- EVENTS (48h) ---',
    relevantEvents.length ? relevantEvents.map(e => `${e.title} (${e.currency}) — ${e.date}`).join('\n') : 'None', '',
    '--- INTEL ---',
    intel.length ? intel.map(i => `📡 ${i}`).join('\n') : 'None', '',
    '--- SYSTEM SIGNAL ---',
    latestSignal ? `${latestSignal.direction} @ ${latestSignal.entry} | Score: ${latestSignal.score}% | ${latestSignal.outcome}` : 'None', '',
    '=== END ===', '',
    '--- INSTRUCTIONS FOR CLAUDE ---',
    `Analyse this ${symbol} ${direction || ''} trade idea using all data above.`,
    `Search the web for current ${symbol} conditions and breaking news.`,
    'Provide: (1) Your verdict (2) Entry/SL/TP assessment (3) What to change (4) Key risks'
  ].filter(l => l !== null).join('\n');

  res.json({ ...analysis, claudeExport: exportLines });
});

// ── Settings API ──────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const defaults = {
    account_balance: '10000', risk_pct: '1.0',
    leverage_forex: '100', leverage_index: '20', leverage_commodity: '50', leverage_crypto: '10',
    contract_size_forex: '100000', contract_size_index: '1', contract_size_commodity: '1', contract_size_crypto: '1',
    pip_value_forex: '10', min_lot_forex: '0.01',
    point_value_us30: '1', point_value_us100: '1', point_value_us500: '1',
    point_value_de40: '1', point_value_uk100: '1', point_value_j225: '100',
    tick_value_gold: '1', tick_value_silver: '1', tick_value_oilwti: '1',
    tick_value_copper: '1', tick_value_platinum: '1',
    cfd_lot_gold: '100', cfd_lot_silver: '5000', cfd_lot_oilwti: '1000',
    cfd_lot_copper: '25000', cfd_lot_platinum: '50',
    min_size_crypto: '0.001',
    kelly_mode: 'auto', kelly_win_rate_manual: '50', kelly_avg_rr_manual: '1.5', kelly_fraction: '0.25'
  };
  const result = {};
  for (const [key, def] of Object.entries(defaults)) {
    result[key] = db.getSetting(key) || def;
  }
  res.json(result);
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key || value == null) return res.status(400).json({ error: 'Need key and value' });
  db.setSetting(key, String(value));
  res.json({ ok: true, key, value: String(value) });
});

app.post('/api/settings/bulk', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Need object' });
  for (const [key, value] of Object.entries(updates)) {
    db.setSetting(key, String(value));
  }
  res.json({ ok: true, updated: Object.keys(updates).length });
});

// Raw Trading Economics test — scrapes and returns extracted rates for debugging
app.get('/api/rate-test', async (req, res) => {
  try {
    const r = await fetch('https://tradingeconomics.com/country-list/interest-rate', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html'
      }
    });
    const html = await r.text();
    const marker = 'var data = [';
    const start = html.indexOf(marker);
    if (start === -1) return res.json({ status: r.status, error: 'marker not found', htmlSnippet: html.slice(0, 1000) });
    const arrStart = start + marker.length - 1;
    let depth = 0, arrEnd = -1;
    for (let i = arrStart; i < html.length; i++) {
      if (html[i] === '[') depth++;
      if (html[i] === ']') { depth--; if (depth === 0) { arrEnd = i + 1; break; } }
    }
    const arr = JSON.parse(html.slice(arrStart, arrEnd));
    const targets = { 'United States':'USD','Euro Area':'EUR','United Kingdom':'GBP','Japan':'JPY','Switzerland':'CHF','Canada':'CAD','Australia':'AUD','New Zealand':'NZD' };
    const rates = {};
    for (const item of arr) { if (targets[item.name]) rates[targets[item.name]] = item.value; }
    res.json({ status: r.status, totalCountries: arr.length, rates });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Force rate scrape from Myfxbook
app.get('/api/rate-force', async (req, res) => {
  try {
    const result = await runRateFetch();
    res.json({ ok: true, ...result });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Central bank calendar — upcoming meetings with consensus
app.get('/api/cb-calendar', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const upcoming = getUpcomingMeetings(days);
  // Attach consensus where available
  const { getAllConsensus } = require('./db');
  const allCons = getAllConsensus();
  const consMap = {};
  for (const c of allCons) consMap[c.currency + '_' + c.meeting_date] = c;
  const result = upcoming.map(m => {
    const cons = consMap[m.currency + '_' + m.date];
    return {
      ...m,
      consensus: cons ? `${cons.expected_decision} ${cons.expected_bps ? cons.expected_bps + 'bps' : ''} (${cons.confidence} confidence)` : null,
      summary: cons?.summary || null
    };
  });
  res.json({ upcoming: result });
});

// Economic calendar — upcoming HIGH impact events from all 4 feeds
app.get('/api/calendar-status', (req, res) => {
  const events = getUpcomingHighImpactEvents(14);
  // Debug: log time calculations for each event
  const now = Date.now();
  for (const e of events.slice(0, 5)) {
    const constructed = e.date + 'T' + (e.time || '00:00:00') + 'Z';
    const eventTs = new Date(constructed).getTime();
    const diffMin = Math.round((eventTs - now) / 60000);
    console.log(`[Cal debug] ${e.title} stored=${e.time} constructed=${constructed} eventTs=${eventTs} now=${now} diff=${diffMin}min`);
  }
  res.json({ totalEvents: events.length, highImpactCount: events.filter(e => e.impact === 'High').length, events, _debug: { now, nowISO: new Date(now).toISOString() } });
});

app.get('/api/calendar-force', async (req, res) => {
  try {
    const result = await runCalendarFetch();
    const events = getUpcomingHighImpactEvents(14);
    res.json({ ok: true, ...result, upcoming: events.length });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Force-mark past unfired events as fired — clears stale pre-event warnings
app.post('/api/calendar-force-fired', (req, res) => {
  try {
    const now = Date.now();
    const events = db.getAllEconomicEvents() || [];
    let count = 0;
    for (const e of events) {
      if (e.fired) continue;
      const eTs = new Date(e.event_date + 'T' + (e.event_time || '00:00:00') + 'Z').getTime();
      if (eTs < now) {
        db.run('UPDATE economic_events SET fired=1 WHERE id=?', [e.id]);
        count++;
      }
    }
    if (count > 0) db.persist();
    res.json({ ok: true, marked: count });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Manual calendar time fix — correct Eastern→UTC when auto-detection fails
app.post('/api/calendar-fix', (req, res) => {
  const { from_time, to_time, date } = req.body;
  if (!from_time || !to_time || !date) return res.status(400).json({ error: 'Need from_time, to_time, date' });
  try {
    db.run('UPDATE economic_events SET event_time=? WHERE event_time=? AND event_date=?', [to_time, from_time, date]);
    db.persist();
    res.json({ ok: true, fixed: `${date} ${from_time} → ${to_time}` });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// Manual rate override — for BOJ/ECB announcements before next API fetch
// POST /api/rate-update { currency: "JPY", ratePct: 0.75 }
app.post('/api/rate-update', (req, res) => {
  const { currency, ratePct } = req.body;
  if (!currency || ratePct == null) return res.status(400).json({ error: 'Need currency and ratePct' });
  const cur = currency.toUpperCase();
  try {
    const { upsertRateData } = require('./db');
    upsertRateData(cur, { ratePct: parseFloat(ratePct), lastUpdated: new Date().toISOString().slice(0, 10), source: 'manual' });
    // Also update in-memory cache
    const rateMod = require('./rateFetcher');
    // Force cache refresh by clearing and reloading
    rateMod.loadRatesFromDB();
    res.json({ ok: true, currency: cur, ratePct: parseFloat(ratePct) });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Mark a WATCH signal paper outcome manually (if auto-detection missed it)
app.post('/api/paper-outcome', (req, res) => {
  const { signalId, paperOutcome } = req.body;
  if (!signalId || !['WIN', 'LOSS'].includes(paperOutcome)) {
    return res.status(400).json({ error: 'signalId and paperOutcome (WIN|LOSS) required' });
  }
  updatePaperOutcome(signalId, paperOutcome);
  broadcast({ type: 'PAPER_OUTCOME', signalId, paperOutcome, ts: Date.now() });
  res.json({ ok: true });
});

// ── Cron jobs ─────────────────────────────────────────────────────────────────
// Score all priority symbols every 5 minutes
cron.schedule('* * * * *', async () => {
  if (!dbReady) return;
  try {
    const results = scoreAllPriority();
    _lastScoringResults = results; // cache for instant HTTP response
    // Snapshot market data every 5 minutes — offset to :03/:08/:13/… to avoid
    // colliding with the FXSSI 20-min scrape at :01/:21/:41
    const minNow = new Date().getMinutes();
    if (minNow % 5 === 3) { try { db.snapshotAllMarketData(); } catch(e) {} }
    const proceeds = results.filter(r => r.verdict === 'PROCEED');
    const watches  = results.filter(r => r.verdict === 'WATCH');

    for (const r of [...proceeds, ...watches]) {
      const signalId = saveSignal(r);
      if (signalId) r.id = signalId;
    }

    broadcast({ type: 'SCORES', results, ts: Date.now() });

    if (proceeds.length > 0) {
      console.log(`[Cron] PROCEED signals: ${proceeds.map(r => r.symbol + ' ' + r.direction + ' ' + r.score + '%').join(', ')}`);
      broadcast({ type: 'ALERT', signals: proceeds, ts: Date.now() });
      // Telegram push for new PROCEED signals (only those that got an id = newly saved)
      for (const r of proceeds) {
        if (r.id) sendSignalAlert(r).catch(e => console.error('[Telegram] Signal alert error:', e.message));
      }
    }
  } catch(e) {
    console.error('[Cron] Scoring error:', e.message);
  }
});

// Check outcomes every minute + monitor active signals for thesis changes
cron.schedule('* * * * *', () => {
  if (!dbReady) return;
  try {
    checkOutcomes(broadcast);
  } catch(e) {
    console.error('[Cron] Outcome check error:', e.message);
  }
});

// FXSSI auto-scrape — fires at :01/:21/:41, aligned with 20-min FXSSI refresh cycle
// Runs 24/7 regardless of market hours — FXSSI data is live trader positioning,
// valid at all times. Stopping during market close caused stale data at open.
cron.schedule('1,21,41 * * * *', async () => {
  if (!dbReady) return;
  try {
    await runFXSSIScrape(broadcast);
  } catch(e) {
    console.error('[FXSSI Cron] Error:', e.message);
  }
});

// Retirement cron — fires at :02/:22/:42 (aligned with FXSSI scrape at :01/:21/:41)
// FXSSI scrapes first, then 1 minute later we retire ACTIVE signals
// Fresh FXSSI data is now in DB when new signals start scoring
cron.schedule('2,22,42 * * * *', async () => {
  try { await runRetirementCycle(broadcast); }
  catch(e) { console.error('[Cron] Retirement error:', e.message); }
});

// Nightly review — 23:00 UTC: weight learning + daily summary
cron.schedule('0 23 * * *', async () => {
  try {
    console.log('[Cron] Nightly review starting — learning + summary...');
    await runLearningCycle(broadcast);
    await claudeLearner.dailySessionSummary(broadcast);
    console.log('[Cron] Nightly review complete');
  } catch(e) { console.error('[Cron] Nightly review error:', e.message); }
});

// Nightly FXSSI history collection — 23:30 UTC
cron.schedule('30 23 * * *', async () => {
  try {
    console.log('[Cron] FXSSI history collection starting...');
    const result = await collectRecentHistory();
    console.log(`[Cron] FXSSI history collection done — collected:${result.collected} skipped:${result.skipped} errors:${result.errors}`);
  } catch(e) { console.error('[Cron] FXSSI history error:', e.message); }
});

// Weekly entry optimisation — Sunday 22:00 UTC (before Monday open)
cron.schedule('0 22 * * 0', async () => {
  try {
    console.log('[Cron] Weekly entry optimisation starting...');
    for (const symbol of Object.keys(SYMBOLS)) {
      await claudeLearner.optimiseEntryLevels(symbol).catch(e =>
        console.error(`[Claude] optimiseEntryLevels ${symbol}:`, e.message)
      );
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('[Cron] Weekly entry optimisation complete');
  } catch(e) { console.error('[Cron] Weekly optimisation error:', e.message); }
});

// Morning brief via Telegram — 05:00 UTC (09:00 Dubai)
cron.schedule('0 5 * * *', async () => {
  console.log('[Telegram] Sending morning brief...');
  try {
    const brief = await buildMorningBrief();
    console.log(`[Telegram] Morning brief built — ${brief.length} chars`);
    const ok = await sendMorningBrief(brief);
    console.log(`[Telegram] Morning brief ${ok ? 'sent' : 'FAILED to send'}`);
  } catch(e) {
    console.error('[Telegram] Morning brief error:', e.message, e.stack);
  }
});

// Economic calendar — poll every 5 minutes for new events + detect fired events
cron.schedule('*/5 * * * *', async () => {
  try { await runCalendarCheck(broadcast); }
  catch(e) { console.error('[Cron] Calendar error:', e.message); }
});

// Daily rate fetch — fires at 06:50 UTC (10 min before macro context)
cron.schedule('50 6 * * *', async () => {
  console.log('[Cron] Running daily rate fetch...');
  await runRateFetch();
});

// Daily macro context — fires at 07:00 UTC (before London open)
// Fetches current macro environment for each symbol via web search
// Stored in DB and used by scorer as a macro alignment check
cron.schedule('0 7 * * *', async () => {
  console.log('[Cron] Running daily macro context fetch...');
  await runMacroContextFetch(broadcast, 'cron_0700');
});

// Weekly COT fetch — every Friday at 20:45 UTC (15 min after CFTC 15:30 EST release)
cron.schedule('45 20 * * 5', async () => {
  try {
    console.log('[Cron] Running weekly COT data fetch...');
    await runCOTFetch();
  } catch(e) { console.error('[Cron] COT fetch error:', e.message); }
});

// ── Signal retirement ─────────────────────────────────────────────────────────
// At :02/:22/:42 — after fresh FXSSI data arrives — retire ACTIVE signals
// for all open-market symbols. Retired signals move to Past Trades tab but
// continue to be tracked for WIN/LOSS. Dedup gate ignores them completely.
async function runRetirementCycle(broadcast) {
  if (!dbReady) return;
  const { isMarketOpen } = require('./marketHours');
  const retired = [];

  for (const symbol of Object.keys(SYMBOLS)) {
    if (!isMarketOpen(symbol)) {
      console.log(`[Retire] ${symbol} — market closed, skipping`);
      continue;
    }
    const count = retireActiveCycle(symbol);
    if (count > 0) {
      retired.push({ symbol, count });
    }
  }

  if (retired.length > 0) {
    console.log(`[Retire] Cycle complete — retired: ${retired.map(r => `${r.symbol}(${r.count})`).join(', ')}`);
    broadcast({ type: 'CYCLE_RETIRED', retired, ts: Date.now() });
  }
}


// Keyed by symbol, refreshed daily at 07:00 UTC
// { GOLD: { sentiment, summary, key_risks, supports_long, supports_short, ts } }
const macroContext = {};

// ── Claude web search helper (handles multi-turn tool_use pattern) ───────────
async function callClaudeWithSearch(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const sysPrompt = 'You are a macro analyst. Search for current market conditions and return ONLY a JSON object. No markdown, no explanation.';

  // Turn 1
  const res1 = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, tools, system: sysPrompt, messages: [{ role: 'user', content: prompt }] })
  });
  const data1 = await res1.json();

  // If tool_use requested, do turn 2
  if (data1.stop_reason === 'tool_use') {
    const textBlocks = (data1.content || []).filter(b => b.type === 'text');
    if (textBlocks.length > 0) {
      const text = textBlocks.map(b => b.text).join('');
      if (text.includes('{')) return text;
    }
    const toolUseBlocks = (data1.content || []).filter(b => b.type === 'tool_use');
    const toolResults = toolUseBlocks.map(tu => ({ type: 'tool_result', tool_use_id: tu.id, content: 'Search completed. Use the information you have to answer.' }));
    const res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, tools, system: sysPrompt,
        messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: data1.content }, { role: 'user', content: toolResults }] })
    });
    const data2 = await res2.json();
    return (data2.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }

  // end_turn — text returned directly
  return (data1.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// ── MACRO CONTEXT FETCH ─────────────────────────────────────────────────────
// Rule 16: Anthropic API calls are FORBIDDEN outside the 07:00 UTC macro cron
// and explicit user-triggered /api/macro-force and /api/macro-refresh endpoints.
// This function enforces a hard caller guard — any unrecognised caller is
// blocked with a throw. On startup, macro context is loaded from DB only.
// This guard exists because startup macro fetches have regressed 3+ times.
const MACRO_ALLOWED_CALLERS = new Set(['cron_0700', 'macro_force', 'macro_refresh']);
async function runMacroContextFetch(broadcast, caller) {
  if (!MACRO_ALLOWED_CALLERS.has(caller)) {
    const msg = `[MACRO GUARD] BLOCKED — runMacroContextFetch called by "${caller || 'unknown'}". Only allowed: ${[...MACRO_ALLOWED_CALLERS].join(', ')}`;
    console.error(msg);
    throw new Error(msg);
  }
  if (!process.env.ANTHROPIC_API_KEY) return;

  const dateStr = new Date().toISOString().slice(0, 10);
  const symbolQueries = {
    GOLD:   `GOLD price outlook today ${dateStr} — search for news from last 12 hours including any political speeches, Fed comments, geopolitical developments`,
    SILVER: `Silver price outlook today ${dateStr} — last 12 hours industrial demand, USD, geopolitics`,
    OILWTI: `WTI crude oil outlook today ${dateStr} — search for last 12 hours news including Trump Iran statements, OPEC, Hormuz`,
    BTCUSD: `Bitcoin outlook today ${dateStr} — last 12 hours crypto news, ETF flows, regulation`,
    US30:   `Dow Jones outlook today ${dateStr} — last 12 hours including Trump trade policy, tariffs, market reaction`,
    US100:  `Nasdaq outlook today ${dateStr} — last 12 hours including tech policy, tariffs, rate expectations`,
    EURUSD: `EURUSD outlook today ${dateStr} — last 12 hours Fed ECB USD strength`,
    GBPUSD: `GBPUSD outlook today ${dateStr} — last 12 hours BOE Fed USD`,
    USDJPY: `USDJPY outlook today ${dateStr} — last 12 hours BOJ Fed USD strength carry`,
    AUDUSD: `AUDUSD outlook today ${dateStr} — last 12 hours RBA China commodity`,
    PLATINUM: `Platinum price outlook today ${dateStr} — search last 12 hours — precious metals, USD strength, safe haven flows, industrial demand`,
    COPPER: `Copper price outlook today ${dateStr} — search last 12 hours — China demand, USD, industrial activity, trade tariffs`,
    AUDJPY: `AUDJPY Australian dollar yen outlook today ${dateStr} — BOJ rate hike expectations, AUD strength, RBA vs BOJ policy divergence, last 12 hours news`,
    EURJPY: `EURJPY euro yen outlook today ${dateStr} — BOJ policy, ECB rates, JPY safe haven flows, last 12 hours`,
    GBPJPY: `GBPJPY pound yen outlook today ${dateStr} — BOJ rate hike risk, BOE policy, JPY volatility, last 12 hours`
  };

  for (const [symbol, baseQuery] of Object.entries(symbolQueries)) {
    // Inject active market intel into query
    const intel = global.atlasGetActiveIntel?.(symbol) || [];
    let query = intel.length > 0
      ? `${baseQuery}. Known context: ${intel.join('. ')}`
      : baseQuery;
    // Inject key levels from active intel
    try {
      const intelItems = db.getActiveIntel(symbol);
      const keyLevels = intelItems
        .flatMap(i => { try { return JSON.parse(i.key_levels || '[]'); } catch(e) { return []; } })
        .filter(Boolean);
      if (keyLevels.length > 0) {
        query += `. Key levels to watch: ${keyLevels.join(', ')}`;
      }
    } catch(e) {}
    try {
      // Build context enrichment
      let extraContext = '';
      try {
        const cot = getLatestCOT(symbol);
        if (cot && cot.reportDate && (Date.now() - (cot.ts || 0)) < 8 * 24 * 3600000) {
          extraContext += `\n\nCOT INSTITUTIONAL POSITIONING (as of ${cot.reportDate}):\n${getCOTSummary(symbol) || 'N/A'}`;
        }
      } catch(e) {}
      try {
        const rateDiff = getRateDifferential(symbol);
        if (rateDiff) {
          extraContext += `\nRATE DIFFERENTIAL: ${rateDiff.summary}`;
          if (rateDiff.strength === 'EXTREME') extraContext += ` — EXTREME carry`;
        }
      } catch(e) {}

      const prompt = `Search: "${query}".${extraContext} Return ONLY this JSON:\n{"sentiment":"BULLISH|BEARISH|NEUTRAL","strength":5,"summary":"one sentence max 15 words","key_risks":["risk1","risk2"],"supports_long":true,"supports_short":false,"avoid_until":"condition"}`;

      const text = await callClaudeWithSearch(prompt);
      const clean = text.replace(/```json|```/g, '').trim();
      console.log(`[Macro] ${symbol} text: ${clean.slice(0, 150)}`);

      const ctx = JSON.parse(clean);
      macroContext[symbol] = { ...ctx, ts: Date.now() };
      db.upsertMacroContext(symbol, macroContext[symbol]);
      console.log(`[Macro] ${symbol}: ${ctx.sentiment} (${ctx.strength}/10) — ${ctx.summary}`);
      if (broadcast) broadcast({ type: 'MACRO_UPDATE', symbol, context: macroContext[symbol], ts: Date.now() });

      await new Promise(r => setTimeout(r, 1500));
    } catch(e) {
      console.error(`[Macro] ${symbol} error:`, e.message);
    }
  }

  // ── Derived macro for cross pairs and indices without direct macro fetch ────
  const derivedSymbols = {
    EURGBP: (m) => {
      const eur = m['EURUSD'], gbp = m['GBPUSD'];
      if (!eur || !gbp) return null;
      const net = (eur.supports_long ? eur.strength : -eur.strength) - (gbp.supports_long ? gbp.strength : -gbp.strength);
      return { sentiment: net > 1 ? 'BULLISH' : net < -1 ? 'BEARISH' : 'NEUTRAL', strength: Math.min(10, Math.round(Math.abs(net) * 1.2)), supports_long: net > 1, supports_short: net < -1, summary: `Derived: EUR ${eur.sentiment} vs GBP ${gbp.sentiment}`, derived: true };
    },
    GBPCHF: (m) => {
      const gbp = m['GBPUSD'], usdchf = m['USDCHF'];
      if (!gbp || !usdchf) return null;
      const net = ((gbp.supports_long ? gbp.strength : -gbp.strength) + (usdchf.supports_long ? usdchf.strength : -usdchf.strength)) / 2;
      return { sentiment: net > 1 ? 'BULLISH' : net < -1 ? 'BEARISH' : 'NEUTRAL', strength: Math.min(10, Math.round(Math.abs(net) * 1.2)), supports_long: net > 1, supports_short: net < -1, summary: `Derived: GBP ${gbp.sentiment} + CHF via USDCHF`, derived: true };
    },
    UK100: (m) => {
      const gbp = m['GBPUSD'], us = m['US30'] || m['US100'];
      if (!gbp && !us) return null;
      const usScore = us ? (us.supports_long ? us.strength : -us.strength) : 0;
      const gbpScore = gbp ? (gbp.supports_long ? gbp.strength : -gbp.strength) : 0;
      const net = usScore * 0.7 + gbpScore * 0.3;
      return { sentiment: net > 1 ? 'BULLISH' : net < -1 ? 'BEARISH' : 'NEUTRAL', strength: Math.min(10, Math.round(Math.abs(net))), supports_long: net > 1, supports_short: net < -1, summary: `Derived: US risk ${us?.sentiment||'?'} + GBP ${gbp?.sentiment||'?'}`, derived: true };
    },
    US500: (m) => {
      const us30 = m['US30'], us100 = m['US100'];
      if (!us30 && !us100) return null;
      const s30 = us30 ? (us30.supports_long ? us30.strength : -us30.strength) : 0;
      const s100 = us100 ? (us100.supports_long ? us100.strength : -us100.strength) : 0;
      const count = (us30 ? 1 : 0) + (us100 ? 1 : 0);
      const net = count > 0 ? (s30 + s100) / count : 0;
      return { sentiment: net > 1 ? 'BULLISH' : net < -1 ? 'BEARISH' : 'NEUTRAL', strength: Math.min(10, Math.round(Math.abs(net))), supports_long: net > 1, supports_short: net < -1, summary: `Derived: US30 ${us30?.sentiment||'?'} + US100 ${us100?.sentiment||'?'}`, derived: true };
    }
  };
  for (const [sym, deriveFn] of Object.entries(derivedSymbols)) {
    try {
      const derived = deriveFn(macroContext);
      if (derived) {
        macroContext[sym] = { ...derived, ts: Date.now() };
        db.upsertMacroContext(sym, macroContext[sym]);
        console.log(`[Macro] ${sym}: ${derived.sentiment} (derived) — ${derived.summary}`);
      }
    } catch(e) {}
  }

  console.log(`[Macro] Context refresh complete for ${Object.keys(macroContext).length} symbols`);

  // ── Consensus fetch for upcoming meetings (within 21 days) ────────────────
  // Only fires when meetings are near — typically 0-2 calls per day
  if (!process.env.ANTHROPIC_API_KEY) return;
  try {
    const cbUpcoming = getUpcomingMeetings(21);
    for (const meeting of cbUpcoming) {
      try {
        const query = `${meeting.bank} ${meeting.currency} interest rate decision ${meeting.date} market consensus expectations`;
        console.log(`[Macro] Fetching consensus for ${meeting.bank} ${meeting.date}...`);
        const consRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            system: 'You are a rates analyst. Search for the market consensus and return ONLY a JSON object. No markdown.',
            messages: [{ role: 'user', content: `Search: "${query}". Return ONLY this JSON:
{"expected_decision":"HIKE|CUT|HOLD","expected_bps":25,"confidence":"HIGH|MEDIUM|LOW","summary":"one sentence max 20 words"}` }]
          })
        });
        const consData = await consRes.json();
        const consText = (consData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const consClean = consText.replace(/```json|```/g, '').trim();
        const cons = JSON.parse(consClean);
        console.log(`[Macro] ${meeting.bank} consensus: ${cons.expected_decision} ${cons.expected_bps || 0}bps (${cons.confidence})`);
        const { upsertConsensus } = require('./db');
        upsertConsensus(meeting.currency, meeting.date, { bank: meeting.bank, ...cons, source: 'claude' });
        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {
        console.error(`[Macro] ${meeting.bank} consensus error:`, e.message);
      }
    }
  } catch(e) {
    console.error('[Macro] Consensus fetch error:', e.message);
  }
}

function getMacroContext() { return macroContext; }

// Tracks last alert time per symbol to avoid spam (max 1 email per symbol per 2h)
const healthAlertState = {}; // { symbol: lastAlertTs }
const HEALTH_ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours between alerts per symbol

async function runHealthCheck() {
  if (!dbReady) return;
  const { isMarketOpen } = require('./marketHours');
  const db2 = require('./db');
  const PINE_STALE_MS  = 2 * 60 * 60 * 1000;
  const FXSSI_STALE_MS = 30 * 60 * 1000;
  const now = Date.now();

  const problems = [];

  for (const sym of Object.keys(SYMBOLS)) {
    if (!isMarketOpen(sym)) continue;
    const data     = db2.getLatestMarketData(sym);
    const lastSeen = data?.ts || null;
    const age      = lastSeen ? (now - lastSeen) : null;

    const alerts = [];
    if (!data)                                            alerts.push(`NO_DATA — no Pine alert received yet`);
    else if (age > PINE_STALE_MS)                         alerts.push(`PINE_STALE — last alert ${Math.round(age/60000)}m ago`);
    if (data?.fxssi_long_pct != null && age > FXSSI_STALE_MS) alerts.push(`FXSSI_STALE — order book ${Math.round(age/60000)}m old`);

    if (alerts.length === 0) {
      // Clear cooldown when symbol recovers
      delete healthAlertState[sym];
      continue;
    }

    // Cooldown — don't spam, max 1 email per symbol per 2h
    const lastAlert = healthAlertState[sym] || 0;
    if (now - lastAlert < HEALTH_ALERT_COOLDOWN_MS) continue;

    problems.push({ symbol: sym, alerts });
  }

  if (problems.length === 0) return;

  // Send one combined email for all degraded symbols
  const subject = `⚠ ATLAS//WATCHLIST DEGRADED — ${problems.map(p => p.symbol).join(', ')}`;
  const body = [
    `ATLAS//WATCHLIST health alert — ${new Date().toUTCString()}`,
    ``,
    `${problems.length} symbol(s) need attention:`,
    ``,
    ...problems.map(p => [
      `${p.symbol}:`,
      ...p.alerts.map(a => `  • ${a}`)
    ].join('\n')),
    ``,
    `Actions:`,
    `  • Check TradingView alerts are still active`,
    `  • Verify Pine Script indicator is on all 6 charts`,
    `  • Check FXSSI token is valid: ${process.env.ATLAS_URL || 'https://atlas-watchlist-production.up.railway.app'}/api/fxssi-test`,
    `  • Force FXSSI scrape: ${process.env.ATLAS_URL || 'https://atlas-watchlist-production.up.railway.app'}/api/fxssi-force`,
    `  • Full health status: ${process.env.ATLAS_URL || 'https://atlas-watchlist-production.up.railway.app'}/api/health`,
  ].join('\n');

  // Telegram — always send, regardless of email success
  sendHealthAlert(problems).catch(e => console.error('[Telegram] Health alert error:', e.message));

  // Email via Resend — best effort
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: 'ATLAS//WATCHLIST <onboarding@resend.dev>',
      to: process.env.ALERT_EMAIL || 'marounhashem@gmail.com',
      subject,
      text: body
    });

    console.log(`[Health] Alert email sent via Resend — ${problems.map(p => p.symbol).join(', ')}`);
  } catch (e) {
    console.error('[Health] Email send error:', e.message);
  }

  // Mark alert sent for all affected symbols
  for (const p of problems) {
    healthAlertState[p.symbol] = now;
  }
}

// Hourly intel cleanup
cron.schedule('5 * * * *', () => {
  try { db.clearExpiredIntel(); } catch(e) {}
});

// Daily DB backup at midnight UTC — keep 3 rolling backups
cron.schedule('0 0 * * *', () => {
  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/atlas.db');
    const backupPath = dbPath.replace('.db', `_backup_${new Date().toISOString().slice(0, 10)}.db`);
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, backupPath);
      console.log(`[DB] Daily backup written to ${backupPath}`);
      const backupDir = path.dirname(dbPath);
      const backups = fs.readdirSync(backupDir)
        .filter(f => f.includes('_backup_'))
        .sort()
        .reverse();
      backups.slice(3).forEach(f => {
        fs.unlinkSync(path.join(backupDir, f));
        console.log(`[DB] Deleted old backup: ${f}`);
      });
    }
  } catch(e) {
    console.error('[DB] Backup error:', e.message);
  }
});

// Cleanup market_data_history — keep 14 days, also vacuum to reclaim space
cron.schedule('0 1 * * *', () => {
  try {
    db.run('DELETE FROM market_data_history WHERE snapshot_ts < ?', [Date.now() - 14 * 86400000]);
    db.persist();
    console.log('[DB] Cleaned up market_data_history older than 14 days');
  } catch(e) {}
});

// Run health check every 30 minutes
cron.schedule('*/30 * * * *', () => {
  runHealthCheck().catch(e => console.error('[Health] Cron error:', e.message));
});
// Listen FIRST so healthcheck passes, then init DB in background
const PORT = process.env.PORT || 3001;
console.log('[Startup] 4 — crons registered', Date.now());
server.listen(PORT, () => {
  console.log('[Startup] 5 — HTTP listening on', PORT, Date.now());
  console.log('ATLAS//WATCHLIST ONLINE — port ' + PORT);
  console.log('Symbols: ' + Object.keys(SYMBOLS).length + ' priority loaded');
  // Init DB after server is accepting connections
  db.init().then(() => {
    dbReady = true;
    console.log('[Startup] 6 — DB loaded', Date.now());
    // Force immediate FXSSI scrape on startup — ensures order book data before first scoring cycle
    // Without this, signals fired in first 20min after deploy/restart have no order book
    setTimeout(() => {
      console.log('[Startup] Running initial FXSSI scrape...');
      runFXSSIScrape(null)
        .then(() => console.log('[Startup] Initial FXSSI scrape complete — order book ready'))
        .catch(e => console.error('[Startup] FXSSI scrape error:', e.message));
    }, 2000);
    // Seed COT data on first deploy if table is empty
    setTimeout(() => {
      console.log('[Startup] COT seed check starting...');
      try {
        const cotMod = require('./cotFetcher');
        const goldCOT = cotMod.getLatestCOT('GOLD');
        console.log('[Startup] COT seed check — GOLD data:', goldCOT ? 'exists' : 'EMPTY');
        if (!goldCOT) {
          console.log('[Startup] COT table empty — running initial fetch...');
          cotMod.runCOTFetch()
            .then(() => console.log('[Startup] Initial COT fetch complete'))
            .catch(e => console.error('[Startup] COT runCOTFetch error:', e.message, e.stack));
        }
      } catch(e) {
        console.error('[Startup] COT seed error:', e.message, e.stack);
      }
    }, 5000);
    // Load rate data from DB on startup — scrape only if DB empty/stale
    setTimeout(() => {
      try {
        const loaded = loadRatesFromDB();
        if (loaded === 0) {
          console.log('[Startup] No fresh rates in DB — scraping Myfxbook...');
          runRateFetch()
            .then(r => console.log(`[Startup] Rate scrape complete — ${r.fetched} currencies (${r.source})`))
            .catch(e => console.error('[Startup] Rate scrape error:', e.message));
        }
      } catch(e) {
        console.error('[Startup] Rate load error:', e.message);
      }
    }, 8000);
    // Seed economic calendar if empty
    setTimeout(() => {
      try {
        const events = getUpcomingHighImpactEvents(14);
        if (events.length === 0) {
          console.log('[Startup] Calendar empty — fetching Forex Factory...');
          runCalendarFetch()
            .then(r => console.log(`[Startup] Calendar fetch complete — ${r.stored} events`))
            .catch(e => console.error('[Startup] Calendar fetch error:', e.message));
        } else {
          console.log(`[Startup] Calendar has ${events.length} upcoming events`);
        }
      } catch(e) {
        console.error('[Startup] Calendar seed error:', e.message);
      }
    }, 9000);
    // Load macro context from DB on startup — DB only, NO API calls
    // Macro fetch is ONLY triggered by the 07:00 UTC cron, never on startup
    setTimeout(() => {
      try {
        const stored = db.getStoredMacroContext();
        const count = Object.keys(stored || {}).length;
        if (count > 0) {
          Object.assign(macroContext, stored);
          console.log(`[Startup] Loaded ${count} macro contexts from DB`);
        } else {
          console.log('[Startup] No macro context in DB — will be populated at 07:00 UTC cron');
        }
      } catch(e) {
        console.error('[Startup] Macro context load error:', e.message);
      }
    }, 10000);
    // Expire OPEN signals from old scorer versions — keeps board clean after deploys
    // ACTIVE signals (real trades) are never auto-expired
    try {
      const { SCORER_VERSION } = require('./scorer');
      const expired = db.expireOldVersionSignals(SCORER_VERSION);
      if (expired > 0) console.log(`[Startup] Expired ${expired} stale OPEN signal(s) from old scorer version`);
    } catch(e) { console.error('[Startup] Version expiry error:', e.message); }
    // Mark past unfired events as fired — prevents stale pre-event warnings
    try {
      const now = Date.now();
      const allEvts = db.getAllEconomicEvents() || [];
      let cleared = 0;
      for (const e of allEvts) {
        if (e.fired) continue;
        const eTs = new Date(e.event_date + 'T' + (e.event_time || '00:00:00') + 'Z').getTime();
        if (eTs < now) { db.run('UPDATE economic_events SET fired=1 WHERE id=?', [e.id]); cleared++; }
      }
      if (cleared > 0) { db.persist(); console.log(`[Startup] Cleared ${cleared} past unfired events`); }
    } catch(e) { console.error('[Startup] Event cleanup error:', e.message); }
    // Taxonomy backfill removed — was too aggressive, labeling all expired signals
    // with MFE>0.10% as MFE_CAPTURE_FAILURE. Taxonomy now set only by categoriseOutcome().
    // Expose macro context globally so scorer.js can access it in-process
    global.atlasGetMacroContext = getMacroContext;
    global.atlasGetDXY = () => db.getLatestDXY();
    global.atlasGetActiveIntel = (sym) => {
      const items = db.getActiveIntel();
      return items.filter(item => {
        if (!item.affected_symbols && !item.symbol) return true; // global
        if (item.symbol === sym) return true;
        try { return JSON.parse(item.affected_symbols || '[]').includes(sym); } catch(e) { return true; }
      }).map(i => i.summary || i.content);
    };
    // One-time intel seed if table is empty (restore after DB wipe)
    try {
      const intel = db.getActiveIntel();
      if (intel.length === 0) {
        console.log('[Startup] Intel table empty — seeding known context');
        const seed = [
          { content: 'Geopolitical tensions and elevated ISM inflation readings. Tariff war escalation risks. Bearish for risk assets, supportive for safe havens.', symbol: null, expiresInHours: 72 },
          { content: 'Nikkei Futures at critical technical juncture. Watch for BOJ policy signals.', symbol: 'J225', expiresInHours: 48 },
        ];
        for (const item of seed) {
          db.insertMarketIntel(item.content, item.symbol, null, item.expiresInHours);
        }
        db.persist();
        console.log(`[Startup] Seeded ${seed.length} intel items`);
      }
    } catch(e) {}
    // Macro fetch runs on schedule (07:00 UTC) only — not on startup to save API costs
  }).catch(e => {
    console.error('[DB] Init failed:', e.message);
  });
});

// Graceful shutdown — flush DB to disk before exit
process.on('SIGTERM', () => { console.log('[Shutdown] SIGTERM — flushing DB...'); db.persistNow(); setTimeout(() => process.exit(0), 2000); });
process.on('SIGINT',  () => { console.log('[Shutdown] SIGINT — flushing DB...');  db.persistNow(); setTimeout(() => process.exit(0), 2000); });
