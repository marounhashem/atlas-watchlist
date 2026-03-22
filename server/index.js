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

app.use(express.json());
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
  const data = req.body;
  if (!data || !data.symbol) return res.status(400).json({ error: 'Missing symbol' });

  const sym = data.symbol.toUpperCase();
  if (!SYMBOLS[sym]) {
    console.log(`[Webhook] Unknown symbol: ${sym}`);
    return res.status(200).json({ ok: true, note: 'Symbol not in priority list' });
  }

  // Gate: don't store data when market is closed
  if (!isMarketOpen(sym)) {
    return res.status(200).json({ ok: true, note: 'Market closed — data not stored' });
  }

  upsertMarketData(sym, {
    close: data.close,
    high: data.high,
    low: data.low,
    volume: data.volume,
    ema200: data.ema200,
    vwap: data.vwap,
    rsi: data.rsi,
    macdHist: data.macdHist,
    bias: data.bias,
    biasScore: data.biasScore,
    structure: data.structure,
    fvgPresent: data.fvgPresent,
    fxssiLongPct: data.fxssiLongPct,
    fxssiShortPct: data.fxssiShortPct,
    fxssiTrapped: data.fxssiTrapped,
    obAbsorption: data.obAbsorption,
    obImbalance: data.obImbalance,
    obLargeOrders: data.obLargeOrders
  });

  broadcast({ type: 'MARKET_UPDATE', symbol: sym, close: data.close, ts: Date.now() });
  console.log(`[Webhook] ${sym} @ ${data.close}`);
  res.json({ ok: true });
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

// Self-learning cycle every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  await runLearningCycle(broadcast);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
(async () => {
  await db.init();
  console.log('[DB] Initialised');
  server.listen(PORT, () => {
    console.log('ATLAS//WATCHLIST ONLINE — port ' + PORT);
    console.log('Symbols: ' + Object.keys(SYMBOLS).length + ' priority loaded');
  });
})();
