// server/routes/stocks.js
//
// Express routes for the pre-market watchlist module.
//
// Mount this on your existing Express app:
//   app.use('/api/stocks', require('./routes/stocks')(db));
//
// Endpoints:
//   GET  /api/stocks/watchlist/today         -> latest scan + picks
//   GET  /api/stocks/watchlist/:scanId       -> historical scan by id
//   GET  /api/stocks/scans                   -> list recent scans
//   POST /api/stocks/scan                    -> manual scan trigger (auth)
//   PUT  /api/stocks/pick/:id/outcome        -> mark WIN / LOSS / SKIP
//   GET  /api/stocks/stats                   -> aggregate win rate stats

const express = require('express');
const { runScan } = require('../stockScanner');

module.exports = function stocksRoutes(db) {
  const router = express.Router();
  router.use(express.json());

  // -------------------- watchlist reads --------------------

  router.get('/watchlist/today', (req, res) => {
    const latestScan = db.prepare(`
      SELECT * FROM stock_scans
      WHERE date(started_at) = date('now')
      ORDER BY started_at DESC
      LIMIT 1
    `).get();

    if (!latestScan) {
      return res.json({ scan: null, picks: [], message: 'No scan run yet today' });
    }
    const picks = db.prepare(`
      SELECT * FROM stock_watchlist WHERE scan_id = ? ORDER BY rank ASC
    `).all(latestScan.id);
    res.json({ scan: latestScan, picks: picks.map(hydrate) });
  });

  router.get('/watchlist/:scanId', (req, res) => {
    const scan = db.prepare('SELECT * FROM stock_scans WHERE id = ?').get(req.params.scanId);
    if (!scan) return res.status(404).json({ error: 'scan not found' });
    const picks = db.prepare(`
      SELECT * FROM stock_watchlist WHERE scan_id = ? ORDER BY rank ASC
    `).all(scan.id);
    res.json({ scan, picks: picks.map(hydrate) });
  });

  router.get('/scans', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const scans = db.prepare(`
      SELECT s.*,
             (SELECT COUNT(*) FROM stock_watchlist WHERE scan_id = s.id) AS pick_count,
             (SELECT COUNT(*) FROM stock_watchlist WHERE scan_id = s.id AND outcome = 'WIN')  AS wins,
             (SELECT COUNT(*) FROM stock_watchlist WHERE scan_id = s.id AND outcome = 'LOSS') AS losses
      FROM stock_scans s
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit);
    res.json({ scans });
  });

  // -------------------- manual trigger --------------------

  router.post('/scan', async (req, res) => {
    const secret = process.env.STOCK_SCAN_SECRET;
    if (secret && req.headers['x-scan-secret'] !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const result = await runScan({ db });
      res.json(result);
    } catch (err) {
      console.error('[stocks] manual scan failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------- outcome logging --------------------

  // PUT /api/stocks/pick/:id/outcome
  // Body: { outcome: 'WIN'|'LOSS'|'SKIP', pnlPct?, mfePct?, maePct?, entryTaken?, notes? }
  //
  // Logs every update to stock_outcome_log so we have an audit trail
  // if we ever want to analyse how/when outcomes were recorded.
  router.put('/pick/:id/outcome', (req, res) => {
    const id = parseInt(req.params.id);
    const { outcome, pnlPct, mfePct, maePct, entryTaken, notes } = req.body || {};

    if (!['WIN', 'LOSS', 'SKIP', null, undefined].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be WIN | LOSS | SKIP' });
    }

    const existing = db.prepare('SELECT * FROM stock_watchlist WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'pick not found' });

    db.prepare(`
      UPDATE stock_watchlist
      SET outcome       = ?,
          pnl_pct       = COALESCE(?, pnl_pct),
          mfe_pct       = COALESCE(?, mfe_pct),
          mae_pct       = COALESCE(?, mae_pct),
          entry_taken   = COALESCE(?, entry_taken),
          outcome_notes = COALESCE(?, outcome_notes),
          outcome_ts    = ?
      WHERE id = ?
    `).run(
      outcome || null,
      pnlPct ?? null,
      mfePct ?? null,
      maePct ?? null,
      entryTaken ?? null,
      notes ?? null,
      outcome ? new Date().toISOString() : null,
      id,
    );

    db.prepare(`
      INSERT INTO stock_outcome_log
        (watchlist_id, action, old_value, new_value, user_note, created_at)
      VALUES (?, 'set_outcome', ?, ?, ?, ?)
    `).run(
      id,
      existing.outcome || null,
      outcome || null,
      notes || null,
      new Date().toISOString(),
    );

    const updated = db.prepare('SELECT * FROM stock_watchlist WHERE id = ?').get(id);
    res.json({ ok: true, pick: hydrate(updated) });
  });

  // -------------------- aggregate stats --------------------

  router.get('/stats', (req, res) => {
    const totals = db.prepare(`
      SELECT
        COUNT(*)                                                AS total_closed,
        SUM(CASE WHEN outcome = 'WIN'  THEN 1 ELSE 0 END)       AS wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END)       AS losses,
        AVG(CASE WHEN outcome = 'WIN'  THEN pnl_pct END)        AS avg_win_pct,
        AVG(CASE WHEN outcome = 'LOSS' THEN pnl_pct END)        AS avg_loss_pct,
        AVG(score)                                              AS avg_score
      FROM stock_watchlist
      WHERE outcome IN ('WIN', 'LOSS')
    `).get();

    const byDirection = db.prepare(`
      SELECT direction,
             COUNT(*) AS n,
             SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM stock_watchlist
      WHERE outcome IN ('WIN', 'LOSS')
      GROUP BY direction
    `).all();

    const byScoreBand = db.prepare(`
      SELECT
        CASE
          WHEN score >= 85 THEN '85+'
          WHEN score >= 75 THEN '75-84'
          WHEN score >= 65 THEN '65-74'
          ELSE '<65'
        END AS band,
        COUNT(*) AS n,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
      FROM stock_watchlist
      WHERE outcome IN ('WIN', 'LOSS')
      GROUP BY band
      ORDER BY MIN(score) DESC
    `).all();

    const winRate = totals.total_closed
      ? (totals.wins / totals.total_closed) * 100
      : null;

    // Profit factor: total winning pnl / absolute total losing pnl
    // PF > 1.5 is the realistic target; > 2.0 is exceptional.
    const pf = db.prepare(`
      SELECT
        SUM(CASE WHEN outcome = 'WIN'  THEN pnl_pct ELSE 0 END)      AS gross_win,
        SUM(CASE WHEN outcome = 'LOSS' THEN ABS(pnl_pct) ELSE 0 END) AS gross_loss
      FROM stock_watchlist
      WHERE outcome IN ('WIN', 'LOSS') AND pnl_pct IS NOT NULL
    `).get();
    const profitFactor = (pf.gross_loss > 0)
      ? pf.gross_win / pf.gross_loss
      : null;

    res.json({
      totals: {
        ...totals,
        win_rate_pct: winRate !== null ? round(winRate, 1) : null,
        profit_factor: profitFactor !== null ? round(profitFactor, 2) : null,
      },
      byDirection: byDirection.map(r => ({
        ...r,
        win_rate_pct: r.n ? round((r.wins / r.n) * 100, 1) : null,
      })),
      byScoreBand: byScoreBand.map(r => ({
        ...r,
        win_rate_pct: r.n ? round((r.wins / r.n) * 100, 1) : null,
      })),
    });
  });

  return router;
};

function hydrate(row) {
  return {
    ...row,
    score_breakdown: safeJson(row.score_breakdown),
    levels: safeJson(row.levels_json),
    headlines: safeJson(row.headlines_json),
  };
}

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function round(n, d) {
  if (!Number.isFinite(n)) return null;
  const m = 10 ** d;
  return Math.round(n * m) / m;
}
