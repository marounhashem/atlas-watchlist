// FXSSI Historical Data Collector — standalone backtesting data
// Fetches order book snapshots at varying timeOffsets to build historical dataset
// Does NOT touch the live scraper cache or scoring pipeline

const { analyseOrderBook, FXSSI_SYMBOLS } = require('./fxssiScraper');
const db = require('./db');

const API_BASE = 'https://c.fxssi.com/api/order-book';
const HEADERS = {
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://fxssi.com/'
};

// Fetch a single historical snapshot with timeOffset (minutes back)
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
    if (!res.ok) { console.error(`[FXSSI-Hist] ${pair} offset=${timeOffset} HTTP ${res.status}`); return null; }
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
    console.error(`[FXSSI-Hist] ${pair} offset=${timeOffset} error:`, e.message);
    return null;
  }
}

// Collect history across all symbols for a range of offsets
async function collectHistory(maxOffset) {
  const symbols = Object.entries(FXSSI_SYMBOLS);
  let collected = 0, skipped = 0, errors = 0;

  for (let offset = 0; offset <= maxOffset; offset++) {
    for (const [symbol, pair] of symbols) {
      try {
        await new Promise(r => setTimeout(r, 300)); // rate limit

        const snap = await fetchHistoricalSnapshot(pair, offset);
        if (!snap) { errors++; continue; }

        const inserted = db.insertFxssiHistory({
          symbol,
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

        if (inserted) {
          collected++;
          console.log(`[FXSSI-Hist] ${symbol} offset=${offset} time=${snap.snapshot_time} — stored`);
        } else {
          skipped++;
        }
      } catch(e) {
        errors++;
        console.error(`[FXSSI-Hist] ${symbol} offset=${offset} error:`, e.message);
      }
    }

    // Persist after each offset round (21 symbols)
    try { db.persist(); } catch(e) {}

    if (offset % 10 === 0 && offset > 0) {
      console.log(`[FXSSI-Hist] Progress: offset=${offset}/${maxOffset} collected=${collected} skipped=${skipped} errors=${errors}`);
    }
  }

  db.persist();
  console.log(`[FXSSI-Hist] Complete: collected=${collected} skipped=${skipped} errors=${errors}`);
  return { collected, skipped, errors };
}

async function collectFullHistory() {
  console.log('[FXSSI-Hist] Starting FULL collection (offsets 0-360)...');
  return collectHistory(360);
}

async function collectRecentHistory() {
  console.log('[FXSSI-Hist] Starting RECENT collection (offsets 0-72)...');
  return collectHistory(72);
}

// Query a snapshot for a specific symbol + timestamp
function querySnapshot(symbol, timestampSeconds) {
  // Weekend gap check: Friday 22:00 UTC to Sunday 22:00 UTC
  const d = new Date(timestampSeconds * 1000);
  const utcDay = d.getUTCDay();
  const utcHour = d.getUTCHours();
  const isFriAfterClose = utcDay === 5 && utcHour >= 22;
  const isSaturday = utcDay === 6;
  const isSunBeforeOpen = utcDay === 0 && utcHour < 22;
  if (isFriAfterClose || isSaturday || isSunBeforeOpen) {
    return { match: null, reason: 'weekend_gap' };
  }

  // Round to nearest 20-min boundary (1200 seconds)
  const rounded = Math.round(timestampSeconds / 1200) * 1200;

  const row = db.getFxssiHistorySnapshot(symbol, rounded);
  if (!row) {
    // Try ±1 boundary (1200s each way) in case of slight offset
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

module.exports = { collectFullHistory, collectRecentHistory, querySnapshot };
