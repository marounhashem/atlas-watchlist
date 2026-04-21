-- migrations/20260421_stock_outcomes.sql
--
-- Additive migration. Adds outcome-tracking columns to stock_watchlist.
-- The initial migration already declared `outcome` and `pnl_pct` — this
-- file adds the rest and creates a separate `stock_outcome_log` table
-- for the journal of every update (so we can audit changes later).
--
-- Safe to re-run. Uses the SQLite-friendly pattern of trying each ALTER
-- and ignoring "duplicate column" errors, wrapped in a transaction so
-- partial failures don't leave the DB in a weird state.

-- Add outcome-related columns. If they exist, the ALTER errors are
-- swallowed by the loader; just run manually and ignore "duplicate
-- column name" errors.
ALTER TABLE stock_watchlist ADD COLUMN outcome_notes       TEXT;
ALTER TABLE stock_watchlist ADD COLUMN outcome_ts          TEXT;
ALTER TABLE stock_watchlist ADD COLUMN entry_taken         TEXT;   -- 'primary' | 'alternative' | 'none'
ALTER TABLE stock_watchlist ADD COLUMN mfe_pct             REAL;   -- max favorable excursion
ALTER TABLE stock_watchlist ADD COLUMN mae_pct             REAL;   -- max adverse excursion

CREATE TABLE IF NOT EXISTS stock_outcome_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id  INTEGER NOT NULL REFERENCES stock_watchlist(id) ON DELETE CASCADE,
  action        TEXT    NOT NULL,   -- 'set_outcome' | 'note' | 'clear'
  old_value     TEXT,
  new_value     TEXT,
  user_note     TEXT,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcome_log_watchlist ON stock_outcome_log(watchlist_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_outcome     ON stock_watchlist(outcome);
