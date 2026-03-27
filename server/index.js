require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const path = require('path');

const db = require('./db');
const { upsertMarketData, getAllSignals, getWeights, getLearningLog, updateOutcome, updatePaperOutcome, getPaperTradeStats, retireActiveCycle, getCurrentCycleSignals, getPastCycleSignals } = db;
const { isMarketOpen, getMarketStatus, minutesUntilOpen } = require('./marketHours');
const { scoreAllPriority, saveSignal } = require('./scorer');
const { checkOutcomes } = require('./outcome');
const { runLearningCycle } = require('./learner');
const claudeLearner = require('./claudeLearner');
const { runFXSSIScrape, processBridgePayload, getFxssiCacheAge } = require('./fxssiScraper');
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

  // Structure — preserve raw object for raw_payload BEFORE converting to string
  const rawStructureObj = (data.structure && typeof data.structure === 'object') ? data.structure : null;
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

  // Momentum alignment score from v2 Pine (0-100)
  const momScore = data.momScore != null ? Number(data.momScore) : null;

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
    // v2 fields stored in raw_payload via JSON merge
    rawExtra: {
      momScore,
      structure: rawStructureObj,
      rsi:       data.rsi       && typeof data.rsi       === 'object' ? data.rsi       : null,
      rangeHigh: data.rangeHigh || null,
      rangeLow:  data.rangeLow  || null,
      sr: { resistance: data.sr?.resistance, support: data.sr?.support,
            swingH1: data.sr?.swingH1, swingH2: data.sr?.swingH2,
            swingL1: data.sr?.swingL1, swingL2: data.sr?.swingL2 },
      atr: data.atr || atr1h,
      vwap: { mid: vwap, upper1: data.vwap?.upper1, lower1: data.vwap?.lower1,
              upper2: data.vwap?.upper2, lower2: data.vwap?.lower2,
              aboveUpper2, belowLower2 }
    }
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
  res.json(db.getAllSignals(100));
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
    const all = db.getAllSignals(200);
    const outcomes = {}, cycles = {};
    for (const s of all) {
      outcomes[s.outcome] = (outcomes[s.outcome]||0) + 1;
      const c = s.cycle == null ? 'NULL' : s.cycle === 0 ? '0(current)' : 'retired';
      cycles[c] = (cycles[c]||0) + 1;
    }
    res.json({ dbReady, totalSignals: all.length, outcomes, cycles,
      sample: all.slice(0,5).map(s=>({ id:s.id, symbol:s.symbol, outcome:s.outcome, verdict:s.verdict, cycle:s.cycle })) });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/api/past-signals', (req, res) => {
  res.json(getPastCycleSignals(200));
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
app.get('/api/score-now', async (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  let results;
  try { results = await scoreAllPriority(); }
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

// ── Health check — Pine alert + FXSSI freshness per symbol ───────────────────
// Flags symbols where no Pine data received >2h during market hours,
// or FXSSI data is stale. Use this to detect TradingView alert failures.
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

// Force macro context refresh
app.post('/api/macro-refresh', async (req, res) => {
  res.json({ ok: true, message: 'Macro refresh started' });
  runMacroContextFetch(broadcast).catch(e => console.error('[Macro] Manual refresh error:', e.message));
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
    const results = await scoreAllPriority();
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
  await runRetirementCycle(broadcast);
});

// Learning engine — checks every hour, runs only when thresholds met
// Minimum 30 closed trades per symbol + 30 new outcomes since last cycle + 6h gap
cron.schedule('0 * * * *', async () => {
  await runLearningCycle(broadcast);
});

// Entry level optimisation — once per day at 18:00 UTC (after NY session closes)
// Runs per symbol — costs tokens so keep daily not hourly
cron.schedule('0 18 * * *', async () => {
  console.log('[Cron] Running daily entry level optimisation...');
  for (const symbol of Object.keys(SYMBOLS)) {
    await claudeLearner.optimiseEntryLevels(symbol).catch(e =>
      console.error(`[Claude] optimiseEntryLevels ${symbol}:`, e.message)
    );
    await new Promise(r => setTimeout(r, 2000));
  }
});

// Daily session summary — fires at 17:00 UTC (end of London session)
cron.schedule('0 17 * * *', async () => {
  console.log('[Cron] Running daily session summary...');
  await claudeLearner.dailySessionSummary(broadcast);
});

// Daily macro context — fires at 07:00 UTC (before London open)
// Fetches current macro environment for each symbol via web search
// Stored in DB and used by scorer as a macro alignment check
cron.schedule('0 7 * * *', async () => {
  console.log('[Cron] Running daily macro context fetch...');
  await runMacroContextFetch(broadcast);
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

async function runMacroContextFetch(broadcast) {
  if (!process.env.ANTHROPIC_API_KEY) return;

  const symbolQueries = {
    GOLD:   'gold XAU price macro outlook DXY Fed rates today',
    SILVER: 'silver XAG price macro outlook industrial demand today',
    OILWTI:'crude oil WTI price OPEC supply demand outlook today',
    BTCUSD:'bitcoin BTC macro outlook institutional flows today',
    US30:  'Dow Jones US30 macro outlook earnings Fed today',
    US100: 'Nasdaq US100 tech macro outlook Fed rates today'
  };

  for (const [symbol, query] of Object.entries(symbolQueries)) {
    try {
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
          system: `You are a macro analyst. Search for current market conditions and return ONLY a JSON object. No markdown, no explanation.`,
          messages: [{
            role: 'user',
            content: `Search: "${query}". Return ONLY this JSON:
{
  "sentiment": "BULLISH|BEARISH|NEUTRAL",
  "strength": <1-10, how strong is the macro bias>,
  "summary": "<one sentence, max 15 words>",
  "key_risks": ["<risk 1>", "<risk 2>"],
  "supports_long": <true|false>,
  "supports_short": <true|false>,
  "avoid_until": "<event or condition that would change this>"
}`
          }]
        })
      });

      const data = await response.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const clean = text.replace(/```json|```/g, '').trim();

      try {
        const ctx = JSON.parse(clean);
        macroContext[symbol] = { ...ctx, ts: Date.now() };
        console.log(`[Macro] ${symbol}: ${ctx.sentiment} (${ctx.strength}/10) — ${ctx.summary}`);
        if (broadcast) broadcast({ type: 'MACRO_UPDATE', symbol, context: macroContext[symbol], ts: Date.now() });
      } catch(e) {
        console.error(`[Macro] ${symbol} parse error:`, e.message);
      }

      // Small delay between symbols to avoid rate limiting
      await new Promise(r => setTimeout(r, 1500));

    } catch(e) {
      console.error(`[Macro] ${symbol} fetch error:`, e.message);
    }
  }

  console.log(`[Macro] Context refresh complete for ${Object.keys(macroContext).length} symbols`);
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

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: 'ATLAS//WATCHLIST <onboarding@resend.dev>',
      to: 'marounhashem@gmail.com',
      subject,
      text: body
    });

    console.log(`[Health] Alert email sent via Resend — ${problems.map(p => p.symbol).join(', ')}`);

    // Mark alert sent for all affected symbols
    for (const p of problems) {
      healthAlertState[p.symbol] = now;
    }
  } catch (e) {
    console.error('[Health] Email send error:', e.message);
  }
}

