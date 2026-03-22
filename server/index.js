require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const path = require('path');

const db = require('./db');
const { upsertMarketData, getAllSignals, getWeights, getLearningLog, updateOutcome } = db;
const { isMarketOpen, getMarketStatus, minutesUntilOpen } = require('./marketHours');
const { scoreAllPriority, saveSignal } = require('./scorer');
const { checkOutcomes } = require('./outcome');
const { runLearningCycle } = require('./learner');
const { SYMBOLS } = require('./config');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// DB ready flag — webhook queues until DB is initialised
let dbReady = false;

// Custom body parser that handles Pine Script's invalid NaN values
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
app.use(express.static(path.join(__dirname, '../client')));

// ── WebSocket broadcast ──────────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', ws => {
  console.log('[WS] Client connected');
  // Send current state on connect
  const signals = getAllSignals(50);
  ws.send(JSON.stringify({ type: 'INIT', signals, symbols: Object.keys(SYMBOLS) }));
});

// ── Webhook: TradingView Pine Script alerts ──────────────────────────────────
// Pine Script alert message format (JSON):
// { "symbol": "GOLD", "close": 3285, "high": 3292, "low": 3278,
//   "ema200": 3240, "vwap": 3281, "rsi": 62, "macdHist": 0.45,
//   "bias": 2, "biasScore": 0.72, "structure": "bullish",
//   "fvgPresent": true, "volume": 12400 }
app.post('/webhook/pine', (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB initialising, retry in 5s' });
  try {
  const data = req.body;

  // Accept both new format and existing ATLAS//FIVE Data Bridge format
  const rawSym = data.symbol || data.ticker || (data.source === 'ATLAS_PINE' ? data.symbol : null);
  if (!rawSym) return res.status(400).json({ error: 'Missing symbol' });

  const sym = rawSym.toUpperCase()
    .replace('XAUUSD','GOLD')
    .replace('XAGUSD','SILVER')
    .replace('USOIL','OILWTI')
    .replace('WTI','OILWTI')
    .replace('OIL_CRUDE','OILWTI')
    .replace('SPX500USD','US500')
    .replace('NAS100USD','US100')
    .replace('DE30EUR','DE40')
    .replace('UK100GBP','UK100')
    .replace('JP225USD','J225')
    .replace('HK50USD','HK50')
    .replace('CN50USD','CN50');

  if (!SYMBOLS[sym]) {
    console.log('[Webhook] Not in priority list:', sym);
    return res.status(200).json({ ok: true, note: 'Symbol not in priority list' });
  }

  if (!isMarketOpen(sym)) {
    return res.status(200).json({ ok: true, note: 'Market closed' });
  }

  // Map ATLAS//FIVE fields → watchlist fields
  const price   = data.price  || data.close;
  const ema200  = data.ema200 ? (typeof data.ema200 === 'object' ? data.ema200['1d'] || data.ema200['4h'] || data.ema200['1h'] : data.ema200) : null;
  const rsi     = data.rsi    ? (typeof data.rsi    === 'object' ? data.rsi['5m']   || data.rsi['1h']   : data.rsi)    : null;
  const vwap    = data.vwap   ? (typeof data.vwap   === 'object' ? data.vwap.mid    || data.vwap.upper1  : data.vwap)   : null;

  // Bias: use emaScore or derive from emaDir
  let bias = data.bias || 0;
  if (!bias && data.emaDir) {
    const d = data.emaDir;
    bias = (typeof d === 'object')
      ? ((d['5m']||0) + (d['1h']||0) + (d['4h']||0))
      : Number(d) || 0;
  }

  // FVG
  const fvg = data.fvg
    ? (data.fvg.bullActive || data.fvg.bearActive || false)
    : (data.fvgPresent || false);

  // Structure
  let structure = data.structure || 'ranging';
  if (typeof structure === 'object') {
    structure = structure.bull ? 'bullish' : structure.bear ? 'bearish' : 'ranging';
  }

  upsertMarketData(sym, {
    close:       price,
    high:        data.high,
    low:         data.low,
    volume:      data.volume,
    ema200:      ema200,
    vwap:        vwap,
    rsi:         rsi,
    macdHist:    data.macdHist || null,
    bias:        bias,
    biasScore:   data.biasScore || Math.abs(bias) / 3,
    structure:   structure,
    fvgPresent:  fvg,
    fxssiLongPct:  data.fxssiLongPct  || null,
    fxssiShortPct: data.fxssiShortPct || null,
    fxssiTrapped:  data.fxssiTrapped  || null,
    obAbsorption:  data.obAbsorption  || false,
    obImbalance:   data.obImbalance   || 0,
    obLargeOrders: data.obLargeOrders || false
  });

  // Verify the write worked
  const { getLatestMarketData } = require('./db');
  const check = getLatestMarketData(sym);
  console.log('[Webhook] Write check for ' + sym + ':', check ? 'SAVED @ ' + check.close : 'FAILED - not found in DB');
  broadcast({ type: 'MARKET_UPDATE', symbol: sym, close: price, ts: Date.now() });
  res.json({ ok: true, symbol: sym, price: price, bias: bias, saved: !!check });
  } catch(e) {
    console.error('[Webhook] Error processing ' + (req.body && req.body.symbol) + ':', e.message);
    res.status(200).json({ ok: true, note: 'Processed with errors: ' + e.message });
  }
});

