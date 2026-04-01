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
      const stat = fs.statSync(DB_PATH);
      if (stat.size > 0) {
        const buf = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buf);
        console.log(`[DB] Loaded existing database from ${DB_PATH} (${Math.round(stat.size/1024)}KB)`);
      } else {
        console.warn('[DB] WARNING: DB file exists but is EMPTY — creating new database');
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
      console.log('[DB] Created new in-memory database');
    }
    initSchema();

    // Safety: only persist if we didn't load an existing DB with data
    // Prevents overwriting good DB with empty one on volume mount race
    const signalCount = (() => {
      try {
        const row = db.exec("SELECT COUNT(*) as c FROM signals")[0];
        return row?.values?.[0]?.[0] || 0;
      } catch(e) { return 0; }
    })();
    if (signalCount > 0 || !fs.existsSync(DB_PATH)) {
      persist();
    } else {
      console.log('[DB] Skipping initial persist — new empty DB, waiting for data before writing to disk');
    }

    setInterval(persist, 15000);
    ready = true;
    console.log(`[DB] Ready — ${signalCount} existing signals`);
  } catch(e) {
    console.error('[DB] Init failed:', e.message);
    throw e;
  }
}

let _persistPending = false;
let _persistWriting = false;

function persist() {
  if (!db) return;
  // Coalesce: if a write is already in flight, just flag that another is needed
  if (_persistWriting) { _persistPending = true; return; }
  _persistWriting = true;
  try {
    const data = db.export();
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFile(DB_PATH, Buffer.from(data), (err) => {
      _persistWriting = false;
      if (err) console.error('[DB] Persist error:', err.message);
      // If another persist was requested while we were writing, flush again
      if (_persistPending) { _persistPending = false; persist(); }
    });
  } catch (e) {
    _persistWriting = false;
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
    ob_large_orders INTEGER DEFAULT 0, fxssi_analysis TEXT, fxssi_hourly_analysis TEXT, raw_payload TEXT)`);

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
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT, ts INTEGER
  )`);
  // Economic calendar events — Forex Factory HIGH impact events
  db.run(`CREATE TABLE IF NOT EXISTS economic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    title TEXT NOT NULL,
    currency TEXT NOT NULL,
    event_date TEXT NOT NULL,
    event_time TEXT,
    impact TEXT,
    forecast TEXT,
    previous TEXT,
    actual TEXT,
    fired INTEGER DEFAULT 0,
    ts INTEGER NOT NULL
  )`);
  // Migrations for existing DBs
  try { db.run('ALTER TABLE economic_events ADD COLUMN event_id TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE economic_events ADD COLUMN fired INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE economic_events ADD COLUMN sentiment INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE economic_events ADD COLUMN sentiment_magnitude TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE economic_events ADD COLUMN sentiment_summary TEXT'); } catch(e) {}

  // Macro context — persisted so it survives restarts
  db.run(`CREATE TABLE IF NOT EXISTS macro_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    sentiment TEXT,
    strength INTEGER,
    summary TEXT,
    key_risks TEXT,
    supports_long INTEGER,
    supports_short INTEGER,
    avoid_until TEXT,
    ts INTEGER NOT NULL
  )`);

  // Central bank consensus — market expectations for upcoming meetings
  db.run(`CREATE TABLE IF NOT EXISTS cb_consensus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency TEXT NOT NULL,
    bank TEXT NOT NULL,
    meeting_date TEXT NOT NULL,
    expected_decision TEXT,
    expected_bps INTEGER,
    confidence TEXT,
    summary TEXT,
    source TEXT,
    ts INTEGER NOT NULL
  )`);

  // Central bank interest rates — daily fetch from Trading Economics
  db.run(`CREATE TABLE IF NOT EXISTS rate_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency TEXT NOT NULL,
    rate_pct REAL NOT NULL,
    last_updated TEXT,
    ts INTEGER NOT NULL
  )`);

  // COT (Commitment of Traders) — weekly CFTC institutional positioning data
  db.run(`CREATE TABLE IF NOT EXISTS cot_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    report_date TEXT NOT NULL,
    net_noncomm INTEGER,
    net_comm INTEGER,
    open_interest INTEGER,
    change_net_noncomm INTEGER,
    noncomm_long INTEGER,
    noncomm_short INTEGER,
    comm_long INTEGER,
    comm_short INTEGER,
    ts INTEGER NOT NULL
  )`);

  // WATCH signals — separate table, not mixed with live tradeable signals
  // Used for learning and pattern analysis only — never shown as active trades
  db.run(`CREATE TABLE IF NOT EXISTS watch_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT, ts INTEGER, direction TEXT, score INTEGER,
    entry REAL, sl REAL, tp REAL, rr REAL,
    session TEXT, reasoning TEXT, scorer_version TEXT,
    mfe REAL DEFAULT NULL, mfe_pct REAL DEFAULT NULL,
    outcome TEXT DEFAULT 'PENDING',
    outcome_ts INTEGER DEFAULT NULL, pnl_pct REAL DEFAULT NULL
  )`);

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
  try { db.run('ALTER TABLE market_data ADD COLUMN fxssi_hourly_analysis TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN paper_outcome TEXT DEFAULT NULL'); console.log('[DB] Migration: added paper_outcome column'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN paper_outcome_ts INTEGER DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN fxssi_stale INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN mfe REAL DEFAULT NULL'); console.log('[DB] Migration: added mfe column'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN mfe_pct REAL DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN cycle INTEGER DEFAULT 0'); console.log('[DB] Migration: added cycle column'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN retired_at INTEGER DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN scorer_version TEXT DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN refine_count INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN recommendations TEXT DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN rec_followed INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN refine_ts INTEGER DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN event_risk_tag TEXT DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE watch_signals ADD COLUMN event_risk_tag TEXT DEFAULT NULL'); } catch(e) {}
  try { db.run('ALTER TABLE signals ADD COLUMN macro_context_available INTEGER DEFAULT 0'); } catch(e) {}
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
       fxssi_analysis,fxssi_hourly_analysis,raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...baseParams, data.fxssiAnalysis || null, data.fxssiHourlyAnalysis || null,
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
  persist(); // flush market data to disk on every write
}

function getLatestMarketData(symbol) {
  return get("SELECT * FROM market_data WHERE symbol=? ORDER BY ts DESC LIMIT 1", [symbol]);
}

function insertSignal(signal) {
  run(`INSERT INTO signals (symbol,ts,direction,score,verdict,entry,sl,tp,rr,session,reasoning,scorer_version,macro_context_available,event_risk_tag)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [signal.symbol, Date.now(), signal.direction, signal.score, signal.verdict,
     signal.entry, signal.sl, signal.tp, signal.rr, signal.session, signal.reasoning,
     signal.scorerVersion || null, signal.macroContextAvailable ? 1 : 0,
     signal.eventRiskTag || null]);
  const row = get("SELECT last_insert_rowid() as id");
  persist();
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
  // Block new signals if ACTIVE already exists for this symbol+direction in ANY cycle
  // An ACTIVE signal = entry touched = real position — must not create duplicates
  // regardless of whether the signal was retired to a past cycle
  const active = get(
    "SELECT * FROM signals WHERE symbol=? AND direction=? AND outcome='ACTIVE' ORDER BY ts DESC LIMIT 1",
    [symbol, direction]
  );
  if (active) return active;

  // Check for OPEN signal in OPPOSITE direction — expire it so new direction can proceed
  // IMPORTANT: Only expire OPEN signals (not yet entered)
  // ACTIVE signals = entry touched = trader may be in a real trade — DO NOT auto-expire
  // Let the trader manage their active trade manually
  const oppositeDir = direction === 'LONG' ? 'SHORT' : 'LONG';
  const oppositeOpen = get(
    "SELECT * FROM signals WHERE symbol=? AND direction=? AND outcome='OPEN' AND (cycle IS NULL OR cycle=0) ORDER BY ts DESC LIMIT 1",
    [symbol, oppositeDir]
  );
  if (oppositeOpen) {
    // Opposite direction is OPEN (not yet entered) — safe to expire
    run("UPDATE signals SET outcome='EXPIRED', outcome_ts=? WHERE id=?",
      [Date.now(), oppositeOpen.id]);
    persist();
    console.log(`[DB] ${symbol} — expired opposite ${oppositeDir} OPEN (id:${oppositeOpen.id}) — new ${direction} signal taking over`);
  }

  // If opposite ACTIVE exists — do NOT auto-expire, just log a warning
  const oppositeActive = get(
    "SELECT * FROM signals WHERE symbol=? AND direction=? AND outcome='ACTIVE' AND (cycle IS NULL OR cycle=0) ORDER BY ts DESC LIMIT 1",
    [symbol, oppositeDir]
  );
  if (oppositeActive) {
    console.log(`[DB] ${symbol} — WARNING: opposite ${oppositeDir} ACTIVE (id:${oppositeActive.id}) still open — new ${direction} signal generated but NOT auto-closing active trade`);
  }

  return get(
    "SELECT * FROM signals WHERE symbol=? AND direction=? AND outcome='OPEN' AND (cycle IS NULL OR cycle=0) ORDER BY ts DESC LIMIT 1",
    [symbol, direction]
  );
}

// Retire all ACTIVE signals for a symbol — moves them to past cycle
// Expire OPEN signals saved with an older scorer version
// ACTIVE signals (entry touched = real trade) are NEVER auto-expired
// Called on startup — cleans up stale setups after a deploy
function expireOldVersionSignals(currentVersion) {
  if (!currentVersion) return 0;
  // ONLY touches outcome='OPEN' — never WIN, LOSS, ACTIVE, EXPIRED, REPLACED
  const stale = all(
    "SELECT id FROM signals WHERE outcome='OPEN' AND (scorer_version IS NULL OR scorer_version != ?)",
    [currentVersion]
  );
  if (stale.length === 0) return 0;
  // Safety cap — refuse to expire more than 50 signals at once
  if (stale.length > 50) {
    console.error(`[DB] expireOldVersionSignals SAFETY ABORT — would expire ${stale.length} signals, limit is 50`);
    return 0;
  }
  const ids = stale.map(s => s.id);
  const placeholders = ids.map(() => '?').join(',');
  run(`UPDATE signals SET outcome='EXPIRED', outcome_ts=? WHERE id IN (${placeholders})`,
    [Date.now(), ...ids]);
  persist();
  console.log(`[DB] Expired ${stale.length} OPEN signal(s) from old scorer version (${currentVersion}) — ACTIVE/WIN/LOSS untouched`);
  return stale.length;
}
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

  // Guard: if merge produced a nonsensical RR, restore TP to match original RR
  // RR < 1.5 = not worth taking; RR > 4 = TP was blown out by entry averaging
  // In both cases recalculate TP from newEntry + newSl to restore original keep.rr
  const targetRr = Math.min(Math.max(keep.rr || 2, 1.5), 4.0);
  if (newRr < 1.5 || newRr > 4.0) {
    const oldRr = newRr;
    const risk = Math.abs(newEntry - newSl);
    const direction = newTp > newEntry ? 1 : -1;
    newTp = Math.round((newEntry + direction * risk * targetRr) * 10000) / 10000;
    // Recheck RR after TP recalculation
    const recalcRisk   = Math.abs(newEntry - newSl);
    const recalcReward = Math.abs(newTp - newEntry);
    newRr = recalcRisk > 0 ? Math.round((recalcReward / recalcRisk) * 10) / 10 : newRr;
    console.log(`[DB] Merge RR guard: RR was ${oldRr} → recalculated TP to ${newTp} (RR ${newRr})`);

    // If RR still cannot reach 1.5 after TP recalculation, block merge entirely
    // Mark absorbed signal as REPLACED — do NOT create an untradeable merged position
    if (newRr < 1.5) {
      console.log(`[DB] Merge BLOCKED: RR ${newRr} < 1.5 after TP recalc — marking ${absorbId} as REPLACED without merging`);
      run("UPDATE signals SET outcome='REPLACED', outcome_ts=? WHERE id=?",
        [Date.now(), absorbId]);
      persist();
      return false;
    }
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
  // MFE is critical for learner quality — persist immediately
  persist();
}

// Refine an existing OPEN signal in place — update levels, bump refine_count
// No new DB record, no REPLACED record — just update the existing one
function refineSignal(signalId, updates) {
  const now = Date.now();
  const current = get('SELECT refine_count FROM signals WHERE id=?', [signalId]);
  const newCount = (current?.refine_count || 0) + 1;
  run(`UPDATE signals SET
    score=?, entry=?, sl=?, tp=?, rr=?,
    reasoning=?, scorer_version=?,
    refine_count=?, refine_ts=?
    WHERE id=?`,
    [updates.score, updates.entry, updates.sl, updates.tp, updates.rr,
     updates.reasoning, updates.scorerVersion || null,
     newCount, now, signalId]);
  persist();
  return newCount;
}

// ── Trade Monitor: Recommendation Management ─────────────────────────────────
// Each recommendation stored as JSON array on signal row
// { type, reason, urgency, ts, price, mfe_pct, new_sl, new_tp }
// Types: CLOSE | MOVE_SL | ADJUST_TP
// Urgency: HIGH | MEDIUM | LOW

function addRecommendation(signalId, rec) {
  const signal = get('SELECT recommendations FROM signals WHERE id=?', [signalId]);
  if (!signal) return;
  const existing = [];
  try {
    if (signal.recommendations) {
      const parsed = JSON.parse(signal.recommendations);
      existing.push(...parsed);
    }
  } catch(e) {}

  // Don't duplicate — skip if same type issued within last 10 minutes
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const recentSame = existing.find(r => r.type === rec.type && r.ts > tenMinAgo);
  if (recentSame) return false; // already issued recently

  // MOVE_SL dedup: never re-issue if the recommended new_sl target is identical
  // to the most recent unresolved MOVE_SL rec. Prevents the id:2795 pattern where
  // 100 identical recs fire because price freezes at a level for hours.
  if (rec.type === 'MOVE_SL' && rec.new_sl != null) {
    const lastMoveSL = existing
      .filter(r => r.type === 'MOVE_SL' && !r.resolved && !r.dismissed)
      .sort((a, b) => b.ts - a.ts)[0];
    if (lastMoveSL && lastMoveSL.new_sl === rec.new_sl) {
      return false; // same target already pending — don't add again
    }
  }

  existing.push({
    ...rec,
    ts: Date.now(),
    id: Date.now().toString(36) // short unique id
  });

  run('UPDATE signals SET recommendations=? WHERE id=?',
    [JSON.stringify(existing), signalId]);
  persist();
  return true;
}

function getRecommendations(signalId) {
  const signal = get('SELECT recommendations FROM signals WHERE id=?', [signalId]);
  if (!signal?.recommendations) return [];
  try { return JSON.parse(signal.recommendations); } catch(e) { return []; }
}

function markRecommendationFollowed(signalId) {
  run('UPDATE signals SET rec_followed = rec_followed + 1 WHERE id=?', [signalId]);
  persist();
}

function dismissRecommendation(signalId, recId) {
  const signal = get('SELECT recommendations FROM signals WHERE id=?', [signalId]);
  if (!signal?.recommendations) return;
  try {
    const recs = JSON.parse(signal.recommendations);
    const updated = recs.map(r => r.id === recId ? { ...r, dismissed: true, dismissed_ts: Date.now() } : r);
    run('UPDATE signals SET recommendations=? WHERE id=?', [JSON.stringify(updated), signalId]);
    persist();
  } catch(e) {}
}

function resolveStaleRecommendations(signalId, currentRsi, direction) {
  // Resolve recommendations that are no longer valid.
  //
  // RSI HIGH CLOSE recs (RSI extreme against direction) use INVALIDATION-based expiry:
  //   — LONG trade, RSI was < 30: resolved when RSI recovers above 45 (momentum neutralised)
  //   — SHORT trade, RSI was > 70: resolved when RSI drops below 55 (momentum neutralised)
  //   — Fallback: 120min hard cap (prevents zombie recs if RSI data goes stale)
  //
  // All other recs use the original 20min timer.
  const signal = get('SELECT recommendations FROM signals WHERE id=?', [signalId]);
  if (!signal?.recommendations) return;
  try {
    const recs = JSON.parse(signal.recommendations);
    const now = Date.now();
    const staleMs        = 20  * 60 * 1000; // 20min for non-RSI recs
    const rsiHardCapMs   = 120 * 60 * 1000; // 2h hard cap for RSI HIGH recs
    let changed = false;

    const updated = recs.map(r => {
      if (r.resolved || r.dismissed) return r;

      const isRsiHighClose = r.type === 'CLOSE' &&
                             r.urgency === 'HIGH' &&
                             r.reason && r.reason.includes('RSI');

      if (isRsiHighClose) {
        // Invalidation condition: RSI has normalised
        let rsiNormalised = false;
        if (currentRsi != null && direction) {
          if (direction === 'LONG'  && currentRsi > 45) rsiNormalised = true;
          if (direction === 'SHORT' && currentRsi < 55) rsiNormalised = true;
        }
        const hitHardCap = (now - r.ts) > rsiHardCapMs;

        if (rsiNormalised) {
          changed = true;
          return { ...r, resolved: true, resolved_ts: now, resolved_reason: `rsi-normalised (RSI ${currentRsi})` };
        }
        if (hitHardCap) {
          changed = true;
          return { ...r, resolved: true, resolved_ts: now, resolved_reason: 'auto-expired (2h cap)' };
        }
        // RSI still extreme — rec stays live
        return r;
      }

      // MOVE_SL recs: extend to 2h — SL moves are actionable for much longer than 20min
      // The MOVE_SL dedup in addRecommendation prevents re-firing same target anyway
      if (r.type === 'MOVE_SL') {
        const moveSLCapMs = 120 * 60 * 1000;
        if ((now - r.ts) > moveSLCapMs) {
          changed = true;
          return { ...r, resolved: true, resolved_ts: now, resolved_reason: 'auto-expired (2h cap)' };
        }
        return r;
      }

      // All other rec types: original 20min timer
      if ((now - r.ts) > staleMs) {
        changed = true;
        return { ...r, resolved: true, resolved_ts: now, resolved_reason: 'auto-expired (20min)' };
      }
      return r;
    });

    if (changed) {
      run('UPDATE signals SET recommendations=? WHERE id=?', [JSON.stringify(updated), signalId]);
      persist();
    }
  } catch(e) {}
}


// ── Settings: persistent key-value store ──────────────────────────────────────
// Used to persist learner state (lastLearningTs) across restarts
function getSetting(key) {
  try {
    const row = get('SELECT value FROM settings WHERE key=?', [key]);
    return row ? row.value : null;
  } catch(e) { return null; }
}

function setSetting(key, value) {
  run('INSERT OR REPLACE INTO settings (key, value, ts) VALUES (?,?,?)', [key, String(value), Date.now()]);
  persist();
}


// ── Watch signals ─────────────────────────────────────────────────────────────
function insertWatchSignal(signal) {
  run(`INSERT INTO watch_signals
    (symbol,ts,direction,score,entry,sl,tp,rr,session,reasoning,scorer_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [signal.symbol, Date.now(), signal.direction, signal.score,
     signal.entry, signal.sl, signal.tp, signal.rr,
     signal.session, signal.reasoning, signal.scorerVersion || null]);
  const row = get("SELECT last_insert_rowid() as id");
  persist();
  return row ? row.id : null;
}

function getRecentWatchSignals(limit = 50) {
  return db.exec(
    `SELECT * FROM watch_signals ORDER BY ts DESC LIMIT ${parseInt(limit)}`
  )[0]?.values?.map(r => ({
    id: r[0], symbol: r[1], ts: r[2], direction: r[3], score: r[4],
    entry: r[5], sl: r[6], tp: r[7], rr: r[8], session: r[9],
    reasoning: r[10], scorer_version: r[11], mfe: r[12], mfe_pct: r[13],
    outcome: r[14], outcome_ts: r[15], pnl_pct: r[16]
  })) || [];
}

function updateWatchOutcome(id, outcome, pnlPct) {
  run('UPDATE watch_signals SET outcome=?, outcome_ts=?, pnl_pct=? WHERE id=?',
    [outcome, Date.now(), pnlPct, id]);
  persist();
}

// ── Economic calendar events ─────────────────────────────────────────────────
function upsertEconomicEvent(event) {
  if (event.eventId) {
    const existing = get('SELECT id, fired FROM economic_events WHERE event_id=?', [event.eventId]);
    if (existing) {
      run('UPDATE economic_events SET event_time=?, impact=?, forecast=?, previous=?, ts=? WHERE id=?',
        [event.eventTime, event.impact, event.forecast, event.previous, Date.now(), existing.id]);
    } else {
      run(`INSERT INTO economic_events (event_id, title, currency, event_date, event_time, impact, forecast, previous, ts)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [event.eventId, event.title, event.currency, event.eventDate, event.eventTime,
         event.impact, event.forecast, event.previous, Date.now()]);
    }
  } else {
    // Legacy path without event_id
    const existing = get('SELECT id FROM economic_events WHERE title=? AND currency=? AND event_date=?',
      [event.title, event.currency, event.eventDate]);
    if (existing) {
      run('UPDATE economic_events SET event_time=?, impact=?, forecast=?, previous=?, ts=? WHERE id=?',
        [event.eventTime, event.impact, event.forecast, event.previous, Date.now(), existing.id]);
    } else {
      run(`INSERT INTO economic_events (title, currency, event_date, event_time, impact, forecast, previous, ts)
        VALUES (?,?,?,?,?,?,?,?)`,
        [event.title, event.currency, event.eventDate, event.eventTime,
         event.impact, event.forecast, event.previous, Date.now()]);
    }
  }
  persist();
}

// Mark event as fired with sentiment — returns true if this is the first time
function markEventFired(eventId, sentiment) {
  const row = get('SELECT id, fired FROM economic_events WHERE event_id=?', [eventId]);
  if (!row) return false;
  if (row.fired === 1) return false;
  run('UPDATE economic_events SET fired=1, sentiment=?, sentiment_magnitude=?, sentiment_summary=? WHERE id=?',
    [sentiment?.beat || 0, sentiment?.magnitude || null, sentiment?.summary || null, row.id]);
  persist();
  return true;
}

function getRecentFiredEvents(hours = 4) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().slice(0, 10);
  return all('SELECT * FROM economic_events WHERE fired=1 AND event_date >= ? ORDER BY event_date DESC, event_time DESC', [cutoff]);
}

function getUpcomingEvents(days = 7) {
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return all('SELECT * FROM economic_events WHERE event_date >= ? AND event_date <= ? AND impact=? ORDER BY event_date, event_time',
    [now.toISOString().slice(0, 10), future.toISOString().slice(0, 10), 'High']);
}

function getAllEconomicEvents() {
  return all('SELECT * FROM economic_events ORDER BY event_date DESC, event_time LIMIT 100');
}

// ── Macro context persistence ────────────────────────────────────────────────
function upsertMacroContext(symbol, data) {
  const keyRisks = JSON.stringify(data.key_risks || []);
  const ts = data.ts || Date.now();
  const existing = get('SELECT id FROM macro_context WHERE symbol=?', [symbol]);
  if (existing) {
    run(`UPDATE macro_context SET
      sentiment=?, strength=?, summary=?, key_risks=?,
      supports_long=?, supports_short=?, avoid_until=?, ts=?
      WHERE symbol=?`,
      [data.sentiment, data.strength, data.summary, keyRisks,
       data.supports_long ? 1 : 0, data.supports_short ? 1 : 0,
       data.avoid_until || null, ts, symbol]);
  } else {
    run(`INSERT INTO macro_context
      (symbol, sentiment, strength, summary, key_risks, supports_long, supports_short, avoid_until, ts)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [symbol, data.sentiment, data.strength, data.summary, keyRisks,
       data.supports_long ? 1 : 0, data.supports_short ? 1 : 0,
       data.avoid_until || null, ts]);
  }
  persist();
}

function getStoredMacroContext() {
  const rows = all('SELECT * FROM macro_context ORDER BY symbol');
  const result = {};
  for (const r of rows) {
    result[r.symbol] = {
      sentiment: r.sentiment,
      strength: r.strength,
      summary: r.summary,
      key_risks: (() => { try { return JSON.parse(r.key_risks); } catch(e) { return []; } })(),
      supports_long: r.supports_long === 1,
      supports_short: r.supports_short === 1,
      avoid_until: r.avoid_until,
      ts: r.ts
    };
  }
  return result;
}

function getMacroContextAge() {
  const row = get('SELECT MIN(ts) as oldest FROM macro_context');
  return row?.oldest ? Date.now() - row.oldest : Infinity;
}

// ── Central bank consensus ───────────────────────────────────────────────────
function upsertConsensus(currency, meetingDate, data) {
  // Replace existing consensus for same currency+meeting
  run('DELETE FROM cb_consensus WHERE currency=? AND meeting_date=?', [currency, meetingDate]);
  run(`INSERT INTO cb_consensus (currency, bank, meeting_date, expected_decision, expected_bps, confidence, summary, source, ts)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [currency, data.bank, meetingDate, data.expected_decision, data.expected_bps || 0,
     data.confidence || 'LOW', data.summary || '', data.source || 'claude', Date.now()]);
  persist();
}

function getConsensus(currency) {
  return get('SELECT * FROM cb_consensus WHERE currency=? ORDER BY ts DESC LIMIT 1', [currency]);
}

function getAllConsensus() {
  return all('SELECT * FROM cb_consensus WHERE id IN (SELECT MAX(id) FROM cb_consensus GROUP BY currency) ORDER BY meeting_date');
}

// ── Rate data ────────────────────────────────────────────────────────────────
function upsertRateData(currency, data) {
  run(`INSERT INTO rate_data (currency, rate_pct, last_updated, ts) VALUES (?,?,?,?)`,
    [currency, data.ratePct, data.lastUpdated || null, Date.now()]);
  persist();
}

function getRateData(currency) {
  return get('SELECT * FROM rate_data WHERE currency=? ORDER BY ts DESC LIMIT 1', [currency]);
}

function getAllRateData() {
  return all('SELECT * FROM rate_data WHERE id IN (SELECT MAX(id) FROM rate_data GROUP BY currency) ORDER BY currency');
}

// ── COT data ─────────────────────────────────────────────────────────────────
function upsertCOTData(symbol, data) {
  run(`INSERT INTO cot_data
    (symbol, report_date, net_noncomm, net_comm, open_interest, change_net_noncomm,
     noncomm_long, noncomm_short, comm_long, comm_short, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [symbol, data.reportDate, data.netNonComm, data.netComm, data.openInterest,
     data.changeNetNonComm, data.noncommLong, data.noncommShort,
     data.commLong, data.commShort, Date.now()]);
  persist();
}

function getCOTData(symbol) {
  return get('SELECT * FROM cot_data WHERE symbol=? ORDER BY ts DESC LIMIT 1', [symbol]);
}

function getAllCOTData() {
  return all('SELECT * FROM cot_data WHERE id IN (SELECT MAX(id) FROM cot_data GROUP BY symbol) ORDER BY symbol');
}

module.exports = {
  init, isReady, persist, run,
  upsertMarketData, getLatestMarketData,
  insertSignal, refineSignal, updateOutcome, updatePaperOutcome, getPaperTradeStats, updateMFE,
  getOpenSignals, getRecentOutcomes,
  getWeights, updateWeights,
  insertLearningLog, getAllSignals, getLearningLog,
  getLatestOpenSignal, expireOldVersionSignals,
  addRecommendation, getRecommendations, markRecommendationFollowed,
  dismissRecommendation, resolveStaleRecommendations,
  retireActiveCycle, getCurrentCycleSignals, getPastCycleSignals, getCurrentCycleOpenSignals,
  getSetting, setSetting,
  insertWatchSignal, getRecentWatchSignals, updateWatchOutcome,
  upsertEconomicEvent, markEventFired, getRecentFiredEvents, getUpcomingEvents, getAllEconomicEvents,
  upsertMacroContext, getStoredMacroContext, getMacroContextAge,
  upsertCOTData, getCOTData, getAllCOTData,
  upsertRateData, getRateData, getAllRateData,
  upsertConsensus, getConsensus, getAllConsensus
};
