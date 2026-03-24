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
    fvg_present INTEGER DEFAULT 0, fvg_high REAL, fvg_low REAL, fvg_mid REAL,
    fxssi_long_pct REAL, fxssi_short_pct REAL,
    fxssi_trapped TEXT, ob_absorption INTEGER DEFAULT 0, ob_imbalance REAL,
    ob_large_orders INTEGER DEFAULT 0, fxssi_analysis TEXT, raw_payload TEXT)`);

  db.run(`CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, ts INTEGER NOT NULL,
    direction TEXT NOT NULL, score REAL NOT NULL, verdict TEXT NOT NULL,
    entry REAL, sl REAL, tp REAL, rr REAL, session TEXT, reasoning TEXT,
    outcome TEXT DEFAULT 'OPEN', outcome_ts INTEGER, pnl_pct REAL)`);

  db.run(`CREATE TABLE IF NOT EXISTS weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, ts INTEGER NOT NULL,
    pine REAL DEFAULT 0.40, fxssi REAL DEFAULT 0.45,
    session REAL DEFAULT 0.15,
    min_score_proceed REAL DEFAULT 70,
    entry_fxssi_weight REAL DEFAULT 0.50,
    sl_fxssi_weight REAL DEFAULT 0.50,
    tp_fxssi_weight REAL DEFAULT 0.50,
    win_rate REAL, sample_size INTEGER)`);

  db.run(`CREATE TABLE IF NOT EXISTS learning_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    symbols_analysed TEXT, outcomes_used INTEGER, changes TEXT, reasoning TEXT)`);

  // Seed default weights
  const { SYMBOLS } = require('./config');
  for (const [sym, cfg] of Object.entries(SYMBOLS)) {
    const existing = get("SELECT id FROM weights WHERE symbol=? ORDER BY ts DESC LIMIT 1", [sym]);
    if (!existing) {
      const w = cfg.scoringWeights;
      run("INSERT INTO weights (symbol,ts,pine,fxssi,session,min_score_proceed,entry_fxssi_weight,sl_fxssi_weight,tp_fxssi_weight) VALUES (?,?,?,?,?,?,?,?,?)",
        [sym, Date.now(), w.pine, w.fxssi, w.session, cfg.minScoreProceed, 0.50, 0.50, 0.50]);
    }
  }
  // Migrate old 4-column weights table to new 3-column schema
  try { db.run('ALTER TABLE weights ADD COLUMN pine REAL DEFAULT 0.40'); } catch(e) {}
  try { db.run('ALTER TABLE weights ADD COLUMN fxssi REAL DEFAULT 0.45'); } catch(e) {}
  try { db.run('ALTER TABLE weights ADD COLUMN session REAL DEFAULT 0.15'); } catch(e) {}
  try { db.run('ALTER TABLE weights ADD COLUMN entry_fxssi_weight REAL DEFAULT 0.50'); } catch(e) {}
  try { db.run('ALTER TABLE weights ADD COLUMN sl_fxssi_weight REAL DEFAULT 0.50'); } catch(e) {}
  try { db.run('ALTER TABLE weights ADD COLUMN tp_fxssi_weight REAL DEFAULT 0.50'); } catch(e) {}
  // Backfill pine/fxssi/session from old columns if they exist
  try {
    db.run('UPDATE weights SET pine=COALESCE(pine_bias,0.40), fxssi=COALESCE(pine_bias,0.45), session=COALESCE(session_quality,0.15) WHERE pine IS NULL OR pine=0');
  } catch(e) {}
  // Run migrations for new columns
  try { db.run('ALTER TABLE market_data ADD COLUMN fxssi_analysis TEXT'); console.log('[DB] Migration: added fxssi_analysis column'); } catch(e) {}
  try { db.run('ALTER TABLE market_data ADD COLUMN fvg_high REAL'); } catch(e) {}
  try { db.run('ALTER TABLE market_data ADD COLUMN fvg_low REAL'); } catch(e) {}
  try { db.run('ALTER TABLE market_data ADD COLUMN fvg_mid REAL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN paper_outcome TEXT DEFAULT NULL'); console.log('[DB] Migration: added paper_outcome column'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN paper_outcome_ts INTEGER DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN fxssi_stale INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN mfe REAL DEFAULT NULL'); console.log('[DB] Migration: added mfe column'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN mfe_pct REAL DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN cycle INTEGER DEFAULT 0'); console.log('[DB] Migration: added cycle column'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN retired_at INTEGER DEFAULT NULL'); } catch(e) {}
  // Backfill cycle=NULL → 0 unconditionally (safe no-op if already done)
  try { db.run('UPDATE signals SET cycle=0 WHERE cycle IS NULL'); } catch(e) { console.error('[DB] Backfill error:', e.message); }

  console.log('[DB] Schema initialised, weights seeded');
}

function upsertMarketData(symbol, data) {
  const n = (v) => (v === null || v === undefined || isNaN(v)) ? null : Number(v);

  // Check if fxssi_analysis column exists (added via migration)
  let hasFxssiCol = false;
  try {
    const cols = db.exec("PRAGMA table_info(market_data)")[0]?.values || [];
    hasFxssiCol = cols.some(c => c[1] === 'fxssi_analysis');
  } catch(e) {}

  const baseParams = [
    symbol, Date.now(),
    n(data.close), n(data.high), n(data.low), n(data.volume),
    n(data.ema200), n(data.vwap), n(data.rsi), n(data.macdHist),
    n(data.bias), n(data.biasScore),
    data.structure || 'ranging',
    data.fvgPresent ? 1 : 0,
    n(data.fvgHigh), n(data.fvgLow), n(data.fvgMid),
    n(data.fxssiLongPct), n(data.fxssiShortPct),
    data.fxssiTrapped || null,
    data.obAbsorption ? 1 : 0,
    n(data.obImbalance),
    data.obLargeOrders ? 1 : 0
  ];

  if (hasFxssiCol) {
    run(`INSERT INTO market_data
      (symbol,ts,close,high,low,volume,ema200,vwap,rsi,macd_hist,bias,bias_score,
       structure,fvg_present,fvg_high,fvg_low,fvg_mid,
       fxssi_long_pct,fxssi_short_pct,fxssi_trapped,
       ob_absorption,ob_imbalance,ob_large_orders,
       fxssi_analysis,raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...baseParams, data.fxssiAnalysis || null,
        JSON.stringify({ ...data, ...(data.rawExtra || {}) })]
    );
  } else {
    run(`INSERT INTO market_data
      (symbol,ts,close,high,low,volume,ema200,vwap,rsi,macd_hist,bias,bias_score,
       structure,fvg_present,fvg_high,fvg_low,fvg_mid,
       fxssi_long_pct,fxssi_short_pct,fxssi_trapped,
       ob_absorption,ob_imbalance,ob_large_orders,raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...baseParams, JSON.stringify({ ...data, ...(data.rawExtra || {}) })]
    );
  }
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

// Paper trade outcome — only for WATCH signals, tracked separately
function updatePaperOutcome(signalId, paperOutcome) {
  run("UPDATE signals SET paper_outcome=?,paper_outcome_ts=? WHERE id=? AND verdict='WATCH'",
    [paperOutcome, Date.now(), signalId]);
  persist();
}

// Paper trade stats — how would WATCH signals have performed if taken?
function getPaperTradeStats() {
  const watchSignals = all("SELECT * FROM signals WHERE verdict='WATCH' AND paper_outcome IS NOT NULL ORDER BY ts DESC LIMIT 200");
  const wins   = watchSignals.filter(s => s.paper_outcome === 'WIN').length;
  const losses = watchSignals.filter(s => s.paper_outcome === 'LOSS').length;
  const total  = wins + losses;
  return {
    total, wins, losses,
    winRate: total > 0 ? Math.round((wins / total) * 100) : null,
    sample: watchSignals.slice(0, 20)
  };
}

function getOpenSignals()      { return all("SELECT * FROM signals WHERE outcome IN ('OPEN','ACTIVE') ORDER BY ts DESC"); }
function getRecentOutcomes(n)  { return all("SELECT * FROM signals WHERE outcome!='OPEN' ORDER BY ts DESC LIMIT ?", [n||80]); }
function getWeights(symbol)    { return get("SELECT * FROM weights WHERE symbol=? ORDER BY ts DESC LIMIT 1", [symbol]); }
function getAllSignals(n)       { return all("SELECT * FROM signals ORDER BY ts DESC LIMIT ?", [n||200]); }
function getLearningLog(n)     { return all("SELECT * FROM learning_log ORDER BY ts DESC LIMIT ?", [n||20]); }

function updateWeights(symbol, weights, winRate, sampleSize) {
  run(`INSERT INTO weights (symbol,ts,pine,fxssi,session,min_score_proceed,
       entry_fxssi_weight,sl_fxssi_weight,tp_fxssi_weight,win_rate,sample_size)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [symbol, Date.now(),
     weights.pine, weights.fxssi, weights.session, weights.minScoreProceed,
     weights.entryFxssiWeight ?? 0.50,
     weights.slFxssiWeight   ?? 0.50,
     weights.tpFxssiWeight   ?? 0.50,
     winRate, sampleSize]);
  persist();
}

