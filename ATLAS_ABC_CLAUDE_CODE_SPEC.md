# ATLAS ABC System — Claude Code Implementation Spec

## CRITICAL RULES
- Do NOT touch scorer.js scoring logic
- Do NOT touch existing webhook /webhook/pine
- Do NOT touch signals table
- Do NOT touch existing Telegram functions except as specified
- SCORER_VERSION bump required (add .ABC suffix to current version)

---

## FILE 1 — server/abcGates.js (NEW FILE)

Create this file from scratch. It handles all gate logic for the ABC system.

```js
'use strict';

// ── ABC Gate Engine ───────────────────────────────────────────────────────────
// Applies server-side filters to Pine ABC signals.
// Pine has already done structural classification (A/B/C).
// This layer adds: macro blocks, FXSSI gates, RR sanity, cooldown, verdict mapping.

const { isBankHoliday } = require('./marketHours');
const { isPreEventRisk, isPostEventSuppressed } = require('./forexCalendar');

// ── Verdict mapping by class × FXSSI ─────────────────────────────────────────
// Class A: structurally strongest — FXSSI pass=PROCEED, fail=WATCH
// Class B: needs FXSSI — FXSSI pass=PROCEED, fail=SKIP
// Class C: weakest — FXSSI pass=WATCH, fail=SKIP
function mapVerdict(pineClass, fxssiPassed) {
  if (pineClass === 'A') return fxssiPassed ? 'PROCEED' : 'WATCH';
  if (pineClass === 'B') return fxssiPassed ? 'PROCEED' : 'SKIP';
  if (pineClass === 'C') return fxssiPassed ? 'WATCH'   : 'SKIP';
  return 'SKIP';
}

// ── FXSSI gate — same logic as scorer ────────────────────────────────────────
// Returns { passed: bool, reason: string }
function checkFxssi(symbol, fxssiData) {
  if (!fxssiData) return { passed: false, reason: 'No FXSSI data' };

  const direction = fxssiData._direction; // injected by processAbcWebhook
  const longPct   = fxssiData.fxssi_long_pct  || 50;
  const shortPct  = fxssiData.fxssi_short_pct || 50;
  const trapped   = fxssiData.fxssi_trapped;

  // Trapped alignment gate — must have trapped on opposing side
  const trappedAligned = (direction === 'LONG'  && trapped === 'SHORT') ||
                         (direction === 'SHORT' && trapped === 'LONG');

  if (!trappedAligned) {
    return { passed: false, reason: `Trapped not aligned (trapped=${trapped}, dir=${direction})` };
  }

  return { passed: true, reason: `Trapped ${trapped} aligned with ${direction}` };
}

// ── Gravity proximity gate ────────────────────────────────────────────────────
// If TP is blocked by a gravity cluster, skip the trade
function checkGravity(direction, tp, fxssiData) {
  if (!fxssiData || !tp) return { passed: true, reason: 'No gravity data' };

  const gravity = fxssiData.gravity_price || fxssiData.fxssi_gravity;
  if (!gravity) return { passed: true, reason: 'No gravity level' };

  const entry = fxssiData._entry;
  if (!entry) return { passed: true, reason: 'No entry for gravity check' };

  const tpDist     = Math.abs(tp - entry);
  const gravDist   = Math.abs(gravity - entry);
  const gravInPath = direction === 'LONG'
    ? gravity > entry && gravity < tp
    : gravity < entry && gravity > tp;

  // Block if gravity is within 70% of the path to TP
  if (gravInPath && gravDist < tpDist * 0.70) {
    return { passed: false, reason: `Gravity at ${gravity} blocks TP path` };
  }

  return { passed: true, reason: 'Gravity clear of TP path' };
}

// ── Intel key levels context (reasoning annotation only, no block) ────────────
function getIntelContext(symbol, entry, tp, atr, db) {
  try {
    const intel = db.getLatestIntel ? db.getLatestIntel(symbol) : null;
    if (!intel || !intel.levels) return '';

    const levels = JSON.parse(intel.levels || '[]');
    const notes  = [];

    for (const lvl of levels) {
      const price = lvl.price || lvl.level;
      if (!price) continue;
      const distFromEntry = Math.abs(price - entry);
      const distFromTp    = Math.abs(price - tp);

      if (distFromEntry < (atr || 0) * 0.3) {
        notes.push(`✓ Key level ${price} near entry`);
      } else if (distFromTp < (atr || 0) * 0.3) {
        notes.push(`✓ Key level ${price} near TP`);
      } else {
        // Check if level is in the path between entry and TP
        const inPath = entry < tp
          ? (price > entry && price < tp)
          : (price < entry && price > tp);
        if (inPath) notes.push(`⚠ Key level ${price} in path to TP`);
      }
    }

    return notes.join(' · ');
  } catch(e) {
    return '';
  }
}

// ── Main gate runner ──────────────────────────────────────────────────────────
// Returns { verdict, blocked, reason, intelContext }
function runAbcGates(symbol, payload, fxssiData, db) {
  const { pineClass, direction, entry, sl, tp } = payload;

  // 1. Bank holiday
  if (isBankHoliday(symbol)) {
    return { verdict: 'SKIP', blocked: true, reason: 'Bank holiday' };
  }

  // 2. Pre-event suppression (<30min to high-impact event)
  if (isPreEventRisk && isPreEventRisk(symbol)) {
    return { verdict: 'SKIP', blocked: true, reason: 'Pre-event suppression' };
  }

  // 3. Post-event volatility window (<5min after event)
  if (isPostEventSuppressed && isPostEventSuppressed(symbol)) {
    return { verdict: 'SKIP', blocked: true, reason: 'Post-event volatility block' };
  }

  // 4. RR sanity check
  if (!entry || !sl || !tp) {
    return { verdict: 'SKIP', blocked: true, reason: 'Missing entry/sl/tp from Pine' };
  }
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp   - entry);
  const rr     = slDist > 0 ? Math.round((tpDist / slDist) * 10) / 10 : 0;
  if (rr < 1.5) {
    return { verdict: 'SKIP', blocked: true, reason: `RR ${rr} below 1.5` };
  }

  // 5. Inject direction into fxssiData for gate checks
  if (fxssiData) fxssiData._direction = direction;
  if (fxssiData) fxssiData._entry     = entry;

  // 6. FXSSI trapped gate
  const fxssiCheck = checkFxssi(symbol, fxssiData);

  // 7. Gravity proximity gate
  const gravityCheck = checkGravity(direction, tp, fxssiData);
  if (!gravityCheck.passed) {
    return { verdict: 'SKIP', blocked: true, reason: gravityCheck.reason };
  }

  // 8. Class × FXSSI verdict mapping
  const verdict = mapVerdict(pineClass, fxssiCheck.passed);
  if (verdict === 'SKIP') {
    return { verdict: 'SKIP', blocked: true, reason: `Class ${pineClass} + FXSSI fail → SKIP. ${fxssiCheck.reason}` };
  }

  // 9. Intel key levels context (annotation only)
  const atr          = payload.atr || slDist;
  const intelContext = getIntelContext(symbol, entry, tp, atr, db);

  const fxssiNote = fxssiCheck.passed ? `✓ ${fxssiCheck.reason}` : `⚠ ${fxssiCheck.reason}`;
  const reasoning = [
    `Class ${pineClass} ${verdict}`,
    fxssiNote,
    intelContext
  ].filter(Boolean).join(' · ');

  return { verdict, blocked: false, reason: reasoning, rr, intelContext };
}

module.exports = { runAbcGates };
```

