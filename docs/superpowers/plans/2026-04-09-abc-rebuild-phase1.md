# ABC System Rebuild — Phase 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure ABC system into separate files, add all DB migrations, create abcReasoning.js scoring engine, and clean up abcGates language — while keeping the old Pine payload format working.

**Architecture:** Move processAbcWebhook from index.js → abcProcessor.js, checkAbcOutcomes from index.js → abcManagement.js. New abcReasoning.js provides score/breakdown/reasoning builders. All DB migrations added safely. abcGates.js language cleaned (no "FXSSI"/"trapped" in user-facing strings). Old Pine payloads continue working via fallback paths.

**Tech Stack:** Node.js, sql.js (custom run/get/all wrappers), Express, WebSocket

**Constraints:**
- Never use `const` for variables that need reassignment
- All DB migrations use `try { db.run('ALTER TABLE...') } catch(e) {}`
- Do NOT touch server/scorer.js, server/outcome.js, or Tab 1 dashboard
- Do NOT use `db.prepare()` — use `run(sql, [params])`, `get(sql, params)`, `all(sql, [params])`

---

### Task 1: DB Migrations + New Tables

**Files:**
- Modify: `server/db.js`

- [ ] **Step 1: Add new columns to abc_signals migrations block**

Find the existing migration block (after `console.log('[DB] abc_signals table ready')`) and add after the existing migrations:

```js
  // Phase 1 ABC rebuild migrations
  try { db.run('ALTER TABLE abc_signals ADD COLUMN abc_version TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE abc_signals ADD COLUMN ob_top REAL'); } catch(e) {}
  try { db.run('ALTER TABLE abc_signals ADD COLUMN ob_bot REAL'); } catch(e) {}
  try { db.run('ALTER TABLE abc_signals ADD COLUMN pre_bos_swing REAL'); } catch(e) {}
  try { db.run('ALTER TABLE abc_signals ADD COLUMN rsi_at_entry REAL'); } catch(e) {}
  try { db.run('ALTER TABLE abc_signals ADD COLUMN trail_sl_sent INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE abc_signals ADD COLUMN breakdown TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE abc_signals ADD COLUMN crowd_gate TEXT'); } catch(e) {}
```

- [ ] **Step 2: Add new tables**

After the abc_signals migrations, add:

```js
  // Recommendation dedup persistence
  db.run(`CREATE TABLE IF NOT EXISTS abc_rec_sent (
    signal_id INTEGER NOT NULL,
    rec_type  TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    PRIMARY KEY (signal_id, rec_type)
  )`);

  // Daily bias store (replaces request.security)
  db.run(`CREATE TABLE IF NOT EXISTS daily_bias (
    symbol     TEXT PRIMARY KEY,
    direction  TEXT NOT NULL,
    close      REAL,
    ema200     REAL,
    above_cloud INTEGER DEFAULT 0,
    ts         INTEGER NOT NULL
  )`);

  // Class C observation signals
  db.run(`CREATE TABLE IF NOT EXISTS class_c_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT, direction TEXT, score INTEGER,
    verdict TEXT, entry REAL, sl REAL,
    tp1 REAL, tp2 REAL, tp3 REAL, rr REAL,
    session TEXT, reasoning TEXT, breakdown TEXT,
    outcome TEXT DEFAULT 'OPEN',
    outcome_ts INTEGER, pnl_pct REAL, mfe_pct REAL,
    mfe_price REAL, progress_pct REAL,
    crowd_gate TEXT, abc_version TEXT,
    ob_top REAL, ob_bot REAL, pre_bos_swing REAL,
    active_ts INTEGER, partial_closed INTEGER DEFAULT 0,
    trail_sl_sent INTEGER DEFAULT 0, rsi_at_entry REAL,
    ts INTEGER, expires_at INTEGER, raw_payload TEXT
  )`);
  console.log('[DB] abc_rec_sent, daily_bias, class_c_signals tables ready');
```

- [ ] **Step 3: Add new DB functions**

Before `module.exports`, add these functions:

