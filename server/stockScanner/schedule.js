// server/stockScanner/schedule.js
//
// Schedules the scanner to run each US trading day during the
// pre-market window. UAE is UTC+4 and does NOT observe DST; the US
// does. So the local UAE clock time of US pre-market shifts twice
// a year:
//
//   Standard (Nov–Mar):  US pre-market 04:00–09:30 ET = 13:00–18:30 UAE
//   DST      (Mar–Nov):  US pre-market 04:00–09:30 ET = 12:00–17:30 UAE
//
// Running at 16:00 UAE sits inside the window year-round (07:00 or
// 08:00 ET, always within 04:00–09:30). Gappers are well formed by
// then and most overnight earnings news has landed.
//
// Skip weekends. Holidays aren't explicitly tracked — the scanner
// returns an empty watchlist naturally on US market holidays because
// gap% and RVOL are both zero without trading.

const cron = require('node-cron');
const { runScan } = require('./index');
const { notify } = require('./notifier');

function installSchedule({ db, log = console.log }) {
  const expr = process.env.STOCK_SCAN_CRON || '0 16 * * 1-5';
  const tz = process.env.STOCK_SCAN_TZ || 'Asia/Dubai';

  log(`[scanner] Scheduling scan with cron '${expr}' in ${tz}`);

  cron.schedule(expr, async () => {
    try {
      log('[scanner] Scheduled scan triggered');
      const result = await runScan({ db, log });
      log(`[scanner] Scheduled scan complete: ${result.watchlist.length} picks`);

      // Fire notifications (no-op if no channels configured).
      // Isolated in its own try so notification failures don't
      // affect scan persistence or scheduling.
      try {
        await notify(result, log);
      } catch (notifyErr) {
        log(`[scanner] Notify failed (scan still persisted): ${notifyErr.message}`);
      }
    } catch (err) {
      log(`[scanner] Scheduled scan FAILED: ${err.message}`);
      console.error(err);
    }
  }, {
    timezone: tz,
    scheduled: true,
  });
}

module.exports = { installSchedule };
