# FXSSI Historical Data Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone FXSSI historical data collector for backtesting that fetches order book snapshots at various timeOffsets and stores them in a dedicated DB table.

**Architecture:** New file `server/fxssi-history-collector.js` handles all collection and query logic. It imports `analyseOrderBook` from the existing `fxssiScraper.js` (requires adding it to exports) and uses `db.run/get/all/persist` for storage. Three new API endpoints in `server/index.js` plus a nightly cron. The temporary timeOffset test endpoint is removed.

**Tech Stack:** Node.js, sql.js (existing DB layer), FXSSI REST API

---

### Task 1: Export analyseOrderBook from fxssiScraper.js

**Files:**
- Modify: `server/fxssiScraper.js:592` (module.exports line)

- [ ] **Step 1: Add analyseOrderBook and FXSSI_SYMBOLS to exports**

In `server/fxssiScraper.js` line 592, change:
```js
module.exports = { runFXSSIScrape, processBridgePayload, getFxssiCacheAge, getFxssiNullStreak };
```
to:
```js
module.exports = { runFXSSIScrape, processBridgePayload, getFxssiCacheAge, getFxssiNullStreak, analyseOrderBook, FXSSI_SYMBOLS };
```

- [ ] **Step 2: Verify no breakage**

Run: `node -c server/fxssiScraper.js`
Expected: no output (clean syntax)

- [ ] **Step 3: Commit**

```bash
git add server/fxssiScraper.js
git commit -m "feat: export analyseOrderBook and FXSSI_SYMBOLS for history collector"
```

---

### Task 2: Create fxssi_history table in db.js

**Files:**
- Modify: `server/db.js` — add table creation after the existing `market_data_history` CREATE TABLE block (~line 445), add helper functions, add to module.exports

- [ ] **Step 1: Add CREATE TABLE in the schema init section**

Find the block after `CREATE TABLE IF NOT EXISTS market_data_history` (around line 445-455) and add after it:

```js
  db.run(`CREATE TABLE IF NOT EXISTS fxssi_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    snapshot_time INTEGER NOT NULL,
    long_pct REAL,
    short_pct REAL,
    sentiment TEXT,
    trapped TEXT,
    gravity_price REAL,
    sr_wall_price REAL,
    ob_imbalance REAL,
    ob_absorption INTEGER,
    full_analysis TEXT,
    fetched_at INTEGER NOT NULL,
    UNIQUE(symbol, snapshot_time)
  )`);
```

- [ ] **Step 2: Add helper functions before module.exports**

Add these functions before the `module.exports = {` line:

```js
function insertFxssiHistory(row) {
  try {
    run(`INSERT OR IGNORE INTO fxssi_history
      (symbol, snapshot_time, long_pct, short_pct, sentiment, trapped,
       gravity_price, sr_wall_price, ob_imbalance, ob_absorption, full_analysis, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.symbol, row.snapshot_time, row.long_pct, row.short_pct,
       row.sentiment, row.trapped, row.gravity_price, row.sr_wall_price,
       row.ob_imbalance, row.ob_absorption ? 1 : 0,
       typeof row.full_analysis === 'string' ? row.full_analysis : JSON.stringify(row.full_analysis),
       row.fetched_at]);
    return true;
  } catch(e) {
    if (e?.message?.includes('UNIQUE constraint')) return false; // duplicate
    console.error('[DB] insertFxssiHistory error:', e?.message);
    return false;
  }
}

function getFxssiHistorySnapshot(symbol, snapshotTime) {
  return get('SELECT * FROM fxssi_history WHERE symbol=? AND snapshot_time=?', [symbol, snapshotTime]);
}