```js
// ── Daily bias ──────────────────────────────────────────────────────────────
function upsertDailyBias(symbol, data) {
  try {
    run(`INSERT OR REPLACE INTO daily_bias (symbol, direction, close, ema200, above_cloud, ts)
      VALUES (?,?,?,?,?,?)`,
      [symbol, data.direction, data.close || null, data.ema200 || null, data.aboveCloud ? 1 : 0, data.ts || Date.now()]);
    persist();
  } catch(e) { console.error('[DB] upsertDailyBias error:', e?.message); }
}

function getDailyBias(symbol) {
  return get('SELECT * FROM daily_bias WHERE symbol=?', [symbol]);
}

// ── Class C signals ─────────────────────────────────────────────────────────
function insertClassCSignal(sig) {
  try {
    run(`INSERT INTO class_c_signals
      (symbol, direction, score, verdict, entry, sl, tp1, tp2, tp3, rr,
       session, reasoning, breakdown, outcome, crowd_gate, abc_version,
       ob_top, ob_bot, pre_bos_swing, ts, expires_at, raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sig.symbol, sig.direction, sig.score || 0, sig.verdict || 'OBSERVE',
       sig.entry, sig.sl, sig.tp1, sig.tp2, sig.tp3, sig.rr,
       sig.session, sig.reasoning, sig.breakdown || null,
       'OPEN', sig.crowdGate || null, sig.abcVersion || null,
       sig.obTop || null, sig.obBot || null, sig.preBosSwing || null,
       sig.ts || Date.now(), sig.expiresAt || (Date.now() + 8 * 3600000),
       sig.rawPayload || null]);
    persist();
    const row = get('SELECT last_insert_rowid() as id');
    return row?.id || null;
  } catch(e) {
    console.error('[DB] insertClassCSignal error:', e?.message);
    return null;
  }
}

function getOpenClassCSignals() {
  return all("SELECT * FROM class_c_signals WHERE outcome IN ('OPEN','ACTIVE')");
}

function getClassCSignals(limit = 100) {
  return all('SELECT * FROM class_c_signals ORDER BY ts DESC LIMIT ?', [limit]);
}

function activateClassCSignal(id, tp1, tp2, tp3) {
  try {
    run("UPDATE class_c_signals SET outcome='ACTIVE', active_ts=?, tp1=?, tp2=?, tp3=? WHERE id=? AND outcome='OPEN'",
      [Date.now(), tp1 || null, tp2 || null, tp3 || null, id]);
    persist();
  } catch(e) { console.error('[DB] activateClassCSignal error:', e?.message); }
}

function updateClassCActive(id, fields) {
  try {
    const allowed = ['mfe_pct','mfe_price','progress_pct','outcome','active_ts','partial_closed','trail_sl_sent'];
    const keys = Object.keys(fields).filter(k => allowed.includes(k));
    if (!keys.length) return;
    const sets = keys.map(k => `${k}=?`).join(',');
    const vals = keys.map(k => fields[k]);
    run(`UPDATE class_c_signals SET ${sets} WHERE id=?`, [...vals, id]);
  } catch(e) { console.error('[DB] updateClassCActive error:', e?.message); }
}

function updateClassCOutcome(id, outcome, pnl, notes) {
  try {
    run('UPDATE class_c_signals SET outcome=?, outcome_ts=?, pnl_pct=?, reasoning=COALESCE(reasoning,?)||? WHERE id=?',
      [outcome, Date.now(), pnl || null, '', notes ? ' | ' + notes : '', id]);
    persist();
  } catch(e) { console.error('[DB] updateClassCOutcome error:', e?.message); }
}

// ── ABC rec dedup ───────────────────────────────────────────────────────────
function isAbcRecSent(signalId, recType) {
  const row = get('SELECT 1 FROM abc_rec_sent WHERE signal_id=? AND rec_type=?', [signalId, recType]);
  return !!row;
}

function markAbcRecSent(signalId, recType) {
  try {
    run('INSERT OR IGNORE INTO abc_rec_sent (signal_id, rec_type, ts) VALUES (?,?,?)',
      [signalId, recType, Date.now()]);
  } catch(e) {}
}

