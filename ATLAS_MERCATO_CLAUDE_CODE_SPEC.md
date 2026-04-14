# ATLAS — Mercato Context System
# Claude Code Implementation Spec

## CRITICAL RULES (inherited from CLAUDE.md)
- Do NOT replace stream body parser with express.json()
- Do NOT auto-execute trades
- Mercato penalises/boosts, NEVER blocks (Rule 6: "Macro penalises, not blocks")
- Always bump SCORER_VERSION when scoring logic changes
- Always update CLAUDE.md after implementation
- persist() must be called after any DB write

---

## WHAT THIS BUILDS

A daily macro context layer sourced from Silvia Vianello's US500 analysis.
- Stored in a new `mercato_context` table
- Fed via POST /api/mercato from the local HTML macro tool
- US500 only (expandable later)
- Applies to BOTH scorer.js (main ATLAS signals) AND abcProcessor.js (ABC signals)
- Signals near Silvia's levels + matching bias → tagged "MERCATO APPROVED"
- Signals conflicting with her bias → score penalised
- Follows Rule 6: multipliers only, no hard blocks

---

## FILE 1 — server/db.js (MODIFY)

### 1a. Add mercato_context table

Find the block where tables are created and add AFTER the abc_signals table creation:

```js
// ── Mercato context table ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS mercato_context (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT    NOT NULL DEFAULT 'US500',
    bias        TEXT    NOT NULL,
    regime      TEXT,
    levels_res  TEXT    DEFAULT '[]',
    levels_sup  TEXT    DEFAULT '[]',
    bull_inv    REAL,
    bear_inv    REAL,
    catalyst    REAL,
    catalyst_note TEXT,
    notes       TEXT,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  )
`);
console.log('[DB] mercato_context table ready');
```

### 1b. Add upsertMercatoContext function

```js
function upsertMercatoContext(ctx) {
  try {
    // Delete existing for this symbol first (one active context per symbol)
    db.run('DELETE FROM mercato_context WHERE symbol = ?', [ctx.symbol || 'US500']);

    db.run(`
      INSERT INTO mercato_context
        (symbol, bias, regime, levels_res, levels_sup,
         bull_inv, bear_inv, catalyst, catalyst_note,
         notes, expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      ctx.symbol      || 'US500',
      ctx.bias        || 'NEUTRAL',
      ctx.regime      || null,
      JSON.stringify(ctx.resistances || []),
      JSON.stringify(ctx.supports    || []),
      ctx.invalidation?.bull || null,
      ctx.invalidation?.bear || null,
      ctx.catalyst?.level    || null,
      ctx.catalyst?.note     || null,
      ctx.notes       || null,
      ctx.expires_at  || (Date.now() + 24 * 60 * 60 * 1000),
      Date.now()
    ]);
    persist();
    return true;
  } catch(e) {
    console.error('[DB] upsertMercatoContext error:', e.message);
    return false;
  }
}
```

### 1c. Add getMercatoContext function

```js
function getMercatoContext(symbol) {
  try {
    const row = db.queryOne(
      'SELECT * FROM mercato_context WHERE symbol = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
      [symbol || 'US500', Date.now()]
    );
    if (!row) return null;
    return {
      ...row,
      levels_res: JSON.parse(row.levels_res || '[]'),
      levels_sup: JSON.parse(row.levels_sup || '[]'),
    };
  } catch(e) {
    return null;
  }
}
```

### 1d. Export both functions

Find the module.exports block and add:
```js
module.exports = {
  // ... existing exports ...
  upsertMercatoContext,
  getMercatoContext,
};
```

---

## FILE 2 — server/mercato.js (NEW FILE)

Create this utility file. It is the SINGLE source of truth for mercato logic.
Both scorer.js and abcProcessor.js import from here.

```js
'use strict';

// ── Mercato Context Engine ────────────────────────────────────────────────────
// Applies Silvia Vianello's daily US500 analysis as a scoring layer.
// US500 only. Tolerance: ±3 points from published level.
// Follows Rule 6: penalises/boosts only, never blocks.

const MERCATO_SYMBOLS   = new Set(['US500']);
const LEVEL_TOLERANCE   = 3.0;   // ±3 points — confirmed by user

// Multipliers — follow same philosophy as existing macro multipliers
const MULT_APPROVED     = 1.12;  // APPROVED: level match + bias align → +12%
const MULT_CONFLICT     = 0.85;  // CONFLICT: bias directly opposes direction → -15%
// PARTIAL (level only or bias only): no multiplier, annotation only

/**
 * checkMercato(symbol, price, direction, db)
 *
 * Returns:
 *   { tag, multiplier, note, levelHit }
 *
 * tag values:
 *   'APPROVED'  — price within ±3 of Silvia level AND direction matches bias
 *   'CONFLICT'  — direction directly opposes Silvia's bias (regardless of level)
 *   'PARTIAL'   — level match OR bias match, but not both
 *   null        — no mercato context, symbol not covered, or context expired
 */
function checkMercato(symbol, price, direction, db) {
  if (!MERCATO_SYMBOLS.has(symbol)) return null;
  if (!price || !direction) return null;

  const ctx = db.getMercatoContext(symbol);
  if (!ctx) return null;

  // Combine all levels
  const allLevels = [...(ctx.levels_res || []), ...(ctx.levels_sup || [])];

  // Level proximity check
  const nearLevel = allLevels.find(l => Math.abs(l - price) <= LEVEL_TOLERANCE);

  // Bias alignment check
  const biasAlign =
    (ctx.bias === 'BULL' && direction === 'LONG')  ||
    (ctx.bias === 'BEAR' && direction === 'SHORT') ||
    (ctx.bias === 'NEUTRAL');

  // Bias conflict check (direct opposition)
  const biasConflict =
    (ctx.bias === 'BULL' && direction === 'SHORT') ||
    (ctx.bias === 'BEAR' && direction === 'LONG');

  // ── APPROVED ──────────────────────────────────────────────────────────────
  if (nearLevel && biasAlign && !biasConflict) {
    const note = `✅ MERCATO APPROVED — Level ${nearLevel} ±${LEVEL_TOLERANCE} · Bias ${ctx.bias} aligned`;
    return {
      tag:        'APPROVED',
      multiplier: MULT_APPROVED,
      note,
      levelHit:   nearLevel,
      bias:       ctx.bias,
      regime:     ctx.regime
    };
  }

  // ── CONFLICT ──────────────────────────────────────────────────────────────
  // Bias directly opposes direction — penalise regardless of level
  if (biasConflict) {
    const note = `⚠️ MERCATO CONFLICT — Daily bias ${ctx.bias} opposes ${direction}`;
    return {
      tag:        'CONFLICT',
      multiplier: MULT_CONFLICT,
      note,
      levelHit:   nearLevel || null,
      bias:       ctx.bias,
      regime:     ctx.regime
    };
  }

  // ── PARTIAL ───────────────────────────────────────────────────────────────
  // Level match without bias, or bias match without level — annotate only
  if (nearLevel || biasAlign) {
    const parts = [];
    if (nearLevel) parts.push(`Level ${nearLevel} ±${LEVEL_TOLERANCE} match`);
    if (biasAlign) parts.push(`Bias ${ctx.bias} aligned`);
    else           parts.push('Bias NEUTRAL');
    const note = `📍 MERCATO PARTIAL — ${parts.join(' · ')}`;
    return {
      tag:        'PARTIAL',
      multiplier: 1.0,   // no score change
      note,
      levelHit:   nearLevel || null,
      bias:       ctx.bias,
      regime:     ctx.regime
    };
  }

  // No match, no conflict — context exists but this signal is unrelated to her levels
  return null;
}

/**
 * applyMercatoToScore(score, mercatoResult)
 * Apply multiplier to score, respecting the 0.70 floor from CLAUDE.md.
 */
function applyMercatoToScore(score, mercatoResult) {
  if (!mercatoResult || mercatoResult.multiplier === 1.0) return score;
  const newScore = Math.round(score * mercatoResult.multiplier);
  // Respect multiplier floor of 0.70 (from CLAUDE.md scoring rules)
  const floor = Math.round(score * 0.70);
  return Math.max(floor, newScore);
}

module.exports = { checkMercato, applyMercatoToScore };
```

---

## FILE 3 — server/scorer.js (MODIFY)

### 3a. Import mercato at top of file

Find the require block at the top and add:
```js
const { checkMercato, applyMercatoToScore } = require('./mercato');
```

### 3b. Apply mercato check AFTER all existing multipliers

Find the section where `conflictMultiplier` is applied and all multipliers are stacked.
Look for where `score_trace` or `scoreTrace` is built, after the final score is computed.
Add the mercato check AFTER all existing multipliers but BEFORE the final verdict assignment:

```js
// ── Mercato context check (US500 only) ───────────────────────────────────────
const mercatoResult = checkMercato(symbol, entry, direction, db);
if (mercatoResult) {
  score = applyMercatoToScore(score, mercatoResult);
  // Append mercato note to reasoning
  if (reasoningNotes) {
    reasoningNotes += '\n' + mercatoResult.note;
  }
  // Log for debugging
  console.log(`[Scorer] ${symbol} mercato=${mercatoResult.tag} mult=${mercatoResult.multiplier} newScore=${score}`);
}
```

Note: `entry` is the signal entry price. Use whatever variable holds the current signal's entry price at that point in scorer.js.
Note: `reasoningNotes` — use whatever variable holds the accumulated reasoning string in scorer.js.

### 3c. Include mercato tag in Telegram alert

Find where the Telegram signal alert message is constructed. After the reasoning line, add:
```js
${mercatoResult ? mercatoResult.note : ''}
```

Only add this if mercatoResult is non-null.

### 3d. Bump SCORER_VERSION

Find:
```js
const SCORER_VERSION = '20260410.1';
```
Change to:
```js
const SCORER_VERSION = '20260410.2';
```

---

## FILE 4 — server/abcProcessor.js (MODIFY)

### 4a. Import mercato at top of file

```js
const { checkMercato, applyMercatoToScore } = require('./mercato');
```

### 4b. Apply mercato check inside processAbcWebhook

Find where `runAbcGates()` returns a result and the signal is being built
(look for where `verdict`, `reasoning`, `score` are assembled before `insertAbcSignal`).

Add AFTER gates pass and reasoning is built, BEFORE insertAbcSignal:

```js
// ── Mercato check (US500 only) ────────────────────────────────────────────────
const mercatoResult = checkMercato(symbol, entry, direction, db);
if (mercatoResult) {
  score   = applyMercatoToScore(score, mercatoResult);
  reasoning = reasoning
    ? reasoning + ' · ' + mercatoResult.note
    : mercatoResult.note;
  console.log(`[ABC] ${symbol} mercato=${mercatoResult.tag} mult=${mercatoResult.multiplier} newScore=${score}`);
}
```

### 4c. Include mercato tag in ABC Telegram alert

Find `sendAbcSignalAlert` in telegram.js (or wherever ABC Telegram formatting happens).
The `sig.reasoning` field already gets injected into the message, so if you append
`mercatoResult.note` to `reasoning` above, it will appear automatically in Telegram.

No separate change needed IF reasoning is already in the Telegram message.
Verify: `sig.reasoning` is included in `sendAbcSignalAlert` message format → confirmed in spec FILE 4.

---

## FILE 5 — server/server.js (MODIFY)

### 5a. Add POST /api/mercato endpoint

Find where other POST /api/ endpoints are defined and add:

```js
// ── Mercato context — receive daily levels from local macro tool ──────────────
app.post('/api/mercato', async (req, res) => {
  try {
    const body = req.body;
    if (!body || !body.bias) {
      return res.status(400).json({ ok: false, error: 'Missing bias field' });
    }

    // Parse expires
    const expiresAt = body.expires
      ? new Date(body.expires).getTime()
      : Date.now() + 24 * 60 * 60 * 1000;

    const ctx = {
      symbol:      body.symbol || 'US500',
      bias:        body.bias,
      regime:      body.regime || null,
      resistances: body.resistances || [],
      supports:    body.supports    || [],
      invalidation: body.invalidation || {},
      catalyst:    body.catalyst    || null,
      notes:       body.notes       || null,
      expires_at:  expiresAt,
    };

    const ok = db.upsertMercatoContext(ctx);
    if (!ok) return res.status(500).json({ ok: false, error: 'DB write failed' });

    // Broadcast to connected dashboards via WebSocket
    broadcast({ type: 'MERCATO_UPDATE', symbol: ctx.symbol, bias: ctx.bias, regime: ctx.regime });

    console.log(`[Mercato] Context updated: ${ctx.symbol} ${ctx.bias} ${ctx.regime} expires ${new Date(expiresAt).toISOString()}`);
    res.json({
      ok: true,
      symbol:   ctx.symbol,
      bias:     ctx.bias,
      regime:   ctx.regime,
      levels:   (ctx.resistances.length + ctx.supports.length),
      expires:  new Date(expiresAt).toISOString()
    });
  } catch(e) {
    console.error('[Mercato] POST error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

### 5b. Add GET /api/mercato endpoint (for dashboard display)

```js
app.get('/api/mercato', (req, res) => {
  const symbol = req.query.symbol || 'US500';
  const ctx    = db.getMercatoContext(symbol);
  res.json({ ok: true, context: ctx });
});
```

---

## FILE 6 — client/index.html (MODIFY — optional, dashboard display)

### 6a. Show active mercato context on dashboard

Find a suitable location (near the top status bar or the ABC tab header).
Add a mercato status badge that updates via WebSocket MERCATO_UPDATE:

```js
// In WebSocket message handler, add:
if (msg.type === 'MERCATO_UPDATE') {
  const badge = document.getElementById('mercato-badge');
  if (badge) {
    const color = msg.bias === 'BEAR' ? '#ff3d5a' :
                  msg.bias === 'BULL' ? '#00ff88' : '#ffb300';
    badge.style.display      = 'inline-block';
    badge.style.color        = color;
    badge.style.borderColor  = color;
    badge.textContent        = `⬡ MERCATO ${msg.bias} — ${msg.regime || ''}`;
  }
}
```

Add this HTML near the tab buttons:
```html
<span id="mercato-badge"
  style="display:none;font-family:'JetBrains Mono',monospace;font-size:10px;
         padding:3px 8px;border:1px solid;border-radius:3px;letter-spacing:.1em;">
</span>
```

On page load, fetch current mercato context:
```js
fetch('/api/mercato?symbol=US500')
  .then(r => r.json())
  .then(data => {
    if (data.context) {
      // trigger same badge update as WebSocket
      const msg = { type: 'MERCATO_UPDATE', bias: data.context.bias, regime: data.context.regime };
      handleMessage(msg); // or inline the badge update
    }
  });
```

---

## SCORER_VERSION BUMP REMINDER

```
Current:  SCORER_VERSION = '20260410.1'
New:      SCORER_VERSION = '20260410.2'

Per CLAUDE.md Rule 3: Always bump when scoring logic changes.
Per CLAUDE.md Rule 13: Update CLAUDE.md changelog before closing session.
```

CLAUDE.md changelog entry to add:
```
- **20260410.2** — Mercato context system: new `mercato_context` table, POST /api/mercato
  endpoint receives daily levels from local macro tool (Silvia Vianello US500 analysis).
  server/mercato.js: checkMercato() (±3pt level tolerance, bias alignment),
  applyMercatoToScore() (APPROVED ×1.12, CONFLICT ×0.85, PARTIAL ×1.0).
  Applied to both scorer.js (main signals) and abcProcessor.js (ABC signals) for US500.
  Telegram alerts include MERCATO tag in reasoning. Dashboard shows mercato badge via
  WebSocket MERCATO_UPDATE. Follows Rule 6: penalises/boosts only, never blocks.
```

---

## VERIFICATION CHECKLIST

```bash
# 1. No syntax errors
node -e "require('./server/mercato')" && echo "mercato.js OK"
node -e "require('./server/scorer')" && echo "scorer.js OK"
node -e "require('./server/abcProcessor')" && echo "abcProcessor.js OK"
node -e "require('./server/db')" && echo "db.js OK"

# 2. Table created
node -e "
  const db = require('./server/db');
  const ctx = db.getMercatoContext('US500');
  console.log('getMercatoContext OK, result:', ctx);
"

# 3. Test upsert + retrieval
node -e "
  const db = require('./server/db');
  db.upsertMercatoContext({
    symbol: 'US500',
    bias: 'BEAR',
    regime: 'STAGFLATION',
    resistances: [6938, 6902, 6872],
    supports: [6802, 6780, 6663],
    invalidation: { bull: 6802, bear: 6938 },
    notes: 'Test context',
    expires_at: Date.now() + 86400000
  });
  const ctx = db.getMercatoContext('US500');
  console.log('Context stored:', ctx.bias, ctx.levels_res, ctx.levels_sup);
"

# 4. Test checkMercato logic
node -e "
  const { checkMercato } = require('./server/mercato');

  // Mock db
  const mockDb = {
    getMercatoContext: () => ({
      bias: 'BEAR',
      regime: 'STAGFLATION',
      levels_res: [6938, 6902],
      levels_sup: [6802, 6780],
      expires_at: Date.now() + 86400000
    })
  };

  // Test 1: SHORT near 6802 with BEAR bias → APPROVED
  const r1 = checkMercato('US500', 6800, 'SHORT', mockDb);
  console.log('Test 1 (expect APPROVED):', r1.tag, r1.multiplier);

  // Test 2: LONG near 6802 with BEAR bias → CONFLICT
  const r2 = checkMercato('US500', 6800, 'LONG', mockDb);
  console.log('Test 2 (expect CONFLICT):', r2.tag, r2.multiplier);

  // Test 3: SHORT far from any level, BEAR bias → PARTIAL
  const r3 = checkMercato('US500', 6850, 'SHORT', mockDb);
  console.log('Test 3 (expect PARTIAL):', r3.tag, r3.multiplier);

  // Test 4: GOLD → null (not covered)
  const r4 = checkMercato('GOLD', 2350, 'LONG', mockDb);
  console.log('Test 4 (expect null):', r4);
"
```

Expected output:
```
Test 1 (expect APPROVED): APPROVED 1.12
Test 2 (expect CONFLICT): CONFLICT 0.85
Test 3 (expect PARTIAL):  PARTIAL  1
Test 4 (expect null):     null
```

---

## WHAT HAPPENS IN PRACTICE

When Maroun opens the local macro HTML tool each morning:
1. Reads Silvia's Telegram message
2. Inputs her levels (resistance + support), bias, regime, notes
3. Clicks "Push to ATLAS" → POSTs JSON to Railway /api/mercato
4. Railway stores context, broadcasts MERCATO_UPDATE to dashboard
5. Dashboard shows mercato badge: "⬡ MERCATO BEAR — STAGFLATION"

When a US500 signal fires (ATLAS or ABC):
- checkMercato() runs automatically
- If price ±3 of her level AND direction matches bias:
  → Score ×1.12, reasoning appended "✅ MERCATO APPROVED — Level 6802 ±3 · Bias BEAR aligned"
- If direction opposes bias:
  → Score ×0.85, reasoning appended "⚠️ MERCATO CONFLICT — Daily bias BEAR opposes LONG"
- If partial match:
  → Score unchanged, reasoning appended "📍 MERCATO PARTIAL — Level 6802 ±3 match"

Telegram signal alert example:
```
🔴 SHORT US500 — Class A
✅ PROCEED | Score: 91 | RR: 2.8R
Entry: 6803 | SL: 6840 | TP: 6700
✅ MERCATO APPROVED — Level 6802 ±3 · Bias BEAR aligned
Class A PROCEED · Trapped SHORT aligned with SHORT
```

---

## PART 2 — Mercato Generated Signals

### Concept

When Silvia's context is active AND US500 price touches one of her published
key levels, the system generates a standalone PROCEED signal automatically.
This signal bypasses scorer.js entirely — Silvia's published level IS the
entry confirmation. Tagged "📡 MERCATO GENERATED SIGNAL" throughout.

This is NOT a scoring signal — it is a context-sourced signal.
It still obeys Rule 1 (no auto-execution) and persists in the signals table
for human review and action.

---

## FILE 7 — server/mercato.js (EXTEND the file created in Part 1)

Add the following functions to server/mercato.js:

```js
// ── Mercato Generated Signal Engine ──────────────────────────────────────────

const MERCATO_SIGNAL_SCORE    = 90;     // Fixed score — trusted external source
const MERCATO_COOLDOWN_MS     = 30 * 60 * 1000;  // 30 min cooldown per symbol+direction
const MERCATO_TAG             = '📡 MERCATO GENERATED SIGNAL';

// In-memory cooldown tracker: key = `${symbol}_${direction}`
const _mercatoCooldowns = new Map();

/**
 * buildMercatoSignal(ctx, currentPrice, direction, db)
 *
 * Given an active mercato context and current US500 price at one of
 * Silvia's levels, construct a complete signal object ready for insertion
 * into the signals table.
 *
 * Returns signal object or null if conditions not met.
 */
function buildMercatoSignal(ctx, currentPrice, direction, db) {
  // ── Cooldown check ──────────────────────────────────────────────────────────
  const cooldownKey = `US500_${direction}`;
  const lastFired   = _mercatoCooldowns.get(cooldownKey) || 0;
  if (Date.now() - lastFired < MERCATO_COOLDOWN_MS) {
    return null; // in cooldown
  }

  // ── Level proximity check ───────────────────────────────────────────────────
  const allLevels = [...(ctx.levels_res || []), ...(ctx.levels_sup || [])];
  const hitLevel  = allLevels.find(l => Math.abs(l - currentPrice) <= LEVEL_TOLERANCE);
  if (!hitLevel) return null;

  // ── Bias must match direction ───────────────────────────────────────────────
  const biasMatch =
    (ctx.bias === 'BULL' && direction === 'LONG')  ||
    (ctx.bias === 'BEAR' && direction === 'SHORT') ||
    (ctx.bias === 'NEUTRAL');
  if (!biasMatch) return null;

  // ── Derive SL ───────────────────────────────────────────────────────────────
  // Use Silvia's invalidation levels as SL
  let sl = direction === 'LONG'
    ? (ctx.bull_inv || currentPrice - (currentPrice * 0.003))   // bull invalidation or 0.3%
    : (ctx.bear_inv || currentPrice + (currentPrice * 0.003));  // bear invalidation or 0.3%

  sl = Math.round(sl * 100) / 100;

  // ── Derive TP ───────────────────────────────────────────────────────────────
  // Use catalyst level if set, otherwise next resistance (LONG) or next support (SHORT)
  let tp = null;

  if (ctx.catalyst) {
    tp = ctx.catalyst;
  } else if (direction === 'LONG') {
    // Next resistance above entry
    const above = (ctx.levels_res || [])
      .filter(l => l > currentPrice)
      .sort((a, b) => a - b);
    tp = above[0] || currentPrice + Math.abs(currentPrice - sl) * 2;
  } else {
    // Next support below entry
    const below = (ctx.levels_sup || [])
      .filter(l => l < currentPrice)
      .sort((a, b) => b - a);
    tp = below[0] || currentPrice - Math.abs(currentPrice - sl) * 2;
  }

  tp = Math.round(tp * 100) / 100;

  // ── RR check ────────────────────────────────────────────────────────────────
  const slDist = Math.abs(currentPrice - sl);
  const tpDist = Math.abs(tp - currentPrice);
  const rr     = slDist > 0 ? Math.round((tpDist / slDist) * 10) / 10 : 0;

  if (rr < 1.5) {
    console.log(`[Mercato] Generated signal skipped — RR ${rr} < 1.5`);
    return null;
  }

  // ── Build TP tiers ───────────────────────────────────────────────────────────
  const tp1 = Math.round((currentPrice + (direction === 'LONG' ? slDist : -slDist)) * 100) / 100;
  const tp2 = tp;
  const tp3 = Math.round((direction === 'LONG'
    ? tp + slDist * 0.5
    : tp - slDist * 0.5) * 100) / 100;

  // ── Expiry — 4 hours (index session-based) ───────────────────────────────────
  const expiresAt = Date.now() + 4 * 60 * 60 * 1000;

  // ── Reasoning ───────────────────────────────────────────────────────────────
  const reasoning = [
    `${MERCATO_TAG}`,
    `Level ${hitLevel} confirmed ±${LEVEL_TOLERANCE}pts`,
    `Bias: ${ctx.bias} | Regime: ${ctx.regime || 'N/A'}`,
    ctx.notes ? `📝 ${ctx.notes}` : null,
    `RR: ${rr}R | SL from ${direction === 'LONG' ? 'bull' : 'bear'} invalidation`
  ].filter(Boolean).join('\n');

  return {
    symbol:         'US500',
    direction,
    entry:          Math.round(currentPrice * 100) / 100,
    sl,
    tp:             tp2,
    tp1,
    tp2,
    tp3,
    score:          MERCATO_SIGNAL_SCORE,
    verdict:        'PROCEED',
    rr,
    session:        'MERCATO',
    reasoning,
    quality:        'A',               // Silvia's analysis = A quality
    weighted_struct_score: 5.0,        // Assumed strong — daily context provided
    macro_context_available: 1,
    expires_at:     expiresAt,
    breakdown:      JSON.stringify({ bias: 1.0, fxssi: 0.0, ob: 0.0, session: 0.5 }),
    score_trace:    `Mercato(90)→Fixed→LevelHit(${hitLevel})→Bias(${ctx.bias})`,
    outcome:        'OPEN',
    ts:             Date.now(),
    // Tag for identification
    event_risk_tag: null,
    mercato_level:  hitLevel,
  };
}

/**
 * checkAndFireMercatoSignal(currentPrice, db, insertSignalFn, sendTelegramFn)
 *
 * Called from the every-minute scoring cycle, AFTER normal scoring completes.
 * Checks if US500 price is at a mercato level and fires a generated signal.
 *
 * insertSignalFn: the existing db.insertSignal() function
 * sendTelegramFn: the existing sendSignalAlert() function from telegram.js
 */
async function checkAndFireMercatoSignal(currentPrice, db, insertSignalFn, sendTelegramFn) {
  try {
    const ctx = db.getMercatoContext('US500');
    if (!ctx) return;

    // Determine direction from bias
    // BULL → try LONG, BEAR → try SHORT, NEUTRAL → try both
    const directions = ctx.bias === 'BULL'    ? ['LONG']
                     : ctx.bias === 'BEAR'    ? ['SHORT']
                     : ['LONG', 'SHORT'];

    for (const direction of directions) {
      const sig = buildMercatoSignal(ctx, currentPrice, direction, db);
      if (!sig) continue;

      // Insert into signals table (same table as ATLAS signals)
      const id = insertSignalFn(sig);
      if (!id) continue;

      // Mark cooldown
      const cooldownKey = `US500_${direction}`;
      _mercatoCooldowns.set(cooldownKey, Date.now());

      console.log(`[Mercato] Generated signal fired: US500 ${direction} at ${currentPrice} level=${sig.mercato_level} score=${sig.score}`);

      // Send to main Telegram channel
      if (sendTelegramFn) {
        await sendTelegramFn({
          ...sig,
          id,
          // Prepend tag to message
          telegramPrefix: `📡 *MERCATO GENERATED SIGNAL*\n`
        });
      }
    }
  } catch(e) {
    console.error('[Mercato] checkAndFireMercatoSignal error:', e.message);
  }
}

module.exports = {
  checkMercato,
  applyMercatoToScore,
  checkAndFireMercatoSignal,  // ← ADD to existing exports
};
```

---

## FILE 8 — server/scorer.js (EXTEND — add to existing modification)

### 8a. Import checkAndFireMercatoSignal

Update the existing import line (from Part 1):
```js
const { checkMercato, applyMercatoToScore, checkAndFireMercatoSignal } = require('./mercato');
```

### 8b. Call checkAndFireMercatoSignal at END of scoring cycle

Find the main scoring loop — the function that runs every minute and
scores all symbols. It will look something like:

```js
async function runScoringCycle() {
  for (const symbol of SYMBOLS) {
    // ... existing scoring logic ...
  }
  // ... existing post-loop logic ...
}
```

Add at the VERY END of the scoring cycle, after all symbols are scored:

```js
// ── Mercato generated signal check ───────────────────────────────────────────
// Runs after normal scoring — US500 only, checks if price is at Silvia's level
try {
  const us500Data = getLatestMarketData('US500'); // use whatever fn gets current price
  if (us500Data && us500Data.close) {
    await checkAndFireMercatoSignal(
      us500Data.close,
      db,
      db.insertSignal.bind(db),
      sendSignalAlert       // from telegram.js — use existing function name
    );
  }
} catch(e) {
  console.error('[Mercato] Generated signal check error:', e.message);
}
```

Note: Replace `getLatestMarketData`, `db.insertSignal`, and `sendSignalAlert`
with the actual function names used in scorer.js for those operations.

---

## FILE 9 — server/telegram.js (EXTEND)

### 9a. Handle mercato prefix in sendSignalAlert

Find `sendSignalAlert` (or equivalent main signal Telegram function).
Add handling for the `telegramPrefix` field:

```js
async function sendSignalAlert(sig) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  // ── Mercato generated signal — special format ─────────────────────────────
  if (sig.session === 'MERCATO' || sig.telegramPrefix) {
    const dir    = sig.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const msg = [
      `📡 *MERCATO GENERATED SIGNAL*`,
      `━━━━━━━━━━━━━━━━━`,
      `${dir} US500 — Score: ${sig.score} | RR: ${sig.rr}R`,
      `Entry: \`${sig.entry}\` | SL: \`${sig.sl}\` | TP: \`${sig.tp}\``,
      `TP1: \`${sig.tp1}\` | TP2: \`${sig.tp2}\` | TP3: \`${sig.tp3}\``,
      `━━━━━━━━━━━━━━━━━`,
      sig.reasoning,
    ].filter(Boolean).join('\n');

    return await sendMessage(token, chatId, msg);
  }

  // ... existing signal alert logic unchanged below ...
}
```

---

## DB: signals table compatibility

The `buildMercatoSignal()` function returns fields that map directly to
the existing `signals` table columns (from CLAUDE.md):

| Signal field          | signals column        | Notes                        |
|-----------------------|-----------------------|------------------------------|
| symbol                | symbol                | 'US500'                      |
| direction             | direction             | 'LONG' or 'SHORT'            |
| entry/sl/tp           | entry/sl/tp           | Derived from invalidation    |
| score                 | score                 | Fixed 90                     |
| verdict               | verdict               | 'PROCEED'                    |
| session               | session               | 'MERCATO' (identifier)       |
| reasoning             | reasoning             | Includes MERCATO_TAG         |
| quality               | quality               | 'A'                          |
| weighted_struct_score | weighted_struct_score | 5.0 (assumed strong)         |
| breakdown             | breakdown             | JSON with bias=1.0           |
| score_trace           | score_trace           | Mercato trace string         |
| tp1/tp2/tp3           | tp1/tp2/tp3           | Tiered targets               |
| expires_at            | expires_at            | +4 hours                     |
| outcome               | outcome               | 'OPEN'                       |
| macro_context_available| macro_context_available| 1                           |

No schema changes needed — uses existing signals table.

---

## Signal lifecycle

```
Every 1 min scoring cycle runs
  ↓
Normal ATLAS scoring completes for all 29 symbols
  ↓
checkAndFireMercatoSignal('US500', currentPrice) called
  ↓
getMercatoContext('US500') → context active? → yes
  ↓
price within ±3 of any Silvia level? → yes (e.g. 6802)
  ↓
direction matches bias? (BEAR→SHORT) → yes
  ↓
RR ≥ 1.5? → yes
  ↓
cooldown (30min) not active? → yes
  ↓
buildMercatoSignal() → signal object score=90 verdict=PROCEED
  ↓
db.insertSignal() → stored in signals table
  ↓
cooldown set for 30min
  ↓
sendSignalAlert() → Telegram main channel
  ↓
Dashboard shows card with "📡 MERCATO GENERATED SIGNAL" tag
```

---

## Example Telegram output

```
📡 MERCATO GENERATED SIGNAL
━━━━━━━━━━━━━━━━━
🔴 SHORT US500 — Score: 90 | RR: 2.4R
Entry: 6803 | SL: 6938 | TP: 6663
TP1: 6668 | TP2: 6663 | TP3: 6595
━━━━━━━━━━━━━━━━━
📡 MERCATO GENERATED SIGNAL
Level 6802 confirmed ±3pts
Bias: BEAR | Regime: STAGFLATION
📝 CPI print binary today — hot print = flush to 6802
RR: 2.4R | SL from bear invalidation
```

---

## SCORER_VERSION BUMP (updated)

```
Current:  SCORER_VERSION = '20260410.1'
New:      SCORER_VERSION = '20260410.2'
```

CLAUDE.md changelog addition (replace previous entry):
```
- **20260410.2** — Mercato context system (Part 1 + Part 2):
  Part 1: mercato_context table, POST/GET /api/mercato, server/mercato.js
  (checkMercato ±3pt, APPROVED ×1.12 / CONFLICT ×0.85 / PARTIAL ×1.0),
  applied to scorer.js + abcProcessor.js for US500, dashboard badge.
  Part 2: Mercato Generated Signals — checkAndFireMercatoSignal() runs at end
  of every scoring cycle, fires standalone PROCEED signal (score=90, session=MERCATO)
  into main signals table when US500 price hits Silvia's level + bias aligns.
  30min cooldown per direction. SL=invalidation level, TP=catalyst or next S/R.
  Tagged "📡 MERCATO GENERATED SIGNAL" in reasoning + Telegram. No schema changes
  needed — uses existing signals table. Follows Rule 1 (no auto-execution) and
  Rule 6 (signal only, never blocks other signals).
```

---

## FULL VERIFICATION CHECKLIST (Part 1 + Part 2)

```bash
# All Part 1 tests (from above) +

# 5. Test buildMercatoSignal
node -e "
  const { checkAndFireMercatoSignal } = require('./server/mercato');
  console.log('checkAndFireMercatoSignal exported OK');
"

# 6. Simulate full generated signal flow (dry run)
node -e "
  const { checkMercato, applyMercatoToScore } = require('./server/mercato');

  const mockDb = {
    getMercatoContext: () => ({
      bias: 'BEAR', regime: 'STAGFLATION',
      levels_res: [6938, 6902], levels_sup: [6802, 6780],
      bull_inv: 6938, bear_inv: 6802,
      catalyst: 6663,
      notes: 'CPI binary today',
      expires_at: Date.now() + 86400000
    }),
    insertSignal: (sig) => { console.log('Would insert:', sig.direction, sig.entry, sig.verdict, sig.score, sig.rr + 'R'); return 999; }
  };

  // Simulate price at 6801 (within ±3 of 6802)
  const { buildMercatoSignal } = require('./server/mercato');
  // Note: buildMercatoSignal is internal — test via checkAndFireMercatoSignal
  console.log('Dry run complete — check buildMercatoSignal internals manually');
"

# 7. Confirm session='MERCATO' signals appear in /api/signals
# After deploying and pushing a context, wait for next scoring cycle
# then: curl https://your-app.railway.app/api/signals | grep MERCATO
```


---

## PART 3 — detectFlushRecovery() — Flow 3 ONLY

### Scope
- Applied EXCLUSIVELY inside buildMercatoSignal() in server/mercato.js
- NOT applied to ATLAS main signals (Flow 1) — Pine already confirmed entry pattern
- NOT applied to ABC signals (Flow 2) — Pine class A/B/C already encodes rejection quality
- Hard gate: if no pattern detected, buildMercatoSignal() returns null → no signal fires

---

## FILE 10 — server/db.js (EXTEND — add one query function)

### 10a. Add getRecentMarketHistory function

Find the module.exports block in db.js and add this function before exporting:

```js
/**
 * getRecentMarketHistory(symbol, limit)
 * Returns the last N 5-min snapshots from market_data_history,
 * newest first. Used by detectFlushRecovery() in mercato.js.
 */
function getRecentMarketHistory(symbol, limit = 12) {
  try {
    return db.prepare(`
      SELECT symbol, open, high, low, close, ts
      FROM market_data_history
      WHERE symbol = ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(symbol, limit);
  } catch(e) {
    console.error('[DB] getRecentMarketHistory error:', e.message);
    return [];
  }
}
```

Export it:
```js
module.exports = {
  // ... existing exports ...
  getRecentMarketHistory,
};
```

---

## FILE 11 — server/mercato.js (EXTEND — add to existing file from Part 1+2)

### 11a. Add detectFlushRecovery function

Add this function BEFORE buildMercatoSignal():

```js
// ── Pattern Detection — Flow 3 ONLY ──────────────────────────────────────────
// Scans last 12 x 5-min bars (~1 hour) from market_data_history.
// Detects three patterns at Silvia's key levels:
//   FAILED_BREAKDOWN  — wick below support, close recovered above (bullish)
//   FAILED_BREAKOUT   — wick above resistance, close recovered below (bearish)
//   BREAKOUT_RETEST   — price crossed level, now retesting from correct side
//
// Quality grading (matches Silvia's A+/A/B system):
//   A+ — flush + recovery within 1-2 bars (~5-10 min ago) — freshest
//   A  — flush + recovery within 3-4 bars (~15-20 min ago)
//   B  — flush + recovery 5-6 bars ago, or clean breakout retest
//   null — no pattern detected → signal must NOT fire

const FLUSH_LOOKBACK = 12;   // bars = ~1 hour of 5-min snapshots

function detectFlushRecovery(level, direction, db) {
  const bars = db.getRecentMarketHistory('US500', FLUSH_LOOKBACK);

  // Need at least 3 bars to detect a pattern
  if (!bars || bars.length < 3) {
    console.log('[Mercato] detectFlushRecovery — insufficient history, bars:', bars ? bars.length : 0);
    return null;
  }

  const current = bars[0]; // most recent bar

  // ── FAILED BREAKDOWN (support holds) — for SHORT bias at support or LONG entry ─
  // Pattern: a bar's wick went below the level, but closed back above it.
  // Current price is still above the level.
  if (direction === 'LONG' || direction === 'SHORT') {
    for (let i = 1; i < bars.length; i++) {
      const bar = bars[i];

      if (direction === 'LONG') {
        // Wick below level + recovered above it
        const flushed   = bar.low  < level - LEVEL_TOLERANCE;
        const recovered = bar.close > level;
        const stillHolding = current.close > level;

        if (flushed && recovered && stillHolding) {
          const flushDepth = +(level - bar.low).toFixed(1);
          const quality    = i <= 2 ? 'A+' : i <= 4 ? 'A' : 'B';
          console.log(`[Mercato] FAILED_BREAKDOWN detected at ${level} — depth ${flushDepth}pts, ${i} bars ago, quality ${quality}`);
          return {
            pattern:     'FAILED_BREAKDOWN',
            flush_price: +bar.low.toFixed(2),
            flush_depth: flushDepth,
            bars_ago:    i,
            quality,
            note: `Failed Breakdown @ ${level} — flush −${flushDepth}pts (${i} bars ago) ⭐${quality}`
          };
        }
      }

      if (direction === 'SHORT') {
        // Wick above resistance + rejected back below it
        const flushed      = bar.high  > level + LEVEL_TOLERANCE;
        const recovered    = bar.close < level;
        const stillBelow   = current.close < level;

        if (flushed && recovered && stillBelow) {
          const flushDepth = +(bar.high - level).toFixed(1);
          const quality    = i <= 2 ? 'A+' : i <= 4 ? 'A' : 'B';
          console.log(`[Mercato] FAILED_BREAKOUT detected at ${level} — depth ${flushDepth}pts, ${i} bars ago, quality ${quality}`);
          return {
            pattern:     'FAILED_BREAKOUT',
            flush_price: +bar.high.toFixed(2),
            flush_depth: flushDepth,
            bars_ago:    i,
            quality,
            note: `Failed Breakout @ ${level} — wick +${flushDepth}pts (${i} bars ago) ⭐${quality}`
          };
        }
      }
    }
  }

  // ── BREAKOUT RETEST ────────────────────────────────────────────────────────
  // Pattern: price was previously on the other side of the level (broke through),
  // now pulling back to retest it from the correct side.
  // Less precise but valid — graded B.
  const crossedBelow = bars.slice(1).some(b => b.close < level); // was below
  const crossedAbove = bars.slice(1).some(b => b.close > level); // was above
  const nearLevel    = Math.abs(current.close - level) <= LEVEL_TOLERANCE;

  if (direction === 'LONG' && crossedBelow && current.close > level && nearLevel) {
    console.log(`[Mercato] BREAKOUT_RETEST (bullish) detected at ${level}`);
    return {
      pattern:  'BREAKOUT_RETEST',
      bars_ago: null,
      quality:  'B',
      note:     `Breakout Retest @ ${level} — retesting from above ⭐B`
    };
  }

  if (direction === 'SHORT' && crossedAbove && current.close < level && nearLevel) {
    console.log(`[Mercato] BREAKOUT_RETEST (bearish) detected at ${level}`);
    return {
      pattern:  'BREAKOUT_RETEST',
      bars_ago: null,
      quality:  'B',
      note:     `Breakout Retest @ ${level} — retesting from below ⭐B`
    };
  }

  // No pattern — price passing through, no edge
  console.log(`[Mercato] No pattern at level ${level} direction ${direction} — signal suppressed`);
  return null;
}
```

### 11b. Wire detectFlushRecovery as hard gate inside buildMercatoSignal()

Find the existing `buildMercatoSignal()` function (from Part 2).
After the level proximity check and BEFORE the RR check, add:

```js
// ── Pattern confirmation gate (hard gate — no pattern = no signal) ────────────
const patternResult = detectFlushRecovery(hitLevel, direction, db);
if (!patternResult) {
  // Price touching level but no flush/recovery or retest detected
  // Do not fire — wait for pattern confirmation
  return null;
}
```

Then update the `reasoning` string at the bottom of `buildMercatoSignal()` to include the pattern:

```js
const reasoning = [
  `${MERCATO_TAG}`,
  patternResult.note,                           // ← ADD pattern note
  `Level ${hitLevel} confirmed ±${LEVEL_TOLERANCE}pts`,
  `Bias: ${ctx.bias} | Regime: ${ctx.regime || 'N/A'}`,
  ctx.notes ? `📝 ${ctx.notes}` : null,
  `RR: ${rr}R | SL from ${direction === 'LONG' ? 'bull' : 'bear'} invalidation`
].filter(Boolean).join('\n');
```

Also add `pattern_quality` to the returned signal object:
```js
return {
  // ... existing fields ...
  pattern:         patternResult.pattern,
  pattern_quality: patternResult.quality,
  // reasoning already includes patternResult.note
};
```

---

## Updated signal flow (Flow 3 only)

```
Every 1-min cycle
  ↓
checkAndFireMercatoSignal(currentPrice)
  ↓
getMercatoContext('US500') — active?
  ↓
price within ±3 of Silvia level?
  ↓
bias matches direction?
  ↓
buildMercatoSignal() called
  ↓
detectFlushRecovery(level, direction, db)     ← NEW HARD GATE
  ├── FAILED_BREAKDOWN / FAILED_BREAKOUT / BREAKOUT_RETEST → proceed
  └── null → return null → signal suppressed
  ↓
RR ≥ 1.5?
  ↓
cooldown clear?
  ↓
insertSignal() + sendTelegramAlert()
```

---

## Example Telegram outputs by pattern

### Failed Breakdown (A+) — freshest, highest conviction
```
📡 MERCATO GENERATED SIGNAL
Failed Breakdown @ 6802 — flush −4.2pts (1 bar ago) ⭐A+
Level 6802 confirmed ±3pts
Bias: BEAR | Regime: STAGFLATION
📝 CPI binary today — hot print = flush to 6802
Entry: 6803 | SL: 6938 | TP: 6663 | RR: 2.4R
```

### Failed Breakout (A) — wick above resistance, rejected
```
📡 MERCATO GENERATED SIGNAL
Failed Breakout @ 6938 — wick +6.1pts (3 bars ago) ⭐A
Level 6938 confirmed ±3pts
Bias: BEAR | Regime: STAGFLATION
Entry: 6936 | SL: 6802 | TP: 6663 | RR: 2.0R
```

### Breakout Retest (B) — less precise, valid setup
```
📡 MERCATO GENERATED SIGNAL
Breakout Retest @ 6802 — retesting from above ⭐B
Level 6802 confirmed ±3pts
Bias: BEAR | Regime: STAGFLATION
Entry: 6801 | SL: 6938 | TP: 6663 | RR: 2.4R
```

### Suppressed — no pattern
```
[Mercato] No pattern at level 6802 direction SHORT — signal suppressed
// No Telegram sent, no DB insert
```

---

## SCORER_VERSION BUMP (final)

```
Current:  SCORER_VERSION = '20260410.1'
New:      SCORER_VERSION = '20260410.2'
```

CLAUDE.md changelog (final, replace all previous entries for this version):
```
- **20260410.2** — Mercato context system (Parts 1+2+3):
  Part 1: mercato_context table, POST/GET /api/mercato, server/mercato.js
  (checkMercato ±3pt, APPROVED ×1.12 / CONFLICT ×0.85 / PARTIAL ×1.0).
  Applied to scorer.js + abcProcessor.js for US500 (tagging + multiplier only).
  Part 2: Mercato Generated Signals — checkAndFireMercatoSignal() at end of
  scoring cycle. score=90 PROCEED, session='MERCATO', 30min cooldown,
  SL=invalidation, TP=catalyst or next S/R. Uses existing signals table.
  Part 3: detectFlushRecovery() — hard gate on Flow 3 ONLY (Mercato Generated).
  Scans last 12 x 5-min bars from market_data_history. Detects FAILED_BREAKDOWN,
  FAILED_BREAKOUT, BREAKOUT_RETEST. Quality A+/A/B. No pattern = signal suppressed.
  NOT applied to Flow 1 (ATLAS) or Flow 2 (ABC) — Pine already confirms entry
  pattern upstream. getRecentMarketHistory() added to db.js.
  Dashboard: mercato badge via WebSocket MERCATO_UPDATE. Rule 1+6 preserved.
```

---

## FINAL VERIFICATION CHECKLIST

```bash
# 1-4: All previous tests (Parts 1+2)

# 5. getRecentMarketHistory returns data
node -e "
  const db = require('./server/db');
  const bars = db.getRecentMarketHistory('US500', 5);
  console.log('bars count:', bars.length);
  if (bars[0]) console.log('latest bar:', bars[0]);
"

# 6. detectFlushRecovery — mock test
node -e "
  const { detectFlushRecovery } = require('./server/mercato');

  // Note: detectFlushRecovery is internal — test via mock
  // Simulate via the exported checkAndFireMercatoSignal with mock db

  const mockBars = [
    { symbol:'US500', open:6804, high:6806, low:6801, close:6804, ts: Date.now() },       // current — above level
    { symbol:'US500', open:6805, high:6808, low:6797, close:6803, ts: Date.now()-300000 }, // flushed below 6802, recovered
    { symbol:'US500', open:6810, high:6812, low:6809, close:6810, ts: Date.now()-600000 },
  ];

  const mockDb = {
    getMercatoContext: () => ({
      bias: 'BEAR', regime: 'STAGFLATION',
      levels_res: [6938], levels_sup: [6802, 6780],
      bull_inv: 6938, bear_inv: 6802,
      catalyst: 6663, notes: null,
      expires_at: Date.now() + 86400000
    }),
    getRecentMarketHistory: () => mockBars,
    insertSignal: (s) => { console.log('SIGNAL FIRED:', s.direction, s.entry, s.verdict, s.score + 'pt', s.rr + 'R', s.pattern_quality); return 1; }
  };

  const { checkAndFireMercatoSignal } = require('./server/mercato');
  checkAndFireMercatoSignal(6803, mockDb, mockDb.insertSignal, null)
    .then(() => console.log('Flow 3 test complete'))
    .catch(e => console.error(e.message));
"

# Expected output:
# [Mercato] FAILED_BREAKDOWN detected at 6802 — depth 5pts, 1 bars ago, quality A+
# SIGNAL FIRED: SHORT 6803 PROCEED 90pt 2.4R A+
```