// Run health check every 30 minutes
cron.schedule('*/30 * * * *', () => {
  runHealthCheck().catch(e => console.error('[Health] Cron error:', e.message));
});
// Listen FIRST so healthcheck passes, then init DB in background
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('ATLAS//WATCHLIST ONLINE — port ' + PORT);
  console.log('Symbols: ' + Object.keys(SYMBOLS).length + ' priority loaded');
  // Init DB after server is accepting connections
  db.init().then(() => {
    dbReady = true;
    console.log('[DB] Initialised and ready');
    // Expire OPEN signals from old scorer versions — keeps board clean after deploys
    // ACTIVE signals (real trades) are never auto-expired
    try {
      const { SCORER_VERSION } = require('./scorer');
      const expired = db.expireOldVersionSignals(SCORER_VERSION);
      if (expired > 0) console.log(`[Startup] Expired ${expired} stale OPEN signal(s) from old scorer version`);
    } catch(e) { console.error('[Startup] Version expiry error:', e.message); }
    // Expose macro context globally so scorer.js can access it in-process
    global.atlasGetMacroContext = getMacroContext;
    // Macro fetch runs on schedule (07:00 UTC) only — not on startup to save API costs
  }).catch(e => {
    console.error('[DB] Init failed:', e.message);
  });
});
