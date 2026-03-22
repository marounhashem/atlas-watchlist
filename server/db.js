const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/atlas.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      ts INTEGER NOT NULL,
      close REAL,
      high REAL,
      low REAL,
      volume REAL,
      ema200 REAL,
      vwap REAL,
      rsi REAL,
      macd_hist REAL,
      bias INTEGER,
      bias_score REAL,
      structure TEXT,
      fvg_present INTEGER DEFAULT 0,
      fxssi_long_pct REAL,
      fxssi_short_pct REAL,
      fxssi_trapped TEXT,
      ob_absorption INTEGER DEFAULT 0,
      ob_imbalance REAL,
      ob_large_orders INTEGER DEFAULT 0,
      raw_payload TEXT
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      ts INTEGER NOT NULL,
      direction TEXT NOT NULL,
      score REAL NOT NULL,
      verdict TEXT NOT NULL,
      entry REAL,
      sl REAL,
      tp REAL,
      rr REAL,
      session TEXT,
      reasoning TEXT,
      outcome TEXT DEFAULT 'OPEN',
      outcome_ts INTEGER,
      pnl_pct REAL
    );

    CREATE TABLE IF NOT EXISTS weights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      ts INTEGER NOT NULL,
      pine_bias REAL DEFAULT 0.35,
      fxssi_sentiment REAL DEFAULT 0.25,
      order_book REAL DEFAULT 0.25,
      session_quality REAL DEFAULT 0.15,
      min_score_proceed REAL DEFAULT 70,
      win_rate REAL,
      sample_size INTEGER
    );

    CREATE TABLE IF NOT EXISTS learning_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      symbols_analysed TEXT,
      outcomes_used INTEGER,
      changes TEXT,
      reasoning TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
    CREATE INDEX IF NOT EXISTS idx_market_symbol ON market_data(symbol);
  `);

  // Seed default weights for each symbol if not present
  const { SYMBOLS } = require('./config');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO weights (symbol, ts, pine_bias, fxssi_sentiment, order_book, session_quality, min_score_proceed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [sym, cfg] of Object.entries(SYMBOLS)) {
    const w = cfg.scoringWeights;
    insert.run(sym, Date.now(), w.pineBias, w.fxssiSentiment, w.orderBook, w.sessionQuality, cfg.minScoreProceed);
  }
}

function upsertMarketData(symbol, data) {
  const d = getDb();
  d.prepare(`
    INSERT INTO market_data
      (symbol, ts, close, high, low, volume, ema200, vwap, rsi, macd_hist,
       bias, bias_score, structure, fvg_present, fxssi_long_pct, fxssi_short_pct,
       fxssi_trapped, ob_absorption, ob_imbalance, ob_large_orders, raw_payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    symbol, Date.now(),
    data.close, data.high, data.low, data.volume,
    data.ema200, data.vwap, data.rsi, data.macdHist,
    data.bias, data.biasScore, data.structure, data.fvgPresent ? 1 : 0,
    data.fxssiLongPct, data.fxssiShortPct, data.fxssiTrapped,
    data.obAbsorption ? 1 : 0, data.obImbalance, data.obLargeOrders ? 1 : 0,
    JSON.stringify(data)
  );
}

function getLatestMarketData(symbol) {
  return getDb().prepare(`
    SELECT * FROM market_data WHERE symbol = ? ORDER BY ts DESC LIMIT 1
  `).get(symbol);
}

function insertSignal(signal) {
  return getDb().prepare(`
    INSERT INTO signals (symbol, ts, direction, score, verdict, entry, sl, tp, rr, session, reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signal.symbol, Date.now(), signal.direction, signal.score,
    signal.verdict, signal.entry, signal.sl, signal.tp, signal.rr,
    signal.session, signal.reasoning
  ).lastInsertRowid;
}

function updateOutcome(signalId, outcome, pnlPct) {
  getDb().prepare(`
    UPDATE signals SET outcome = ?, outcome_ts = ?, pnl_pct = ? WHERE id = ?
  `).run(outcome, Date.now(), pnlPct, signalId);
}

function getOpenSignals() {
  return getDb().prepare(`
    SELECT * FROM signals WHERE outcome = 'OPEN' ORDER BY ts DESC
  `).all();
}

function getRecentOutcomes(limit = 80) {
  return getDb().prepare(`
    SELECT * FROM signals WHERE outcome != 'OPEN' ORDER BY ts DESC LIMIT ?
  `).all(limit);
}

function getWeights(symbol) {
  return getDb().prepare(`
    SELECT * FROM weights WHERE symbol = ? ORDER BY ts DESC LIMIT 1
  `).get(symbol);
}

function updateWeights(symbol, weights, winRate, sampleSize) {
  getDb().prepare(`
    INSERT INTO weights (symbol, ts, pine_bias, fxssi_sentiment, order_book, session_quality, min_score_proceed, win_rate, sample_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(symbol, Date.now(),
    weights.pineBias, weights.fxssiSentiment, weights.orderBook,
    weights.sessionQuality, weights.minScoreProceed, winRate, sampleSize
  );
}

function insertLearningLog(entry) {
  getDb().prepare(`
    INSERT INTO learning_log (ts, symbols_analysed, outcomes_used, changes, reasoning)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), entry.symbolsAnalysed, entry.outcomesUsed,
    JSON.stringify(entry.changes), entry.reasoning
  );
}

function getAllSignals(limit = 200) {
  return getDb().prepare(`
    SELECT * FROM signals ORDER BY ts DESC LIMIT ?
  `).all(limit);
}

function getLearningLog(limit = 20) {
  return getDb().prepare(`
    SELECT * FROM learning_log ORDER BY ts DESC LIMIT ?
  `).all(limit);
}

module.exports = {
  getDb, upsertMarketData, getLatestMarketData,
  insertSignal, updateOutcome, getOpenSignals, getRecentOutcomes,
  getWeights, updateWeights, insertLearningLog,
  getAllSignals, getLearningLog
};
