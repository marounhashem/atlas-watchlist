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
const { notify } = require('../stockScanner/notifier');
const { sendSwingMessage } = require('../telegram');

// ── Watchdog state ──────────────────────────────────────────────────────────
// The 16:00 Asia/Dubai cron has silently dropped ticks on occasion (2026-04-22
// is a confirmed case — server logs show the startup registration but no
// "Scheduled scan triggered" line at 12:00 UTC). Root cause is either a
// Railway container restart aligned to the scheduled minute or node-cron
// dropping a tick under load. Either way, we don't want the Stocks tab to
// sit at "No picks today" waiting for a cron that never fires.
//
// Strategy: on every GET /api/stocks/watchlist/today, if it's past scan time
// on a weekday (Dubai) AND no scan exists for today, kick off runScan
// fire-and-forget. The UI polls every 120s, so the next refresh picks it up.
//
// Guards:
//   - _watchdogInFlight prevents concurrent requests from double-triggering
//     a scan that hasn't yet persisted.
//   - The scheduled cron itself still runs as normal; watchdog is a backup.
//   - Checking scan presence in the DB (not just the flag) means after a
//     server restart the watchdog still works — state doesn't need to survive.
let _watchdogInFlight = false;

function dubaiNowParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dubai',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    weekday: parts.weekday,                       // 'Mon'..'Sun'
    hour: parseInt(parts.hour, 10),               // 0..23
  };
}

function isPastScanTimeDubaiWeekday() {
  const { weekday, hour } = dubaiNowParts();
  const isWeekday = ['Mon','Tue','Wed','Thu','Fri'].includes(weekday);
  // Cron fires at 16:00 Dubai. Give it 5 min grace before the watchdog trips.
  return isWeekday && hour >= 16;
}

module.exports = function stocksRoutes(db) {
  const router = express.Router();
  router.use(express.json());

  // -------------------- watchlist reads --------------------

  function runWatchdogScan() {
    if (_watchdogInFlight) return;
    _watchdogInFlight = true;
    console.log('[scanner][watchdog] Cron missed 16:00 scan today — kicking off fallback');
    runScan({ db })
      .then(async (result) => {
        console.log(`[scanner][watchdog] Fallback scan complete: ${result.watchlist.length} picks`);
        try { await notify(result); } catch (e) {
          console.log(`[scanner][watchdog] Notify failed: ${e.message}`);
        }
      })
      .catch((err) => {
        console.error('[scanner][watchdog] Fallback scan FAILED:', err);
      })
      .finally(() => {
        _watchdogInFlight = false;
      });
  }

  router.get('/watchlist/today', (req, res) => {
    const latestScan = db.prepare(`
      SELECT * FROM stock_scans
      WHERE date(started_at) = date('now')
      ORDER BY started_at DESC
      LIMIT 1
    `).get();

    if (!latestScan) {
      // Self-heal: fire a scan if the cron missed today's window. Response
      // returns current empty state immediately; the scan runs async and
      // the next UI refresh (120s interval) picks it up.
      if (isPastScanTimeDubaiWeekday() && !_watchdogInFlight) {
        runWatchdogScan();
        return res.json({
          scan: null,
          picks: [],
          message: 'Cron missed 16:00 scan — running fallback now (refresh in 60s)',
          watchdog: 'started',
        });
      }
      const reason = _watchdogInFlight
        ? 'Fallback scan in progress (refresh in 30s)'
        : 'No scan run yet today';
      return res.json({ scan: null, picks: [], message: reason, watchdog: _watchdogInFlight ? 'running' : 'idle' });
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

  // -------------------- push today's picks to swing Telegram --------------------

  // POST /api/stocks/push-swing — fetch today's latest scan + picks and push
  // to the swing channel (TELEGRAM_SWING_BOT_TOKEN / TELEGRAM_SWING_CHAT_ID).
  // Manual one-shot — stocks notifier still targets the spot channel on scan.
  router.post('/push-swing', async (req, res) => {
    try {
      const latestScan = db.prepare(`
        SELECT * FROM stock_scans
        WHERE date(started_at) = date('now')
        ORDER BY started_at DESC
        LIMIT 1
      `).get();
      if (!latestScan) {
        return res.status(404).json({ ok: false, error: 'no scan today' });
      }
      const picks = db.prepare(`
        SELECT * FROM stock_watchlist WHERE scan_id = ? ORDER BY rank ASC
      `).all(latestScan.id).map(hydrate);

      const text = formatSwing(latestScan, picks);
      const hasToken = !!process.env.TELEGRAM_SWING_BOT_TOKEN;
      const hasChat = !!process.env.TELEGRAM_SWING_CHAT_ID;
      if (!hasToken || !hasChat) {
        return res.status(503).json({
          ok: false,
          error: 'swing Telegram env vars missing',
          hasToken, hasChat,
        });
      }
      const ok = await sendSwingMessage(text, 'HTML');
      if (!ok) return res.status(502).json({ ok: false, error: 'telegram send failed' });
      res.json({ ok: true, scanId: latestScan.id, pickCount: picks.length });
    } catch (err) {
      console.error('[stocks] push-swing failed', err);
      res.status(500).json({ ok: false, error: err.message, stack: err.stack });
    }
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

function formatSwing(scan, picks) {
  const when = new Date(scan.started_at).toLocaleString('en-GB', {
    timeZone: 'Asia/Dubai', hour12: false,
  });
  const header =
    `📈 <b>ATLAS // STOCKS — pre-market</b>\n` +
    `<i>${when} UAE · v${scan.version || ''}</i>\n` +
    `universe ${scan.universe_size ?? '—'} · accepted ${scan.accepted ?? picks.length}\n`;

  if (!picks.length) {
    return header + '\n<i>No candidates cleared the gates today.</i>';
  }

  const lines = picks.map((p, i) => {
    const dir = p.levels?.direction === 'LONG' ? '🟢' : '🔴';
    const gap = p.gap_pct != null
      ? (p.gap_pct >= 0 ? '+' : '') + Number(p.gap_pct).toFixed(1)
      : '—';
    const rvol = p.rvol != null ? Number(p.rvol).toFixed(1) : '—';
    const atrPct = p.atr_pct != null ? Number(p.atr_pct).toFixed(1) : '—';
    const cat = p.top_catalyst ? ` · ${p.top_catalyst.replace(/_/g, ' ')}` : '';
    const pri = p.levels?.primary;
    const levelLine = pri
      ? `${pri.name}: entry <code>$${pri.entry}</code> · stop <code>$${pri.stop}</code> · t1 <code>$${pri.target1}</code>`
      : 'levels unavailable';
    return (
      `\n<b>${i + 1}. ${dir} ${p.symbol}</b> — score ${p.score}\n` +
      `   gap ${gap}% · rvol ${rvol}x · atr ${atrPct}%${cat}\n` +
      `   ${levelLine}`
    );
  });

  return header + lines.join('');
}
