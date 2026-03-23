const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/atlas.db');
let SQL, db, ready = false;

async function init() {
  if (ready) return;
  try {
    const initSqlJs = require('sql.js');
    SQL = await initSqlJs();
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buf);
      console.log('[DB] Loaded existing database from', DB_PATH);
    } else {
      db = new SQL.Database();
      console.log('[DB] Created new in-memory database');
    }
    initSchema();
    persist();
    setInterval(persist, 15000); // flush every 15s
    ready = true;
    console.log('[DB] Ready');
  } catch(e) {
    console.error('[DB] Init failed:', e.message);
    throw e;
  }
}

function persist() {
  if (!db) return;
  try {
    const data = db.export();
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('[DB] Persist error:', e.message);
  }
}

function isReady() { return ready; }

function run(sql, params) {
  if (!db) throw new Error('DB not initialised');
  try {
    db.run(sql, params || []);
  } catch(e) {
    console.error('[DB] Run error:', e.message, '| SQL:', sql.slice(0,80));
    throw e;
  }
}

function get(sql, params) {
  if (!db) throw new Error('DB not initialised');
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params || []);
    if (stmt.step()) { const r = stmt.getAsObject(); stmt.free(); return r; }
    stmt.free();
    return undefined;
  } catch(e) {
    console.error('[DB] Get error:', e.message, '| SQL:', sql.slice(0,80));
    return undefined;
  }
}

function all(sql, params) {
  if (!db) throw new Error('DB not initialised');
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params || []);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch(e) {
    console.error('[DB] All error:', e.message, '| SQL:', sql.slice(0,80));
    return [];
  }
}

function initSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS market_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, ts INTEGER NOT NULL,
    close REAL, high REAL, low REAL, volume REAL, ema200 REAL, vwap REAL,
    rsi REAL, macd_hist REAL, bias INTEGER, bias_score REAL, structure TEXT,
    fvg_present INTEGER DEFAULT 0, fxssi_long_pct REAL, fxssi_short_pct REAL,
    fxssi_trapped TEXT, ob_absorption INTEGER DEFAULT 0, ob_imbalance REAL,
    ob_large_orders INTEGER DEFAULT 0, fxssi_analysis TEXT, raw_payload TEXT)`);

  db.run(`CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, ts INTEGER NOT NULL,
    direction TEXT NOT NULL, score REAL NOT NULL, verdict TEXT NOT NULL,
    entry REAL, sl REAL, tp REAL, rr REAL, session TEXT, reasoning TEXT,
    outcome TEXT DEFAULT 'OPEN', outcome_ts INTEGER, pnl_pct REAL)`);

  db.run(`CREATE TABLE IF NOT EXISTS weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, ts INTEGER NOT NULL,
    pine_bias REAL DEFAULT 0.35, fxssi_sentiment REAL DEFAULT 0.25,
    order_book REAL DEFAULT 0.25, session_quality REAL DEFAULT 0.15,
    min_score_proceed REAL DEFAULT 70, win_rate REAL, sample_size INTEGER)`);

  db.run(`CREATE TABLE IF NOT EXISTS learning_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    symbols_analysed TEXT, outcomes_used INTEGER, changes TEXT, reasoning TEXT)`);

  // Seed default weights
  const { SYMBOLS } = require('./config');
  for (const [sym, cfg] of Object.entries(SYMBOLS)) {
    const existing = get("SELECT id FROM weights WHERE symbol=? ORDER BY ts DESC LIMIT 1", [sym]);
    if (!existing) {
      const w = cfg.scoringWeights;
      run("INSERT INTO weights (symbol,ts,pine_bias,fxssi_sentiment,order_book,session_quality,min_score_proceed) VALUES (?,?,?,?,?,?,?)",
        [sym, Date.now(), w.pineBias, w.fxssiSentiment, w.orderBook, w.sessionQuality, cfg.minScoreProceed]);
    }
  }
  // Run migrations for new columns
  try { db.run('ALTER TABLE market_data ADD COLUMN fxssi_analysis TEXT'); console.log('[DB] Migration: added fxssi_analysis column'); } catch(e) {}

  console.log('[DB] Schema initialised, weights seeded');
}

function upsertMarketData(symbol, data) {
  const n = (v) => (v === null || v === undefined || isNaN(v)) ? null : Number(v);
  run(`INSERT INTO market_data
    (symbol,ts,close,high,low,volume,ema200,vwap,rsi,macd_hist,bias,bias_score,
     structure,fvg_present,fxssi_long_pct,fxssi_short_pct,fxssi_trapped,
     ob_absorption,ob_imbalance,ob_large_orders,fxssi_analysis,raw_payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [symbol, Date.now(),
     n(data.close), n(data.high), n(data.low), n(data.volume),
     n(data.ema200), n(data.vwap), n(data.rsi), n(data.macdHist),
     n(data.bias), n(data.biasScore),
     data.structure || 'ranging',
     data.fvgPresent ? 1 : 0,
     n(data.fxssiLongPct), n(data.fxssiShortPct),
     data.fxssiTrapped || null,
     data.obAbsorption ? 1 : 0,
     n(data.obImbalance),
     data.obLargeOrders ? 1 : 0,
     data.fxssiAnalysis || null,
     JSON.stringify(data)
    ]);
}

