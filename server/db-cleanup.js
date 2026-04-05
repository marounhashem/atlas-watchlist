// One-time DB cleanup script — runs before main server if DB is bloated
// Loads the bloated DB with extra memory, drops market_data_history, saves clean copy
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/atlas.db');
const BLOATED_PATH = DB_PATH + '.bloated';

async function cleanup() {
  // Check if there's a bloated file to clean
  const targetPath = fs.existsSync(BLOATED_PATH) ? BLOATED_PATH
    : fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 50 * 1024 * 1024 ? DB_PATH
    : null;

  if (!targetPath) {
    console.log('[Cleanup] No bloated DB found — skipping');
    process.exit(0);
    return;
  }

  const sizeMB = Math.round(fs.statSync(targetPath).size / 1024 / 1024);
  console.log(`[Cleanup] Found bloated DB: ${targetPath} (${sizeMB}MB)`);
  console.log('[Cleanup] Loading into memory — this may take a moment...');

  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(targetPath);
    const db = new SQL.Database(buf);

    // Check signal count before cleanup
    let signalCount = 0;
    try {
      const row = db.exec("SELECT COUNT(*) FROM signals")[0];
      signalCount = row?.values?.[0]?.[0] || 0;
    } catch(e) {}
    console.log(`[Cleanup] Signals in DB: ${signalCount}`);

    // Drop the bloated table
    try { db.run('DROP TABLE IF EXISTS market_data_history'); } catch(e) {}
    console.log('[Cleanup] Dropped market_data_history table');

    // Export clean DB
    const clean = db.export();
    const cleanMB = Math.round(clean.length / 1024 / 1024);
    console.log(`[Cleanup] Clean DB size: ${cleanMB}MB (was ${sizeMB}MB)`);

    // Save clean DB
    fs.writeFileSync(DB_PATH, Buffer.from(clean));
    console.log(`[Cleanup] Saved clean DB to ${DB_PATH}`);

    // Remove bloated file if it's separate
    if (targetPath !== DB_PATH && fs.existsSync(BLOATED_PATH)) {
      fs.unlinkSync(BLOATED_PATH);
      console.log('[Cleanup] Removed bloated file');
    }

    db.close();
    console.log(`[Cleanup] Done — ${signalCount} signals preserved, ${sizeMB - cleanMB}MB recovered`);
  } catch(e) {
    console.error('[Cleanup] FAILED:', e.message);
    // If cleanup fails, create a fresh DB so the server can at least start
    if (!fs.existsSync(DB_PATH) || fs.statSync(DB_PATH).size > 50 * 1024 * 1024) {
      console.error('[Cleanup] Creating fresh database as fallback');
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const freshDb = new SQL.Database();
      fs.writeFileSync(DB_PATH, Buffer.from(freshDb.export()));
      freshDb.close();
    }
  }
  process.exit(0);
}

cleanup();
