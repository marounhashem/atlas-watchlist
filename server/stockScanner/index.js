// server/stockScanner/index.js
//
// The agent's main loop. Invoked once per morning by the scheduler.
// Pipeline:
//
//    universe symbols
//       │
//       ▼
//    fetchUniverse()   -- market data, ~350 symbols, Yahoo, 30-60s
//       │
//       ▼
//    filter candidates -- has gap, has rvol, passes ETF filter
//       │
//       ▼
//    fetchNews()       -- only for surviving candidates (saves API calls)
//       │
//       ▼
//    classify()        -- catalyst + sentiment per candidate
//       │
//       ▼
//    scoreCandidate()  -- 0-100 with hard gates
//       │
//       ▼
//    buildLevels()     -- ATR entry/stop/target
//       │
//       ▼
//    persist top 5 to  stock_watchlist  table
//
// Everything is persisted so the dashboard can show history and the
// scorer optimiser can run Bayesian analysis on outcomes later.

const { UNIVERSE, isEtf } = require('./universe');
const { fetchUniverse } = require('./dataProvider');
const { fetchNews } = require('./newsProvider');
const { classify } = require('./sentiment');
const { scoreCandidate, STOCK_SCORER_VERSION } = require('./scorer');
const { buildLevels } = require('./levels');

const WATCHLIST_SIZE = 5;

/**
 * Run a full scan. Returns the persisted watchlist + summary stats.
 *
 * @param {{ db: Database, log?: (msg: string) => void }} ctx
 * @returns {Promise<ScanResult>}
 */
async function runScan({ db, log = console.log }) {
  const startedAt = new Date();
  log(`[scanner] Starting scan at ${startedAt.toISOString()} (v${STOCK_SCORER_VERSION})`);

  // ---- 1. Market data ----
  log(`[scanner] Fetching ${UNIVERSE.length} symbols from Yahoo...`);
  const { results, failed } = await fetchUniverse(UNIVERSE);
  log(`[scanner] Got ${results.length} symbols (${failed.length} failed)`);

  // ---- 2. First-pass filter ----
  // Only fetch news for symbols that actually have a gap worth
  // investigating. This saves 80-90% of news API calls.
  const prefiltered = results.filter(r => {
    if (isEtf(r.symbol)) return false;               // ETFs are context, not picks
    if (Math.abs(r.gapPct) < 2.0) return false;      // below pre-filter threshold
    if (r.rvol < 1.5) return false;                  // no volume = no interest
    if (r.avgVolume < 500_000) return false;         // illiquid
    return true;
  });

  log(`[scanner] ${prefiltered.length} candidates after prefilter`);

  // ---- 3. News + catalyst classification ----
  const enriched = [];
  for (const cand of prefiltered) {
    const headlines = await fetchNews(cand.symbol).catch(() => []);
    const senti = classify(headlines);
    enriched.push({ ...cand, ...senti, headlines });
  }

  log(`[scanner] Enriched ${enriched.length} candidates with news`);

  // ---- 4. Score ----
  const scored = enriched.map(c => {
    const result = scoreCandidate(c);
    return { ...c, ...result };
  });

  const accepted = scored
    .filter(s => !s.rejected)
    .sort((a, b) => b.score - a.score);

  log(`[scanner] ${accepted.length}/${scored.length} passed scoring gates`);

  // ---- 5. Build levels for top N ----
  const watchlist = accepted.slice(0, WATCHLIST_SIZE).map(c => ({
    ...c,
    levels: buildLevels(c),
  }));

  // ---- 6. Persist ----
  const scanId = persistScan(db, {
    startedAt,
    finishedAt: new Date(),
    universeSize: UNIVERSE.length,
    fetched: results.length,
    failed: failed.length,
    prefiltered: prefiltered.length,
    accepted: accepted.length,
    version: STOCK_SCORER_VERSION,
  });

  for (let i = 0; i < watchlist.length; i++) {
    persistWatchlistEntry(db, scanId, i + 1, watchlist[i]);
  }

  log(`[scanner] Persisted scan ${scanId} with ${watchlist.length} picks`);

  return {
    scanId,
    version: STOCK_SCORER_VERSION,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    watchlist,
    rejectedCount: scored.length - accepted.length,
    stats: {
      universeSize: UNIVERSE.length,
      fetched: results.length,
      failed: failed.length,
      prefiltered: prefiltered.length,
      accepted: accepted.length,
    },
  };
}

// ---- persistence helpers ----

function persistScan(db, row) {
  const stmt = db.prepare(`
    INSERT INTO stock_scans
      (started_at, finished_at, universe_size, fetched, failed,
       prefiltered, accepted, scorer_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    row.startedAt.toISOString(),
    row.finishedAt.toISOString(),
    row.universeSize,
    row.fetched,
    row.failed,
    row.prefiltered,
    row.accepted,
    row.version,
  );
  return result.lastInsertRowid;
}

function persistWatchlistEntry(db, scanId, rank, entry) {
  const stmt = db.prepare(`
    INSERT INTO stock_watchlist
      (scan_id, rank, symbol, name, direction,
       gap_pct, rvol, atr_pct, avg_volume, pre_market_price, prev_close,
       score, score_breakdown,
       top_catalyst, catalyst_bias, sentiment,
       levels_json, headlines_json,
       created_at)
    VALUES (?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?,
            ?)
  `);
  stmt.run(
    scanId,
    rank,
    entry.symbol,
    entry.name,
    entry.levels.direction,
    entry.gapPct,
    entry.rvol,
    entry.atrPct,
    entry.avgVolume,
    entry.preMarketPrice,
    entry.prevClose,
    entry.score,
    JSON.stringify(entry.breakdown || {}),
    entry.topCatalyst,
    entry.catalystBias,
    entry.sentiment,
    JSON.stringify(entry.levels),
    JSON.stringify(entry.headlines || []),
    new Date().toISOString(),
  );
}

module.exports = { runScan };