function isAbcInfoRecSentRecently(signalId) {
  const row = get('SELECT 1 FROM abc_rec_sent WHERE signal_id=? AND rec_type=? AND ts>?',
    [signalId, 'INFO', Date.now() - 7200000]);
  return !!row;
}
```

- [ ] **Step 4: Update insertAbcSignal to include new columns**

Replace the existing `insertAbcSignal` function:

```js
function insertAbcSignal(sig) {
  try {
    run(`INSERT INTO abc_signals
      (symbol, direction, pine_class, score, verdict, entry, sl, tp, tp1, tp2, tp3, rr,
       session, reasoning, breakdown, outcome, ts, expires_at,
       fxssi_stale, fxssi_gate, crowd_gate, abc_version,
       ob_top, ob_bot, pre_bos_swing, raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sig.symbol, sig.direction, sig.pineClass, sig.score || 0, sig.verdict,
       sig.entry, sig.sl, sig.tp, sig.tp1 || null, sig.tp2 || null, sig.tp3 || null, sig.rr,
       sig.session, sig.reasoning, sig.breakdown || null,
       'OPEN', sig.ts || Date.now(), sig.expiresAt || (Date.now() + 8 * 3600000),
       sig.fxssiStale ? 1 : 0, sig.fxssiGate || sig.crowdGate || 'NO_DATA',
       sig.crowdGate || sig.fxssiGate || 'NO_DATA', sig.abcVersion || null,
       sig.obTop || null, sig.obBot || null, sig.preBosSwing || null,
       sig.rawPayload || null]);
    persist();
    const row = get('SELECT last_insert_rowid() as id');
    return row?.id || null;
  } catch(e) {
    console.error('[DB] insertAbcSignal error:', e?.message);
    return null;
  }
}
```

- [ ] **Step 5: Update activateAbcSignal to accept rsi_at_entry**

```js
function activateAbcSignal(signalId, tp1, tp2, tp3, rsiAtEntry) {
  try {
    run("UPDATE abc_signals SET outcome='ACTIVE', active_ts=?, tp1=?, tp2=?, tp3=?, rsi_at_entry=? WHERE id=? AND outcome='OPEN'",
      [Date.now(), tp1 || null, tp2 || null, tp3 || null, rsiAtEntry || null, signalId]);
    persist();
  } catch(e) { console.error('[DB] activateAbcSignal error:', e?.message); }
}
```

- [ ] **Step 6: Update updateAbcActive whitelist**

```js
function updateAbcActive(id, fields) {
  try {
    const allowed = ['mfe_pct','mfe_price','progress_pct','outcome','active_ts','partial_closed','trail_sl_sent'];
    const keys = Object.keys(fields).filter(k => allowed.includes(k));
    if (!keys.length) return;
    const sets = keys.map(k => `${k}=?`).join(',');
    const vals = keys.map(k => fields[k]);
    run(`UPDATE abc_signals SET ${sets} WHERE id=?`, [...vals, id]);
  } catch(e) { console.error('[DB] updateAbcActive error:', e?.message); }
}
```

- [ ] **Step 7: Add all new functions to module.exports**

Add to the exports line: `upsertDailyBias, getDailyBias, insertClassCSignal, getOpenClassCSignals, getClassCSignals, activateClassCSignal, updateClassCActive, updateClassCOutcome, isAbcRecSent, markAbcRecSent, isAbcInfoRecSentRecently`

- [ ] **Step 8: Verify syntax**

Run: `node -c server/db.js`
Expected: no output (clean)

- [ ] **Step 9: Commit**

```bash
git add server/db.js
git commit -m "feat: ABC rebuild Phase 1 — DB migrations, new tables, updated functions

abc_signals: added abc_version, ob_top, ob_bot, pre_bos_swing,
rsi_at_entry, trail_sl_sent, breakdown, crowd_gate columns.
insertAbcSignal stores all new fields. activateAbcSignal accepts
rsi_at_entry. updateAbcActive whitelist includes trail_sl_sent.

New tables: abc_rec_sent (recommendation dedup), daily_bias
(replaces request.security), class_c_signals (observation).

New functions: daily bias CRUD, class C signal CRUD, rec dedup.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Create abcReasoning.js

**Files:**
- Create: `server/abcReasoning.js`

- [ ] **Step 1: Create the file with buildAbcScore, buildAbcBreakdown, buildAbcReasoning**

Create `server/abcReasoning.js` with the exact code from the spec PART 6. The three functions are: `buildAbcScore(pineClass, conditions, crowdGate, dailyAligned)`, `buildAbcBreakdown(conditions, crowdGate, dailyAligned)`, `buildAbcReasoning(pineClass, direction, symbol, crowdGate, conditions, dailyDirection, fxssiData, score)`.

Module exports: `{ buildAbcScore, buildAbcBreakdown, buildAbcReasoning }`

- [ ] **Step 2: Verify syntax**

Run: `node -c server/abcReasoning.js`

- [ ] **Step 3: Commit**

```bash
git add server/abcReasoning.js
git commit -m "feat: abcReasoning.js — score/breakdown/reasoning builders

buildAbcScore: condition-based scoring (0-95 scale)
buildAbcBreakdown: 4-category breakdown (structure/confluence/momentum/crowd)
buildAbcReasoning: human-readable trade thesis

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Update abcGates.js — Language Cleanup

**Files:**
- Modify: `server/abcGates.js`

- [ ] **Step 1: Replace all FXSSI/trapped language in reason strings**

Replace every user-facing string:
- `'No FXSSI data for symbol'` → `'No crowd sentiment data available for this symbol'`
- `` `Trapped ${trapped} aligned with ${direction}` `` → `` `Crowd majority ${trapped === 'SHORT' ? 'short' : 'long'} — contrarian ${direction.toLowerCase()} pressure` ``
- `` `Trapped ${trapped} not aligned with ${direction}` `` → `'Crowd aligned with direction — no contrarian squeeze'`
- `` `No trapped crowd — long:...` `` → `` `Crowd split (long:${...}% short:${...}%) — no contrarian edge` ``

- [ ] **Step 2: Verify syntax**

Run: `node -c server/abcGates.js`

- [ ] **Step 3: Commit**

```bash
git add server/abcGates.js
git commit -m "fix: abcGates language — replace FXSSI/trapped with crowd sentiment terms

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Create abcProcessor.js — Move processAbcWebhook

**Files:**
- Create: `server/abcProcessor.js`
- Modify: `server/index.js` (remove inline function, add require)

- [ ] **Step 1: Create abcProcessor.js**

Move `processAbcWebhook` from index.js to new file. Add `ABC_VERSION` constant at top. Import all dependencies. Keep old Pine payload format working — use `data.obTop || data.entry` fallback pattern. Integrate `buildAbcScore`/`buildAbcBreakdown`/`buildAbcReasoning` from abcReasoning.js. Add daily bias lookup from DB. Add Class C routing to `class_c_signals` table. The function signature becomes `processAbcWebhook(data, { db, broadcast, SYMBOLS })` — dependencies passed in to avoid circular requires.

- [ ] **Step 2: Update index.js — replace inline function with require**

Remove the `processAbcWebhook` function body from index.js. Replace with:
```js
const { processAbcWebhook: _processAbcWebhook } = require('./abcProcessor');
```
Update the webhook route to call `_processAbcWebhook(parsed, { db, broadcast, SYMBOLS })`.

Also add the daily bias webhook route:
```js
} else if (req.url === '/webhook/pine-daily-bias') {
  try { processDailyBiasWebhook(parsed); }
  catch(e) { console.error('[Webhook] Daily bias error:', e.message); }
```

Add `processDailyBiasWebhook` function in index.js (small — just normalize symbol + call `db.upsertDailyBias`).

Add API endpoint: `GET /api/daily-bias` returns all daily_bias rows.
Add API endpoint: `GET /api/class-c-signals` returns `db.getClassCSignals(100)`.

- [ ] **Step 3: Verify syntax**

Run: `node -c server/abcProcessor.js && node -c server/index.js`

- [ ] **Step 4: Commit**

```bash
git add server/abcProcessor.js server/index.js
git commit -m "feat: abcProcessor.js — move processAbcWebhook out of index.js

ABC_VERSION = '20260409.1'. Daily bias webhook + API endpoints.
Class C routing to class_c_signals table. Old Pine payload fallbacks.
buildAbcScore/Breakdown/Reasoning integrated.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Create abcManagement.js — Move checkAbcOutcomes

**Files:**
- Create: `server/abcManagement.js`
- Modify: `server/index.js` (remove inline function, add require)

- [ ] **Step 1: Create abcManagement.js**

Move `checkAbcOutcomes` from index.js. Add `rsiHistory` map (module-level, resets on deploy). Replace in-memory `sentRecs` with `db.isAbcRecSent`/`db.markAbcRecSent`. Add Class C tracking loop (OPEN→ACTIVE, SL/TP/MFE only, no recommendations). Export: `{ checkAbcOutcomes }`.

- [ ] **Step 2: Update index.js**

Replace inline `checkAbcOutcomes` with:
```js
const { checkAbcOutcomes } = require('./abcManagement');
```
Keep the cron call: `try { checkAbcOutcomes(broadcast); } catch(e) {...}`

Remove `getAbcDp` from index.js — move to a shared location (abcProcessor.js exports it, abcManagement.js imports it).

- [ ] **Step 3: Verify syntax**

Run: `node -c server/abcManagement.js && node -c server/index.js`

- [ ] **Step 4: Commit + Push**

```bash
git add server/abcManagement.js server/index.js
git commit -m "feat: abcManagement.js — move checkAbcOutcomes, add rec dedup via DB

rsiHistory in-memory map. Class C tracking loop.
DB-persisted recommendation dedup replaces in-memory sentRecs.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push
```

---

### Task 6: Final Verification + CLAUDE.md Update

- [ ] **Step 1: Syntax check all files**

```bash
node -c server/db.js && node -c server/abcGates.js && node -c server/abcReasoning.js && node -c server/abcProcessor.js && node -c server/abcManagement.js && node -c server/index.js && echo "ALL OK"
```

- [ ] **Step 2: Update CLAUDE.md**

Add to changelog:
```
- **20260409.1** — ABC REBUILD Phase 1: File restructuring (abcProcessor.js, abcReasoning.js, abcManagement.js). New DB tables (abc_rec_sent, daily_bias, class_c_signals). New columns on abc_signals (abc_version, ob_top, ob_bot, pre_bos_swing, rsi_at_entry, trail_sl_sent, breakdown, crowd_gate). buildAbcScore replaces hardcoded 88/75/62. buildAbcBreakdown provides 4-category breakdown (structure/confluence/momentum/crowd). abcGates language cleanup (no FXSSI/trapped in user strings). Class C routes to separate table. Daily bias webhook. Rec dedup persisted to DB.
```

Update ABC system section with new file structure.

- [ ] **Step 3: Commit + Push**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md — ABC rebuild Phase 1 changelog + file structure"
git push
```