function getFxssiHistoryStatus() {
  return all(`SELECT symbol, COUNT(*) as count,
    MIN(snapshot_time) as earliest, MAX(snapshot_time) as latest
    FROM fxssi_history GROUP BY symbol ORDER BY symbol`);
}
```

- [ ] **Step 3: Add to module.exports**

Add `insertFxssiHistory, getFxssiHistorySnapshot, getFxssiHistoryStatus` to the module.exports object.

- [ ] **Step 4: Verify syntax**

Run: `node -c server/db.js`
Expected: no output (clean syntax)

- [ ] **Step 5: Commit**

```bash
git add server/db.js
git commit -m "feat: fxssi_history table + insert/query helpers"
```

---

### Task 3: Create fxssi-history-collector.js

**Files:**
- Create: `server/fxssi-history-collector.js`

- [ ] **Step 1: Write the complete collector module**

Create `server/fxssi-history-collector.js`:

```js
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
```

- [ ] **Step 2: Verify syntax**

Run: `node -c server/fxssi-history-collector.js`
Expected: no output (clean syntax)

- [ ] **Step 3: Commit**

```bash
git add server/fxssi-history-collector.js
git commit -m "feat: FXSSI historical data collector for backtesting"
```

---

### Task 4: Register endpoints and cron in server/index.js

**Files:**
- Modify: `server/index.js` — add import, 3 endpoints, 1 cron, remove temp endpoint

- [ ] **Step 1: Add import at top of file**

Near the other require statements (around line 17-22), add:

```js
const { collectFullHistory, collectRecentHistory, querySnapshot } = require('./fxssi-history-collector');
```

- [ ] **Step 2: Remove the temporary timeOffset test endpoint**

Delete the entire block from `// TEMPORARY: compare FXSSI with/without timeOffset param` through the closing `});` (lines 640-662 approximately).

- [ ] **Step 3: Add three new endpoints**

Add in place of the removed temp endpoint:

```js
// FXSSI historical data collection for backtesting
app.get('/api/fxssi-history/collect', (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  const mode = req.query.mode === 'recent' ? 'recent' : 'full';
  res.json({ started: true, mode });
  // Run async — don't block response
  (mode === 'recent' ? collectRecentHistory() : collectFullHistory())
    .then(r => console.log(`[FXSSI-Hist] ${mode} collection done:`, r))
    .catch(e => console.error(`[FXSSI-Hist] ${mode} collection error:`, e.message));
});

app.get('/api/fxssi-history/status', (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  try {
    const rows = db.getFxssiHistoryStatus();
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    res.json({ total, symbols: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fxssi-history/query', (req, res) => {
  const { symbol, timestamp } = req.query;
  if (!symbol || !timestamp) return res.status(400).json({ error: 'Missing symbol or timestamp' });
  try {
    const result = querySnapshot(symbol, Number(timestamp));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 4: Add nightly cron**

Find the cron section (near the other cron.schedule calls, around line 2695+). Add:

```js
// Nightly FXSSI history collection — 23:30 UTC
cron.schedule('30 23 * * *', async () => {
  try {
    console.log('[Cron] FXSSI history collection starting...');
    const result = await collectRecentHistory();
    console.log(`[Cron] FXSSI history collection done — collected:${result.collected} skipped:${result.skipped} errors:${result.errors}`);
  } catch(e) { console.error('[Cron] FXSSI history error:', e.message); }
});
```

- [ ] **Step 5: Verify syntax**

Run: `node -c server/index.js`
Expected: no output (clean syntax)

- [ ] **Step 6: Commit**

```bash
git add server/index.js
git commit -m "feat: FXSSI history endpoints + nightly cron, remove temp test endpoint"
```

---

### Task 5: Final verification and deploy

- [ ] **Step 1: Syntax check all modified files**

```bash
node -c server/fxssiScraper.js && node -c server/db.js && node -c server/fxssi-history-collector.js && node -c server/index.js && echo "ALL OK"
```
Expected: `ALL OK`

- [ ] **Step 2: Push to deploy**

```bash
git push
```

- [ ] **Step 3: Verify endpoints after deploy**

Test each endpoint:
- `GET /api/fxssi-history/status` — should return `{ total: 0, symbols: [] }` (empty table)
- `GET /api/fxssi-history/query?symbol=EURUSD&timestamp=1775446800` — should return `{ match: null, reason: 'not_in_db' }`
- `GET /api/fxssi-history/collect?mode=recent` — should return `{ started: true, mode: 'recent' }` and begin collecting in background