---

## FILE 2 — server/db.js (MODIFY)

### 2a. Add abc_signals table creation

Find the block where tables are created (look for `CREATE TABLE IF NOT EXISTS signals`) and add AFTER it:

```js
// ── ABC signals table ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS abc_signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT,
    direction   TEXT,
    pine_class  TEXT,
    score       INTEGER,
    verdict     TEXT,
    entry       REAL,
    sl          REAL,
    tp          REAL,
    rr          REAL,
    session     TEXT,
    reasoning   TEXT,
    outcome     TEXT DEFAULT 'OPEN',
    outcome_ts  INTEGER,
    mfe_pct     REAL,
    ts          INTEGER,
    expires_at  INTEGER,
    fxssi_stale INTEGER DEFAULT 0,
    raw_payload TEXT
  )
`);
console.log('[DB] abc_signals table ready');
```

### 2b. Add insertAbcSignal function

Add this function near the other insert functions:

```js
function insertAbcSignal(sig) {
  try {
    const stmt = db.prepare(`
      INSERT INTO abc_signals
        (symbol, direction, pine_class, score, verdict, entry, sl, tp, rr,
         session, reasoning, outcome, ts, expires_at, fxssi_stale, raw_payload)
      VALUES
        (@symbol, @direction, @pine_class, @score, @verdict, @entry, @sl, @tp, @rr,
         @session, @reasoning, 'OPEN', @ts, @expires_at, @fxssi_stale, @raw_payload)
    `);
    const result = stmt.run({
      symbol:      sig.symbol,
      direction:   sig.direction,
      pine_class:  sig.pineClass,
      score:       sig.score || 0,
      verdict:     sig.verdict,
      entry:       sig.entry,
      sl:          sig.sl,
      tp:          sig.tp,
      rr:          sig.rr,
      session:     sig.session,
      reasoning:   sig.reasoning,
      ts:          sig.ts || Date.now(),
      expires_at:  sig.expiresAt || (Date.now() + 8 * 3600000),
      fxssi_stale: sig.fxssiStale ? 1 : 0,
      raw_payload: sig.rawPayload || null
    });
    return result.lastInsertRowid;
  } catch(e) {
    console.error('[DB] insertAbcSignal error:', e.message);
    return null;
  }
}
```

### 2c. Add getAbcSignals function

```js
function getAbcSignals(limit = 100) {
  try {
    return db.prepare(`
      SELECT * FROM abc_signals
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit);
  } catch(e) {
    console.error('[DB] getAbcSignals error:', e.message);
    return [];
  }
}
```

### 2d. Export both new functions

Find `module.exports` at the bottom and add:
```js
insertAbcSignal,
getAbcSignals,
```

---

## FILE 3 — server/index.js (MODIFY)

### 3a. Import new functions at top

Find the db destructure line and add `insertAbcSignal` and `getAbcSignals`:
```js
const { upsertMarketData, getAllSignals, getWeights, getLearningLog, updateOutcome,
        updatePaperOutcome, getPaperTradeStats, retireActiveCycle,
        getCurrentCycleSignals, getPastCycleSignals,
        insertAbcSignal, getAbcSignals   // ← ADD THESE
      } = db;
```

Also import `runAbcGates`:
```js
const { runAbcGates } = require('./abcGates');
```

### 3b. Import sendAbcSignalAlert from telegram

```js
const { sendSignalAlert, sendRecAlert, sendMorningBrief, sendHealthAlert,
        sendTest, sendAbcSignalAlert   // ← ADD THIS
      } = require('./telegram');
```

### 3c. Add ABC webhook route

Find where `/webhook/pine` is routed in the HTTP handler:
```js
if (req.url === '/webhook/pine') {
  try { processPineWebhook(parsed); }
```

ADD directly after it:
```js
} else if (req.url === '/webhook/pine-abc') {
  try { processAbcWebhook(parsed); }
  catch(e) { console.error('[Webhook] ABC error:', e.message); }
```

### 3d. Add processAbcWebhook function

Add this function near processPineWebhook (NOT inside it):

```js
function processAbcWebhook(data) {
  if (!data || !Object.keys(data).length) { console.log('[ABC] Empty body — skipping'); return; }
  if (!dbReady) { console.log('[ABC] DB not ready — skipping'); return; }

  // Auth check (same as pine webhook)
  const ws = process.env.WEBHOOK_SECRET;
  if (ws && data.secret !== ws) {
    console.warn('[ABC] Auth failed'); return;
  }

  // Symbol normalisation (same as pine webhook)
  const rawSym = data.symbol || data.ticker || null;
  if (!rawSym) { console.log('[ABC] No symbol'); return; }
  const sym = rawSym.toUpperCase()
    .replace('XAUUSD','GOLD').replace('XAGUSD','SILVER')
    .replace('USOIL','OILWTI').replace('WTI','OILWTI').replace('OIL_CRUDE','OILWTI')
    .replace('SPX500USD','US500').replace('ETHUSDT','ETHUSD')
    .replace('NAS100USD','US100').replace('DE30EUR','DE40')
    .replace('UK100GBP','UK100').replace('JP225USD','J225')
    .replace('HK50USD','HK50').replace('CN50USD','CN50');

  if (!SYMBOLS[sym]) { console.log('[ABC] Not in priority list:', sym); return; }

  const pineClass = data.class; // 'A', 'B', or 'C'
  if (!['A','B','C'].includes(pineClass)) {
    console.log(`[ABC] ${sym} — missing or invalid class field: ${pineClass}`);
    return;
  }

  const direction = (data.direction || '').toUpperCase();
  if (!['LONG','SHORT'].includes(direction)) {
    console.log(`[ABC] ${sym} — invalid direction: ${direction}`);
    return;
  }

  const entry = parseFloat(data.entry);
  const sl    = parseFloat(data.sl);
  const tp    = parseFloat(data.tp);
  const rr    = parseFloat(data.rr) || null;
  const score = parseInt(data.score) || (pineClass === 'A' ? 88 : pineClass === 'B' ? 75 : 62);

  if (!entry || !sl || !tp) {
    console.log(`[ABC] ${sym} — missing entry/sl/tp`);
    return;
  }

  // ── Cooldown — 30min same symbol + direction ──────────────────────────────
  try {
    const recent = getAbcSignals(20).find(s =>
      s.symbol    === sym &&
      s.direction === direction &&
      (Date.now() - s.ts) < 30 * 60 * 1000
    );
    if (recent) {
      const agoMin = Math.round((Date.now() - recent.ts) / 60000);
      console.log(`[ABC] ${sym} ${direction} cooldown (${agoMin}m) — skipping`);
      return;
    }
  } catch(e) {}

  // ── Get FXSSI data ────────────────────────────────────────────────────────
  const fxssiData = db.getLatestMarketData ? (() => {
    try {
      const md = db.getLatestMarketData(sym);
      if (!md) return null;
      return {
        fxssi_long_pct:  md.fxssi_long_pct,
        fxssi_short_pct: md.fxssi_short_pct,
        fxssi_trapped:   md.fxssi_trapped,
        gravity_price:   md.gravity_price
      };
    } catch(e) { return null; }
  })() : null;

  // ── Run gates ─────────────────────────────────────────────────────────────
  const payload = { pineClass, direction, entry, sl, tp, rr };
  const gates   = runAbcGates(sym, payload, fxssiData, db);

  console.log(`[ABC] ${sym} ${direction} Class${pineClass} → ${gates.verdict} | ${gates.reason}`);

  if (gates.blocked || gates.verdict === 'SKIP') return;

  // ── Expiry: 4h for forex, 6h for indices/commodities, 8h for crypto ───────
  const cfg = SYMBOLS[sym];
  const expiryHours = cfg?.assetClass === 'forex' ? 4
    : cfg?.assetClass === 'crypto' ? 8 : 6;
  const expiresAt = Date.now() + expiryHours * 3600000;

  const { getSessionNow } = require('./marketHours');
  const session = getSessionNow ? getSessionNow() : 'unknown';

  // ── Save to abc_signals ───────────────────────────────────────────────────
  const signalId = insertAbcSignal({
    symbol:     sym,
    direction,
    pineClass,
    score,
    verdict:    gates.verdict,
    entry,
    sl,
    tp,
    rr:         gates.rr || rr,
    session,
    reasoning:  gates.reason,
    expiresAt,
    fxssiStale: !fxssiData,
    rawPayload: JSON.stringify(data)
  });

  if (!signalId) { console.log(`[ABC] ${sym} — failed to save`); return; }
  console.log(`[ABC] Saved to abc_signals id:${signalId}`);

  // ── Telegram routing ──────────────────────────────────────────────────────
  // Class A or B (PROCEED or WATCH) → swing channel
  // Class C → no Telegram
  if (pineClass === 'A' || pineClass === 'B') {
    try {
      sendAbcSignalAlert({
        symbol: sym, direction, pineClass, score,
        verdict: gates.verdict, entry, sl, tp,
        rr: gates.rr || rr, session, reasoning: gates.reason
      }).catch(e => console.error('[Telegram] ABC alert error:', e.message));
    } catch(e) {}
  }

  // ── WebSocket broadcast ───────────────────────────────────────────────────
  if (broadcast) {
    broadcast({
      type:      'ABC_SIGNAL',
      signalId,
      symbol:    sym,
      direction,
      pineClass,
      verdict:   gates.verdict,
      entry, sl, tp,
      rr:        gates.rr || rr,
      score,
      session,
      reasoning: gates.reason,
      ts:        Date.now()
    });
  }
}
```

### 3e. Disable swing Telegram for current system

Find `sendSwingSignalAlert` call in scorer.js (inside `saveSignal`):
```js
if (scored.isSwing && signalId) {
  try {
    const { sendSwingSignalAlert } = require('./telegram');
    sendSwingSignalAlert(scored).catch(() => {});
  } catch(e) {}
}
```

Replace with:
```js
// Swing channel now used exclusively for ABC signals (Tab 2)
// Current system sends all PROCEED signals to main channel only
```

### 3f. Add /api/abc-signals endpoint

Find where other GET API endpoints are defined and add:

```js
app.get('/api/abc-signals', (req, res) => {
  try {
    const signals = getAbcSignals(200);
    res.json(signals);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
```

### 3g. Add ABC signals to WebSocket INIT message

Find where the INIT message is broadcast (look for `type: 'INIT'`) and add `abcSignals`:
```js
ws.send(JSON.stringify({
  type:       'INIT',
  signals:    getCurrentCycleSignals(),
  pastSignals: getPastCycleSignals(),
  abcSignals: getAbcSignals(100),   // ← ADD THIS LINE
  symbols:    Object.keys(SYMBOLS),
  ts:         Date.now()
}));
```

---

## FILE 4 — server/telegram.js (MODIFY)

Add this function. Find `TELEGRAM_SWING_BOT_TOKEN` usage in the file to locate the swing channel send logic, then add:

```js
// ── ABC signal alert → swing Telegram channel ─────────────────────────────────
async function sendAbcSignalAlert(sig) {
  const token  = process.env.TELEGRAM_SWING_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_SWING_CHAT_ID;
  if (!token || !chatId) return;

  const dir     = sig.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const verdict = sig.verdict === 'PROCEED' ? '✅ PROCEED' : '👁 WATCH';
  const cls     = sig.pineClass === 'A' ? '⭐ Class A' : sig.pineClass === 'B' ? '🔷 Class B' : '🔹 Class C';

  const msg = [
    `${dir} ${sig.symbol} — ${cls}`,
    `${verdict} | Score: ${sig.score} | RR: ${sig.rr}R`,
    `Entry: ${sig.entry} | SL: ${sig.sl} | TP: ${sig.tp}`,
    `Session: ${sig.session}`,
    sig.reasoning ? `${sig.reasoning}` : ''
  ].filter(Boolean).join('\n');

  await sendMessage(token, chatId, msg);
}
```

Export it:
```js
module.exports = {
  // ... existing exports ...
  sendAbcSignalAlert,
};
```

---

## FILE 5 — client/index.html (MODIFY)

### 5a. Add ABC tab button

Find the tab buttons (look for `id="tab-forex"` or similar tab buttons) and add:

```html
<button class="tab-btn" id="tab-abc" onclick="setFilter('ABC')">ABC</button>
```

### 5b. Add ABC class filter buttons

After the main filter buttons (ALL/PROCEED/WATCH/ACTIVE), add inside a block that only shows when ABC tab is active:

```html
<div id="abc-class-filters" style="display:none;margin-top:6px;">
  <button class="filter-btn active" onclick="setAbcClass('ALL')">ALL</button>
  <button class="filter-btn" onclick="setAbcClass('A')">⭐ A</button>
  <button class="filter-btn" onclick="setAbcClass('B')">🔷 B</button>
  <button class="filter-btn" onclick="setAbcClass('C')">🔹 C</button>
</div>
```

### 5c. Add ABC state variables

Near the top of the `<script>` section, add:
```js
let abcSignals    = [];
let abcClassFilter = 'ALL';
```

### 5d. Handle ABC signals in WebSocket INIT and message handler

In `handleMessage`, find the INIT handler and add:
```js
if (msg.type === 'INIT') {
  // ... existing code ...
  abcSignals = msg.abcSignals || [];
}
if (msg.type === 'ABC_SIGNAL') {
  abcSignals.unshift(msg);
  if (activeFilter === 'ABC') renderAbcSignals();
}
```

### 5e. Add setAbcClass function

```js
function setAbcClass(cls) {
  abcClassFilter = cls;
  document.querySelectorAll('#abc-class-filters .filter-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.includes(cls) || (cls === 'ALL' && b.textContent === 'ALL'));
  });
  renderAbcSignals();
}
```

### 5f. Add renderAbcSignals function

```js
function renderAbcSignals() {
  const container = document.getElementById('signals-container');
  if (!container) return;

  let filtered = abcSignals;
  if (abcClassFilter !== 'ALL') {
    filtered = abcSignals.filter(s => s.pine_class === abcClassFilter || s.pineClass === abcClassFilter);
  }

  if (!filtered.length) {
    container.innerHTML = '<div class="empty">No ABC signals yet — waiting for Pine alerts on /webhook/pine-abc</div>';
    return;
  }

  container.innerHTML = filtered.map(s => {
    const cls      = s.pine_class || s.pineClass || '?';
    const clsColor = cls === 'A' ? 'var(--proceed)' : cls === 'B' ? '#4d9eff' : '#888';
    const clsLabel = cls === 'A' ? '⭐ A' : cls === 'B' ? '🔷 B' : '🔹 C';
    const vColor   = s.verdict === 'PROCEED' ? 'var(--proceed)' : 'var(--watch)';
    const dColor   = s.direction === 'LONG'  ? 'var(--proceed)' : 'var(--short)';
    const age      = Math.round((Date.now() - s.ts) / 60000);

    return `<div class="signal-card" style="border-left:4px solid ${vColor}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div>
          <span style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:700;color:#eeeef5;">${esc(s.symbol)}</span>
          <span style="margin-left:8px;color:${dColor};font-size:12px;font-weight:600;">${esc(s.direction)}</span>
          <span style="margin-left:8px;background:${clsColor}22;color:${clsColor};border:1px solid ${clsColor}44;
                       border-radius:4px;padding:2px 7px;font-size:11px;font-weight:700;">${clsLabel}</span>
        </div>
        <div style="color:${vColor};font-size:11px;font-weight:600;">${esc(s.verdict)}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;">
        <div style="background:#0a0a18;border-radius:4px;padding:5px 8px;text-align:center;">
          <div style="font-size:8px;color:#444466;letter-spacing:.06em;margin-bottom:2px;">ENTRY</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:#eeeef5;">${s.entry}</div>
        </div>
        <div style="background:#0a0a18;border-radius:4px;padding:5px 8px;text-align:center;">
          <div style="font-size:8px;color:#444466;letter-spacing:.06em;margin-bottom:2px;">STOP</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--short);">${s.sl}</div>
        </div>
        <div style="background:#0a0a18;border-radius:4px;padding:5px 8px;text-align:center;">
          <div style="font-size:8px;color:#444466;letter-spacing:.06em;margin-bottom:2px;">TARGET</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--proceed);">${s.tp}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#444466;">
        <span>RR: <span style="color:#8888b0;">${s.rr}R</span></span>
        <span>Score: <span style="color:#8888b0;">${s.score}</span></span>
        <span>Session: <span style="color:#8888b0;">${esc(s.session)}</span></span>
        <span style="color:#333348;">${age}m ago</span>
      </div>
      ${s.reasoning ? `<div style="font-size:10px;color:#555575;margin-top:6px;padding-top:6px;border-top:1px solid #111120;">${esc(s.reasoning)}</div>` : ''}
    </div>`;
  }).join('');
}
```

### 5g. Wire ABC tab into setFilter

Find the `setFilter` function and add ABC handling:
```js
function setFilter(f) {
  activeFilter = f;
  // Show/hide ABC class filters
  const abcFilters = document.getElementById('abc-class-filters');
  if (abcFilters) abcFilters.style.display = f === 'ABC' ? 'flex' : 'none';

  if (f === 'ABC') {
    renderAbcSignals();
    return;
  }
  // ... existing render logic ...
  renderSignals();
}
```

---

## SCORER_VERSION BUMP

In `server/scorer.js`, find:
```js
const SCORER_VERSION = '20260407.X';
```
Change to next increment (e.g. if current is `20260407.3`, change to `20260407.4`).

---

## VERIFICATION CHECKLIST (run after implementation)

```bash
# 1. No syntax errors
node -e "require('./server/abcGates')" && echo "abcGates OK"
node -e "require('./server/db')" && echo "db OK"
node -e "require('./server/scorer')" && echo "scorer OK"

# 2. abc_signals table exists after startup
node -e "
  const db = require('./server/db');
  const r = db.getAbcSignals(1);
  console.log('getAbcSignals OK, count:', r.length);
"

# 3. Test gate logic
node -e "
  const { runAbcGates } = require('./server/abcGates');
  const result = runAbcGates('EURUSD',
    { pineClass:'A', direction:'LONG', entry:1.0850, sl:1.0820, tp:1.0940 },
    { fxssi_long_pct:35, fxssi_short_pct:65, fxssi_trapped:'SHORT' },
    {}
  );
  console.log('Gate result:', result);
"
```

Expected gate test output:
```
Gate result: { verdict: 'PROCEED', blocked: false, reason: 'Class A PROCEED · Trapped SHORT aligned with LONG', rr: 3, intelContext: '' }
```