function insertLearningLog(entry) {
  run("INSERT INTO learning_log (ts,symbols_analysed,outcomes_used,changes,reasoning) VALUES (?,?,?,?,?)",
    [Date.now(), entry.symbolsAnalysed, entry.outcomesUsed,
     JSON.stringify(entry.changes), entry.reasoning]);
  persist();
}

// Get latest signal for current cycle only — retired signals invisible to dedup
// Get latest signal for current cycle only — retired signals invisible to dedup
function getLatestOpenSignal(symbol, direction) {
  // Block new signals if ACTIVE already exists for this symbol+direction
  // Can't take two concurrent trades on the same instrument
  const active = get(
    "SELECT * FROM signals WHERE symbol=? AND direction=? AND outcome='ACTIVE' AND (cycle IS NULL OR cycle=0) ORDER BY ts DESC LIMIT 1",
    [symbol, direction]
  );
  if (active) return active;
  return get(
    "SELECT * FROM signals WHERE symbol=? AND direction=? AND outcome='OPEN' AND (cycle IS NULL OR cycle=0) ORDER BY ts DESC LIMIT 1",
    [symbol, direction]
  );
}

// Retire all ACTIVE signals for a symbol — moves them to past cycle
// Check if two entry prices are within 1% of each other
function entriesWithinPct(e1, e2, pct) {
  if (!e1 || !e2) return false;
  return Math.abs(e1 - e2) / e1 <= (pct / 100);
}