// ── Webhook: FXSSI manual paste ──────────────────────────────────────────────
app.post('/webhook/fxssi', (req, res) => {
  const { symbol, longPct, shortPct, trapped } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
  const sym = symbol.toUpperCase();
  const latest = require('./db').getLatestMarketData(sym);
  if (latest) {
    upsertMarketData(sym, {
      ...JSON.parse(latest.raw_payload || '{}'),
      fxssiLongPct: longPct,
      fxssiShortPct: shortPct,
      fxssiTrapped: trapped
    });
  }
  res.json({ ok: true });
});

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/signals', (req, res) => {
  res.json(getAllSignals(100));
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

app.get('/api/market-status', (req, res) => {
  const status = getMarketStatus();
  // Attach minutes until open for closed symbols
  for (const [sym, s] of Object.entries(status)) {
    if (!s.open) s.minutesUntilOpen = minutesUntilOpen(sym);
  }
  res.json(status);
});

// Debug: check latest market data for a symbol
app.get('/api/data/:symbol', (req, res) => {
  const { getLatestMarketData } = require('./db');
  const data = getLatestMarketData(req.params.symbol.toUpperCase());
  res.json(data || { error: 'No data found for ' + req.params.symbol });
});

// Manual score trigger — for testing
app.get('/api/score-now', (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  const results = scoreAllPriority();
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
    symbols: Object.keys(SYMBOLS).length,
    uptime: Math.round(process.uptime()),
    ts: Date.now()
  });
});

// ── Cron jobs ─────────────────────────────────────────────────────────────────
// Score all priority symbols every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('[Cron] Running 5m scoring cycle...');
  const results = scoreAllPriority();
  const proceeds = results.filter(r => r.verdict === 'PROCEED');
  const watches = results.filter(r => r.verdict === 'WATCH');

  for (const r of [...proceeds, ...watches]) {
    const signalId = saveSignal(r);
    if (signalId) r.id = signalId;
  }

  broadcast({ type: 'SCORES', results, ts: Date.now() });

  if (proceeds.length > 0) {
    console.log(`[Cron] PROCEED signals: ${proceeds.map(r => r.symbol + ' ' + r.direction + ' ' + r.score + '%').join(', ')}`);
    broadcast({ type: 'ALERT', signals: proceeds, ts: Date.now() });
  }
});

// Check outcomes every 5 minutes
cron.schedule('2,7,12,17,22,27,32,37,42,47,52,57 * * * *', () => {
  checkOutcomes(broadcast);
});

// Learning engine — checks every hour, runs only when thresholds met
// Minimum 30 closed trades per symbol + 30 new outcomes since last cycle + 6h gap
cron.schedule('0 * * * *', async () => {
  await runLearningCycle(broadcast);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
(async () => {
  await db.init();
  dbReady = true;
  console.log('[DB] Initialised');
  server.listen(PORT, () => {
    console.log('ATLAS//WATCHLIST ONLINE — port ' + PORT);
    console.log('Symbols: ' + Object.keys(SYMBOLS).length + ' priority loaded');
  });
})();
