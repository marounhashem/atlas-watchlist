// FXSSI Historical Data Collector — queue-based, non-blocking
// Processes ONE job at a time via setTimeout(processNext, 350)
// Does NOT touch the live scraper cache or scoring pipeline

const { analyseOrderBook, FXSSI_SYMBOLS } = require('./fxssiScraper');
const db = require('./db');

const API_BASE = 'https://c.fxssi.com/api/order-book';
const HEADERS = {
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://fxssi.com/'
};

// ── State ───────────────────────────────────────────────────────────────────
let _queue = [];
let _collecting = false;
let _cancelled = false;
let _stats = { collected: 0, skipped: 0, errors: 0, total: 0, processed: 0 };
let _resolve = null; // promise resolve for collectHistory callers

function cancelCollection() { _cancelled = true; }
function isCollecting() { return _collecting; }

// ── Fetch a single historical snapshot ──────────────────────────────────────
async function fetchHistoricalSnapshot(pair, timeOffset = 0) {
  const token = process.env.FXSSI_TOKEN;
  const userId = process.env.FXSSI_USER_ID || '118460';
  if (!token) return null;

  let url = `${API_BASE}?pair=${pair}&view=all&period=1200&token=${token}&user_id=${userId}&rand=${Math.random()}`;
  if (timeOffset > 0) url += `&timeOffset=${timeOffset}`;

  try {
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 429 || res.status === 503) {
      console.log(`[FXSSI-Hist] ${pair} offset=${timeOffset} HTTP ${res.status} — rate limited`);
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.time || !data.levels?.length) return null;

    const analysed = analyseOrderBook(data);
    if (!analysed) return null;

    return {
      snapshot_time: data.time,
      price: data.price,
      long_pct: analysed.longPct,
      short_pct: analysed.shortPct,
      sentiment: analysed.sentiment,
      trapped: analysed.trapped,
      gravity_price: analysed.gravity?.price || null,
      sr_wall_price: analysed.srWall?.price || null,
      ob_imbalance: analysed.obImbalance,
      ob_absorption: analysed.obAbsorption,
      full_analysis: analysed
    };
  } catch(e) {
    return null;
  }
}

// ── Queue processor — one job at a time via setTimeout ──────────────────────
function processNext() {
  if (_cancelled || _queue.length === 0) {
    _collecting = false;
    const result = { ..._stats, cancelled: _cancelled };
    console.log(`[FXSSI-Hist] ${_cancelled ? 'Stopped' : 'Complete'}: collected=${_stats.collected} skipped=${_stats.skipped} errors=${_stats.errors} processed=${_stats.processed}/${_stats.total}`);
    _cancelled = false;
    if (_resolve) { _resolve(result); _resolve = null; }
    return;
  }

  const job = _queue.shift();
  _stats.processed++;

  fetchHistoricalSnapshot(job.pair, job.offset).then(snap => {
    if (!snap) {
      _stats.errors++;
    } else {
      const inserted = db.insertFxssiHistory({
        symbol: job.symbol,
        snapshot_time: snap.snapshot_time,
        long_pct: snap.long_pct,
        short_pct: snap.short_pct,
        sentiment: snap.sentiment,
        trapped: snap.trapped,
        gravity_price: snap.gravity_price,
        sr_wall_price: snap.sr_wall_price,
        ob_imbalance: snap.ob_imbalance,
        ob_absorption: snap.ob_absorption,
        full_analysis: snap.full_analysis,
        fetched_at: Date.now()
      });
      if (inserted) _stats.collected++;
      else _stats.skipped++;
    }

    // Progress log every 50 jobs
    if (_stats.processed % 50 === 0) {
      console.log(`[FXSSI-Hist] progress: ${_stats.processed}/${_stats.total} collected=${_stats.collected} skipped=${_stats.skipped} errors=${_stats.errors}`);
      try { db.persist(); } catch(e) {}
    }

    // Schedule next job — 350ms gap keeps event loop free
    setTimeout(processNext, 350);
  }).catch(e => {
    _stats.errors++;
    setTimeout(processNext, 350);
  });
}

// ── Build queue and start collection ────────────────────────────────────────
function collectHistory(maxOffset) {
  if (_collecting) {
    console.log('[FXSSI-Hist] Collection already in progress');
    return Promise.resolve({ collected: 0, skipped: 0, errors: 0, reason: 'already_running' });
  }

  const symbols = Object.entries(FXSSI_SYMBOLS);

  // Build job queue — check DB for existing records to resume from
  _queue = [];
  for (let offset = 0; offset <= maxOffset; offset++) {
    for (const [symbol, pair] of symbols) {
      _queue.push({ symbol, pair, offset });
    }
  }

  // Filter out jobs where we already have data for that symbol+offset combo
  // We can't check exact snapshot_time without fetching, but we can skip
  // offsets where we already have a recent record for that symbol
  // (The UNIQUE constraint handles true duplicates on insert anyway)

  _collecting = true;
  _cancelled = false;
  _stats = { collected: 0, skipped: 0, errors: 0, total: _queue.length, processed: 0 };

  console.log(`[FXSSI-Hist] Starting collection: ${_queue.length} jobs (${symbols.length} symbols × ${maxOffset + 1} offsets)`);

  return new Promise(resolve => {
    _resolve = resolve;
    setTimeout(processNext, 100); // start after a tick
  });
}

function collectFullHistory() {
  console.log('[FXSSI-Hist] Starting FULL collection (offsets 0-360)...');
  return collectHistory(360);
}

function collectRecentHistory() {
  console.log('[FXSSI-Hist] Starting RECENT collection (offsets 0-72)...');
  return collectHistory(72);
}

// ── Query a snapshot for a specific symbol + timestamp ───────────────────────
function querySnapshot(symbol, timestampSeconds) {
  const d = new Date(timestampSeconds * 1000);
  const utcDay = d.getUTCDay();
  const utcHour = d.getUTCHours();
  const isFriAfterClose = utcDay === 5 && utcHour >= 22;
  const isSaturday = utcDay === 6;
  const isSunBeforeOpen = utcDay === 0 && utcHour < 22;
  if (isFriAfterClose || isSaturday || isSunBeforeOpen) {
    return { match: null, reason: 'weekend_gap' };
  }

  const rounded = Math.round(timestampSeconds / 1200) * 1200;

  const row = db.getFxssiHistorySnapshot(symbol, rounded);
  if (!row) {
    const rowMinus = db.getFxssiHistorySnapshot(symbol, rounded - 1200);
    const rowPlus = db.getFxssiHistorySnapshot(symbol, rounded + 1200);
    const fallback = rowMinus || rowPlus;
    if (fallback) {
      const gap = Math.abs(timestampSeconds - fallback.snapshot_time);
      return { match: fallback, gap_minutes: Math.round(gap / 60), rounded_to: rounded, fuzzy: true };
    }
    return { match: null, reason: 'not_in_db', rounded_to: rounded };
  }

  const gap = Math.abs(timestampSeconds - row.snapshot_time);
  return { match: row, gap_minutes: Math.round(gap / 60), rounded_to: rounded };
}

module.exports = { collectFullHistory, collectRecentHistory, querySnapshot, cancelCollection, isCollecting };
