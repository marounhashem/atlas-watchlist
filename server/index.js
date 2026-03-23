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
const claudeLearner = require('./claudeLearner');
const { runFXSSIScrape, processBridgePayload } = require('./fxssiScraper');
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

  // Bias: handle object format {"score":-6,"bull":false,"bear":true} or number
  let bias = 0;
  if (data.bias !== null && data.bias !== undefined) {
    if (typeof data.bias === 'object') {
      bias = data.bias.score || (data.bias.bear ? -3 : data.bias.bull ? 3 : 0);
    } else {
      bias = Number(data.bias) || 0;
    }
  } else if (data.emaDir) {
    const d = data.emaDir;
    bias = (typeof d === 'object')
      ? ((d['5m']||0) + (d['1h']||0) + (d['4h']||0))
      : Number(d) || 0;
  }
  const biasScore = Math.abs(bias) / 6; // normalize -6..+6 range to 0..1

  // FVG — extract active flag and entry levels
  let fvg = false;
  let fvgHigh = null, fvgLow = null, fvgMid = null;
  if (data.fvg && typeof data.fvg === 'object') {
    fvg = data.fvg.bullActive || data.fvg.bearActive || false;
    // Use bear FVG for SHORT entry, bull FVG for LONG entry
    // Store the active one based on bias direction
    if (bias < 0 && data.fvg.bearActive) {
      fvgHigh = data.fvg.bearTop;
      fvgLow  = data.fvg.bearBot;
      fvgMid  = data.fvg.bearMid;
    } else if (bias > 0 && data.fvg.bullActive) {
      fvgHigh = data.fvg.bullTop;
      fvgLow  = data.fvg.bullBot;
      fvgMid  = data.fvg.bullMid;
    }
  } else {
    fvg = data.fvgPresent || false;
    fvgHigh = data.fvgHigh || null;
    fvgLow  = data.fvgLow  || null;
    fvgMid  = data.fvgMid  || null;
  }

  // Structure
  let structure = data.structure || 'ranging';
  if (typeof structure === 'object') {
    structure = structure.bull ? 'bullish' : structure.bear ? 'bearish' : 'ranging';
  }

  // MACD hist — handle nested object
  const macdHist = data.macd
    ? (data.macd.hist || data.macd.histogram || null)
    : (data.macdHist || null);

  // ATR — use 1h ATR for SL/TP calculations, fallback to range
  const atr1h = data.atr
    ? (data.atr['1h'] || data.atr['4h'] || null)
    : null;

  // VWAP extended flags
  const vwapExtended  = data.vwap?.extended  || false;
  const aboveUpper2   = data.vwap?.aboveUpper2 || false;
  const belowLower2   = data.vwap?.belowLower2 || false;

  // SR levels from swing structure
  const srResistance  = data.sr?.resistance || null;
  const srSupport     = data.sr?.support    || null;

  // Preserve existing FXSSI data — Pine webhook must not overwrite it with nulls
  const existing = require('./db').getLatestMarketData(sym);
  upsertMarketData(sym, {
    close:       price,
    high:        data.high,
    low:         data.low,
    volume:      data.volume,
    ema200:      ema200,
    vwap:        vwap,
    rsi:         rsi,
    macdHist:    macdHist,
    bias:        bias,
    biasScore:   data.biasScore || Math.abs(bias) / 3,
    structure:   structure,
    fvgPresent:  fvg,
    fvgHigh:     fvgHigh,
    fvgLow:      fvgLow,
    fvgMid:      fvgMid,
    // Preserve FXSSI data from last scrape — only overwrite if Pine sends it
    fxssiLongPct:  data.fxssiLongPct  || existing?.fxssi_long_pct  || null,
    fxssiShortPct: data.fxssiShortPct || existing?.fxssi_short_pct || null,
    fxssiTrapped:  data.fxssiTrapped  || existing?.fxssi_trapped   || null,
    obAbsorption:  data.obAbsorption  || existing?.ob_absorption   || false,
    obImbalance:   data.obImbalance   || existing?.ob_imbalance    || 0,
    obLargeOrders: data.obLargeOrders || existing?.ob_large_orders || false,
    fxssiAnalysis: existing?.fxssi_analysis || null,
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
      model: 'claude-sonnet-4-20250514',
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

// Reset — wipe signals and market data, keep weights and schema
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

// Claude learning endpoints
app.get('/api/claude/regime', (req, res) => {
  res.json(claudeLearner.getRegime() || { regime: 'UNKNOWN', summary: 'Not enough data yet' });
});

app.get('/api/claude/insights', (req, res) => {
  res.json(claudeLearner.getInsights());
});

app.get('/api/claude/patterns', (req, res) => {
  res.json(claudeLearner.getSessionPatterns());
});

app.get('/api/claude/optimisations', (req, res) => {
  res.json(claudeLearner.getAllOptimisations());
});

app.post('/api/claude/optimise/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const result = await claudeLearner.optimiseEntryLevels(symbol);
  res.json(result || { error: 'Not enough data (need 5+ closed trades)' });
});

app.post('/api/claude/regime-now', async (req, res) => {
  const regime = await claudeLearner.detectRegime();
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
app.post('/webhook/fxssi-rich', (req, res) => {
  const payload = req.body;
  if (!payload || !payload.fxssi) return res.status(400).json({ error: 'Missing fxssi data' });
  const result = processBridgePayload(payload);
  if (!result) return res.status(400).json({ error: 'Symbol not recognised or no market data' });
  broadcast({ type: 'FXSSI_UPDATE', symbol: result.symbol, analysed: result.analysed, ts: Date.now() });
  res.json({ ok: true, symbol: result.symbol });
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
app.get('/api/score-now', (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  let results;
  try { results = scoreAllPriority(); }
  catch(e) { return res.json({ error: e.message, stack: e.stack?.split('\n').slice(0,3) }); }
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
// Listen FIRST so healthcheck passes, then init DB in background
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('ATLAS//WATCHLIST ONLINE — port ' + PORT);
  console.log('Symbols: ' + Object.keys(SYMBOLS).length + ' priority loaded');
  // Init DB after server is accepting connections
  db.init().then(() => {
    dbReady = true;
    console.log('[DB] Initialised and ready');
  }).catch(e => {
    console.error('[DB] Init failed:', e.message);
  });
});