// Merge signal B into signal A — averaged entry/SL/TP, keep A's id and outcome
function mergeSignals(keepId, absorbId) {
  const keep    = get('SELECT * FROM signals WHERE id=?', [keepId]);
  const absorb  = get('SELECT * FROM signals WHERE id=?', [absorbId]);
  if (!keep || !absorb) return false;

  const avg = (a, b) => (a && b) ? Math.round(((a + b) / 2) * 10000) / 10000 : (a || b);

  const newEntry = avg(keep.entry, absorb.entry);
  const newSl    = avg(keep.sl,    absorb.sl);
  const newTp    = avg(keep.tp,    absorb.tp);

  // Recalculate R:R from merged levels
  let newRr = keep.rr;
  if (newEntry && newSl && newTp) {
    const risk   = Math.abs(newEntry - newSl);
    const reward = Math.abs(newTp    - newEntry);
    newRr = risk > 0 ? Math.round((reward / risk) * 10) / 10 : keep.rr;
  }

  run('UPDATE signals SET entry=?, sl=?, tp=?, rr=?, reasoning=? WHERE id=?',
    [newEntry, newSl, newTp, newRr,
     `[MERGED] ${keep.reasoning || ''}`,
     keepId]);

  // Mark absorbed signal as REPLACED so it disappears from all views
  run("UPDATE signals SET outcome='REPLACED', outcome_ts=? WHERE id=?",
    [Date.now(), absorbId]);

  persist();
  console.log(`[DB] Merged signal ${absorbId} into ${keepId} (${keep.symbol} ${keep.direction}) entry ${keep.entry}→${newEntry} sl ${keep.sl}→${newSl} tp ${keep.tp}→${newTp}`);
  return true;
}

