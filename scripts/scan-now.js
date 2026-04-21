#!/usr/bin/env node
// scripts/scan-now.js
//
// Run a full pre-market scan right now, regardless of the cron schedule.
// Useful for:
//   - Validating the scanner before the first real scheduled run
//   - Debugging after changing scorer weights / gates
//   - Running a scan outside market hours to test the pipeline
//
// Usage:
//   node scripts/scan-now.js                 # run scan, print summary
//   node scripts/scan-now.js --json          # emit full result as JSON
//   node scripts/scan-now.js --notify        # also fire notifications
//   DB_PATH=./custom.sqlite node scripts/scan-now.js
//
// Exits non-zero on failure — safe to use in shell pipelines or
// Railway one-off jobs.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { runScan } = require('../server/stockScanner');
const { notify } = require('../server/stockScanner/notifier');

const args = new Set(process.argv.slice(2));
const emitJson = args.has('--json');
const sendNotify = args.has('--notify');

async function main() {
  const dbPath = process.env.DB_PATH ||
    path.join(__dirname, '..', 'data', 'atlas.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found at ${dbPath}`);
    console.error('Create it and run migrations first — see README-STOCKS.md');
    process.exit(1);
  }

  const db = new Database(dbPath);

  const log = emitJson ? () => {} : console.log;
  log(`[scan-now] DB: ${dbPath}`);
  log(`[scan-now] Starting scan...`);

  const t0 = Date.now();
  const result = await runScan({ db, log });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (emitJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result, elapsed);
  }

  if (sendNotify) {
    log('\n[scan-now] Firing notifications...');
    await notify(result, log);
  }

  db.close();
}

function printSummary(r, elapsed) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  SCAN COMPLETE in ${elapsed}s  ·  scorer v${r.version}`);
  console.log(`${'═'.repeat(62)}`);
  console.log(`  universe:      ${r.stats.universeSize}`);
  console.log(`  fetched:       ${r.stats.fetched} (${r.stats.failed} failed)`);
  console.log(`  prefiltered:   ${r.stats.prefiltered}`);
  console.log(`  accepted:      ${r.stats.accepted}`);
  console.log(`${'─'.repeat(62)}`);

  if (!r.watchlist.length) {
    console.log('  No picks cleared the gates today.');
    console.log(`${'═'.repeat(62)}\n`);
    return;
  }

  for (const p of r.watchlist) {
    const gap = (p.gapPct >= 0 ? '+' : '') + p.gapPct.toFixed(1);
    const dir = p.levels.direction;
    const pri = p.levels.primary;
    console.log(
      `  ${String(p.rank).padStart(2)}. ${p.symbol.padEnd(6)} ${dir.padEnd(5)}` +
      `  score=${String(p.score).padStart(3)}` +
      `  gap=${gap.padStart(6)}%  rvol=${p.rvol.toFixed(1).padStart(5)}x` +
      `  atr=${p.atrPct.toFixed(1).padStart(5)}%`
    );
    console.log(
      `       ${(p.topCatalyst || 'no catalyst').padEnd(24)}` +
      `  entry $${pri.entry}  stop $${pri.stop}  t1 $${pri.target1}`
    );
  }
  console.log(`${'═'.repeat(62)}\n`);
}

main().catch(err => {
  console.error('[scan-now] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