function getLatestMarketData(symbol) {
  return get("SELECT * FROM market_data WHERE symbol=? ORDER BY ts DESC LIMIT 1", [symbol]);
}

function insertSignal(signal) {
  run(`INSERT INTO signals (symbol,ts,direction,score,verdict,entry,sl,tp,rr,session,reasoning)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [signal.symbol, Date.now(), signal.direction, signal.score, signal.verdict,
     signal.entry, signal.sl, signal.tp, signal.rr, signal.session, signal.reasoning]);
  const row = get("SELECT last_insert_rowid() as id");
  persist(); // save immediately after signal
  return row ? row.id : null;
}

function updateOutcome(signalId, outcome, pnlPct) {
  run("UPDATE signals SET outcome=?,outcome_ts=?,pnl_pct=? WHERE id=?",
    [outcome, Date.now(), pnlPct || 0, signalId]);
  persist();
}

function getOpenSignals()      { return all("SELECT * FROM signals WHERE outcome IN ('OPEN','ACTIVE') ORDER BY ts DESC"); }
function getRecentOutcomes(n)  { return all("SELECT * FROM signals WHERE outcome!='OPEN' ORDER BY ts DESC LIMIT ?", [n||80]); }
function getWeights(symbol)    { return get("SELECT * FROM weights WHERE symbol=? ORDER BY ts DESC LIMIT 1", [symbol]); }
function getAllSignals(n)       { return all("SELECT * FROM signals ORDER BY ts DESC LIMIT ?", [n||200]); }
function getLearningLog(n)     { return all("SELECT * FROM learning_log ORDER BY ts DESC LIMIT ?", [n||20]); }

function updateWeights(symbol, weights, winRate, sampleSize) {
  run(`INSERT INTO weights (symbol,ts,pine_bias,fxssi_sentiment,order_book,session_quality,min_score_proceed,win_rate,sample_size)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [symbol, Date.now(), weights.pineBias, weights.fxssiSentiment,
     weights.orderBook, weights.sessionQuality, weights.minScoreProceed,
     winRate, sampleSize]);
  persist();
}

function insertLearningLog(entry) {
  run("INSERT INTO learning_log (ts,symbols_analysed,outcomes_used,changes,reasoning) VALUES (?,?,?,?,?)",
    [Date.now(), entry.symbolsAnalysed, entry.outcomesUsed,
     JSON.stringify(entry.changes), entry.reasoning]);
  persist();
}

// Get latest signal for a symbol with specific outcome
function getLatestOpenSignal(symbol, direction) {
  return get(
    "SELECT * FROM signals WHERE symbol=? AND direction=? AND outcome='OPEN' ORDER BY ts DESC LIMIT 1",
    [symbol, direction]
  );
}

module.exports = {
  init, isReady, persist, run,
  upsertMarketData, getLatestMarketData,
  insertSignal, updateOutcome,
  getOpenSignals, getRecentOutcomes,
  getWeights, updateWeights,
  insertLearningLog, getAllSignals, getLearningLog,
  getLatestOpenSignal
};