function retireActiveCycle(symbol) {
  const now = Date.now();

  // Only ACTIVE signals (entry touched) are candidates
  const retiring = all(
    "SELECT * FROM signals WHERE symbol=? AND outcome='ACTIVE' AND (cycle IS NULL OR cycle=0) ORDER BY ts ASC",
    [symbol]
  );
  if (retiring.length === 0) return 0;

  // ── Step 1: Merge same-cycle duplicates first ─────────────────────────────
  // Two ACTIVE signals in the same cycle = same trade fired twice 5min apart
  // Keep the oldest (first entry), absorb the newer one
  const dedupedRetiring = [];
  const absorbedIds = new Set();

  for (let i = 0; i < retiring.length; i++) {
    if (absorbedIds.has(retiring[i].id)) continue;
    let kept = retiring[i];
    for (let j = i + 1; j < retiring.length; j++) {
      if (absorbedIds.has(retiring[j].id)) continue;
      if (retiring[j].direction !== kept.direction) continue;
      if (!entriesWithinPct(kept.entry, retiring[j].entry, 1.0)) continue;
      // Same direction, within 1% — merge newer into older
      mergeSignals(kept.id, retiring[j].id);
      absorbedIds.add(retiring[j].id);
      console.log(`[DB] ${symbol} same-cycle merge: absorbed signal ${retiring[j].id} into ${kept.id}`);
    }
    dedupedRetiring.push(kept);
  }

  // ── Step 2: Check against already-retired past ACTIVE signals ─────────────
  const monitoring = all(
    "SELECT * FROM signals WHERE symbol=? AND outcome='ACTIVE' AND (cycle IS NOT NULL AND cycle>0)",
    [symbol]
  );

  let merged = 0;
  const toRetire = [];

  for (const ret of dedupedRetiring) {
    let mergedThis = false;
    for (const mon of monitoring) {
      if (ret.direction !== mon.direction) continue;
      if (!entriesWithinPct(ret.entry, mon.entry, 1.0)) continue;
      mergeSignals(mon.id, ret.id);
      merged++;
      mergedThis = true;
      break;
    }
    if (!mergedThis) toRetire.push(ret.id);
  }

  // ── Step 3: Retire what's left ────────────────────────────────────────────
  if (toRetire.length > 0) {
    const placeholders = toRetire.map(() => '?').join(',');
    run(
      `UPDATE signals SET cycle=?, retired_at=? WHERE id IN (${placeholders})`,
      [now, now, ...toRetire]
    );
  }

  persist();
  const retired = toRetire.length;
  const sameCycleMerged = absorbedIds.size;
  if (retired > 0 || merged > 0 || sameCycleMerged > 0) {
    console.log(`[DB] ${symbol} — retired: ${retired}, cross-cycle merged: ${merged}, same-cycle merged: ${sameCycleMerged}`);
  }
  return retired + merged + sameCycleMerged;
}

// Get all signals for current cycle (main board)
function getCurrentCycleSignals(n) {
  return all("SELECT * FROM signals WHERE (cycle IS NULL OR cycle=0) ORDER BY ts DESC LIMIT ?", [n || 100]);
}

// Get all retired/past cycle signals
function getPastCycleSignals(n) {
  return all("SELECT * FROM signals WHERE (cycle IS NOT NULL AND cycle>0) ORDER BY ts DESC LIMIT ?", [n || 200]);
}

// Get open signals for current cycle only — used by dedup gate
function getCurrentCycleOpenSignals() {
  return all("SELECT * FROM signals WHERE outcome IN ('OPEN','ACTIVE') AND (cycle IS NULL OR cycle=0) ORDER BY ts DESC");
}

// Update MFE — works across both current and past cycles
function updateMFE(signalId, mfe, mfePct) {
  run("UPDATE signals SET mfe=?, mfe_pct=? WHERE id=? AND (mfe IS NULL OR mfe < ?)",
    [mfe, mfePct, signalId, mfe]);
}

module.exports = {
  init, isReady, persist, run,
  upsertMarketData, getLatestMarketData,
  insertSignal, updateOutcome, updatePaperOutcome, getPaperTradeStats, updateMFE,
  getOpenSignals, getRecentOutcomes,
  getWeights, updateWeights,
  insertLearningLog, getAllSignals, getLearningLog,
  getLatestOpenSignal,
  retireActiveCycle, getCurrentCycleSignals, getPastCycleSignals, getCurrentCycleOpenSignals
};
