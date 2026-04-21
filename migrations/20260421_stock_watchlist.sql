-- migrations/20260421_stock_watchlist.sql
--
-- Two new tables, both isolated from the existing ATLAS signal schema.
-- Run once on deployment. Safe to re-run (CREATE IF NOT EXISTS).
--
-- `stock_scans` is the header row for each morning's scan (metadata,
-- counts, scorer version). `stock_watchlist` stores the 1–5 picks
-- produced by that scan. Outcomes can be logged later to the same
-- table by extending it with outcome/pnl columns if you want to
-- eventually run the scorer-optimizer skill on this data too.

CREATE TABLE IF NOT EXISTS stock_scans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL,
  finished_at     TEXT    NOT NULL,
  universe_size   INTEGER NOT NULL,
  fetched         INTEGER NOT NULL,
  failed          INTEGER NOT NULL,
  prefiltered     INTEGER NOT NULL,
  accepted        INTEGER NOT NULL,
  scorer_version  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_scans_started ON stock_scans(started_at DESC);

CREATE TABLE IF NOT EXISTS stock_watchlist (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id           INTEGER NOT NULL REFERENCES stock_scans(id) ON DELETE CASCADE,
  rank              INTEGER NOT NULL,        -- 1..5
  symbol            TEXT    NOT NULL,
  name              TEXT,
  direction         TEXT    NOT NULL,        -- LONG | SHORT
  gap_pct           REAL    NOT NULL,
  rvol              REAL    NOT NULL,
  atr_pct           REAL    NOT NULL,
  avg_volume        INTEGER,
  pre_market_price  REAL,
  prev_close        REAL,
  score             INTEGER NOT NULL,
  score_breakdown   TEXT,                     -- JSON
  top_catalyst      TEXT,                     -- e.g. 'earnings_beat', nullable
  catalyst_bias     INTEGER,                  -- -1 / 0 / +1
  sentiment         REAL,                     -- VADER compound, -1..+1
  levels_json       TEXT,                     -- JSON: entry/stop/targets
  headlines_json    TEXT,                     -- JSON array of headlines
  outcome           TEXT,                     -- optional, filled later: WIN/LOSS/SKIP
  pnl_pct           REAL,
  created_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watchlist_scan      ON stock_watchlist(scan_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_symbol    ON stock_watchlist(symbol);
CREATE INDEX IF NOT EXISTS idx_watchlist_created   ON stock_watchlist(created_at DESC);
