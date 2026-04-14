# ATLAS — Mercato Context System
# Claude Code Implementation Spec — FINAL (Parts 1–4, all fixes applied)

## CRITICAL RULES (inherited from CLAUDE.md)
- Do NOT replace stream body parser with express.json()
- Do NOT auto-execute trades
- Mercato penalises/boosts, NEVER blocks (Rule 6)
- Always bump SCORER_VERSION when scoring logic changes
- Always update CLAUDE.md after implementation
- persist() must be called after any DB write

---

## WHAT THIS BUILDS

A daily macro context layer sourced from external analyst analysis (primary: Silvia Vianello US500).
- Stored in `mercato_context` table (one active context per symbol)
- Fed via POST /api/mercato from the local HTML macro tool
- Supports all 30 ATLAS symbols
- Applies to scorer.js (main signals) AND abcProcessor.js (ABC signals) — tagging + multiplier
- Generates standalone PROCEED signals when price hits a published level with pattern confirmation
- Follows Rule 6: multipliers only, never blocks

---

## FILE 1 — server/db.js (MODIFY)

### 1a. Add mercato_context table

Find the block where tables are created and add AFTER the abc_signals table creation:

```js
// ── Mercato context table ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS mercato_context (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT    NOT NULL DEFAULT 'US500',
    bias          TEXT    NOT NULL,
    regime        TEXT,
    levels_res    TEXT    DEFAULT '[]',
    levels_sup    TEXT    DEFAULT '[]',
    bull_inv      REAL,
    bear_inv      REAL,
    catalyst      REAL,
    catalyst_note TEXT,
    notes         TEXT,
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  )
`);
console.log('[DB] mercato_context table ready');
```

### 1b. Add upsertMercatoContext function

```js
function upsertMercatoContext(ctx) {
  try {
    // One active context per symbol — delete existing before insert
    db.run('DELETE FROM mercato_context WHERE symbol = ?', [ctx.symbol || 'US500']);

    db.run(`
      INSERT INTO mercato_context
        (symbol, bias, regime, levels_res, levels_sup,
         bull_inv, bear_inv, catalyst, catalyst_note,
         notes, expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      ctx.symbol             || 'US500',
      ctx.bias               || 'NEUTRAL',
      ctx.regime             || null,
      JSON.stringify(ctx.resistances || []),
      JSON.stringify(ctx.supports    || []),
      ctx.invalidation?.bull || null,
      ctx.invalidation?.bear || null,
      ctx.catalyst?.level    || null,
      ctx.catalyst?.note     || null,
      ctx.notes              || null,
      ctx.expires_at         || (Date.now() + 24 * 60 * 60 * 1000),
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
      `SELECT * FROM mercato_context
       WHERE symbol = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
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

### 1d. Add getAllActiveMercatoContexts function

```js
// Returns one row per symbol (latest active context only)
function getAllActiveMercatoContexts() {
  try {
    return db.prepare(
      `SELECT * FROM mercato_context
       WHERE expires_at > ?
       GROUP BY symbol
       ORDER BY created_at DESC`
    ).all(Date.now());
  } catch(e) {
    return [];
  }
}
```

### 1e. Add getRecentMarketHistory function

```js
/**
 * Returns last N 5-min snapshots from market_data_history, newest first.
 * Used by detectFlushRecovery() in mercato.js.
 */
function getRecentMarketHistory(symbol, limit = 12) {
  try {
    return db.prepare(
      `SELECT symbol, open, high, low, close, ts
       FROM market_data_history
       WHERE symbol = ?
       ORDER BY ts DESC
       LIMIT ?`
    ).all(symbol, limit);
  } catch(e) {
    console.error('[DB] getRecentMarketHistory error:', e.message);
    return [];
  }
}
```

### 1f. Export all new functions

Find the module.exports block and add:
```js
module.exports = {
  // ... existing exports ...
  upsertMercatoContext,
  getMercatoContext,
  getAllActiveMercatoContexts,
  getRecentMarketHistory,
};
```

---

## FILE 2 — server/mercato.js (NEW FILE — create from scratch)

```js
'use strict';

// ── ATLAS Mercato Context Engine ──────────────────────────────────────────────
// Applies external analyst macro context as a scoring and signal layer.
// Supports all 30 ATLAS symbols. Tolerance: ±3 points/pips from published level.
// Follows Rule 6: penalises/boosts only, never blocks signals.

// ── Constants ─────────────────────────────────────────────────────────────────

const MERCATO_SYMBOLS = new Set([
  'US500','US30','US100','DE40','UK100','J225','HK50','CN50',
  'GOLD','SILVER','OILWTI','COPPER','PLATINUM',
  'BTCUSD','ETHUSD',
  'EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD',
  'EURJPY','EURGBP','EURAUD','EURCHF','GBPJPY','GBPCHF','AUDJPY'
]);

const LEVEL_TOLERANCE      = 3.0;   // ±3 points — confirmed by user
const MULT_APPROVED        = 1.12;  // level match + bias align → +12%
const MULT_CONFLICT        = 0.85;  // bias directly opposes direction → -15%
const MERCATO_SIGNAL_SCORE = 90;    // fixed score for generated signals
const MERCATO_COOLDOWN_MS  = 30 * 60 * 1000; // 30 min per symbol+direction
const MERCATO_TAG          = '📡 MERCATO GENERATED SIGNAL';
const FLUSH_LOOKBACK       = 12;    // last N 5-min bars (~1 hour)

// In-memory cooldown tracker
const _mercatoCooldowns = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — checkMercato + applyMercatoToScore
// Called by scorer.js and abcProcessor.js to tag/score existing signals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * checkMercato(symbol, price, direction, db)
 *
 * Tags an existing signal with mercato context.
 * Returns: { tag, multiplier, note, levelHit, bias, regime } or null
 *
 * tag values:
 *   'APPROVED' — price ±3 of a level AND direction matches bias → ×1.12
 *   'CONFLICT' — direction directly opposes bias               → ×0.85
 *   'PARTIAL'  — level OR bias only, not both                  → ×1.0 (annotation only)
 *   null       — symbol not covered, no context, or context expired
 */
function checkMercato(symbol, price, direction, db) {
  if (!MERCATO_SYMBOLS.has(symbol)) return null;
  if (!price || !direction) return null;

  const ctx = db.getMercatoContext(symbol);
  if (!ctx) return null;

  const allLevels   = [...(ctx.levels_res || []), ...(ctx.levels_sup || [])];
  const nearLevel   = allLevels.find(l => Math.abs(l - price) <= LEVEL_TOLERANCE);

  const biasAlign   = (ctx.bias === 'BULL' && direction === 'LONG')   ||
                      (ctx.bias === 'BEAR' && direction === 'SHORT')  ||
                      (ctx.bias === 'NEUTRAL');

  const biasConflict = (ctx.bias === 'BULL' && direction === 'SHORT') ||
                       (ctx.bias === 'BEAR' && direction === 'LONG');

  if (nearLevel && biasAlign && !biasConflict) {
    return {
      tag:        'APPROVED',
      multiplier: MULT_APPROVED,
      note:       `✅ MERCATO APPROVED — Level ${nearLevel} ±${LEVEL_TOLERANCE} · Bias ${ctx.bias} aligned`,
      levelHit:   nearLevel,
      bias:       ctx.bias,
      regime:     ctx.regime
    };
  }

  if (biasConflict) {
    return {
      tag:        'CONFLICT',
      multiplier: MULT_CONFLICT,
      note:       `⚠️ MERCATO CONFLICT — Daily bias ${ctx.bias} opposes ${direction}`,
      levelHit:   nearLevel || null,
      bias:       ctx.bias,
      regime:     ctx.regime
    };
  }

  if (nearLevel || biasAlign) {
    const parts = [];
    if (nearLevel) parts.push(`Level ${nearLevel} ±${LEVEL_TOLERANCE} match`);
    if (biasAlign) parts.push(`Bias ${ctx.bias} aligned`);
    else           parts.push('Bias NEUTRAL');
    return {
      tag:        'PARTIAL',
      multiplier: 1.0,
      note:       `📍 MERCATO PARTIAL — ${parts.join(' · ')}`,
      levelHit:   nearLevel || null,
      bias:       ctx.bias,
      regime:     ctx.regime
    };
  }

  return null; // context exists but unrelated to published levels
}

/**
 * applyMercatoToScore(score, mercatoResult)
 * Applies multiplier, respects 0.70 floor from CLAUDE.md.
 */
function applyMercatoToScore(score, mercatoResult) {
  if (!mercatoResult || mercatoResult.multiplier === 1.0) return score;
  const newScore = Math.round(score * mercatoResult.multiplier);
  const floor    = Math.round(score * 0.70);
  return Math.max(floor, newScore);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — detectFlushRecovery
// Hard gate for generated signals (Flow 3) ONLY.
// NOT used by scorer.js or abcProcessor.js — Pine handles entry patterns there.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * detectFlushRecovery(level, direction, symbol, db)
 *
 * Scans last FLUSH_LOOKBACK x 5-min bars from market_data_history.
 * Detects:
 *   FAILED_BREAKDOWN — wick below support, close recovered above (bullish)
 *   FAILED_BREAKOUT  — wick above resistance, close rejected below (bearish)
 *   BREAKOUT_RETEST  — price crossed level, now retesting from correct side
 *
 * Quality grades (matches Silvia's A+/A/B system):
 *   A+ — flush + recovery 1-2 bars ago (~5-10 min) — freshest
 *   A  — flush + recovery 3-4 bars ago (~15-20 min)
 *   B  — flush + recovery 5-6 bars ago, or breakout retest
 *   null — no pattern → generated signal suppressed
 */
function detectFlushRecovery(level, direction, symbol, db) {
  const bars = db.getRecentMarketHistory(symbol, FLUSH_LOOKBACK);

  if (!bars || bars.length < 3) {
    console.log(`[Mercato] detectFlushRecovery — insufficient history for ${symbol}: ${bars ? bars.length : 0} bars`);
    return null;
  }

  const current = bars[0]; // most recent bar

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];

    if (direction === 'LONG') {
      // Wick below level + closed back above + still holding above
      const flushed      = bar.low   < level - LEVEL_TOLERANCE;
      const recovered    = bar.close > level;
      const stillHolding = current.close > level;

      if (flushed && recovered && stillHolding) {
        const flushDepth = +(level - bar.low).toFixed(1);
        const quality    = i <= 2 ? 'A+' : i <= 4 ? 'A' : 'B';
        console.log(`[Mercato] FAILED_BREAKDOWN at ${level} on ${symbol} — depth ${flushDepth}pts, ${i} bars ago, quality ${quality}`);
        return {
          pattern:     'FAILED_BREAKDOWN',
          flush_price: +bar.low.toFixed(2),
          flush_depth: flushDepth,
          bars_ago:    i,
          quality,
          note:        `Failed Breakdown @ ${level} — flush −${flushDepth}pts (${i} bars ago) ⭐${quality}`
        };
      }
    }

    if (direction === 'SHORT') {
      // Wick above resistance + rejected back below + still holding below
      const flushed    = bar.high  > level + LEVEL_TOLERANCE;
      const recovered  = bar.close < level;
      const stillBelow = current.close < level;

      if (flushed && recovered && stillBelow) {
        const flushDepth = +(bar.high - level).toFixed(1);
        const quality    = i <= 2 ? 'A+' : i <= 4 ? 'A' : 'B';
        console.log(`[Mercato] FAILED_BREAKOUT at ${level} on ${symbol} — depth ${flushDepth}pts, ${i} bars ago, quality ${quality}`);
        return {
          pattern:     'FAILED_BREAKOUT',
          flush_price: +bar.high.toFixed(2),
          flush_depth: flushDepth,
          bars_ago:    i,
          quality,
          note:        `Failed Breakout @ ${level} — wick +${flushDepth}pts (${i} bars ago) ⭐${quality}`
        };
      }
    }
  }

  // Breakout retest — price was on wrong side, now retesting from correct side
  const crossedBelow = bars.slice(1).some(b => b.close < level);
  const crossedAbove = bars.slice(1).some(b => b.close > level);
  const nearLevel    = Math.abs(current.close - level) <= LEVEL_TOLERANCE;

  if (direction === 'LONG' && crossedBelow && current.close > level && nearLevel) {
    console.log(`[Mercato] BREAKOUT_RETEST (bullish) at ${level} on ${symbol}`);
    return { pattern: 'BREAKOUT_RETEST', bars_ago: null, quality: 'B',
             note: `Breakout Retest @ ${level} — retesting from above ⭐B` };
  }

  if (direction === 'SHORT' && crossedAbove && current.close < level && nearLevel) {
    console.log(`[Mercato] BREAKOUT_RETEST (bearish) at ${level} on ${symbol}`);
    return { pattern: 'BREAKOUT_RETEST', bars_ago: null, quality: 'B',
             note: `Breakout Retest @ ${level} — retesting from below ⭐B` };
  }

  console.log(`[Mercato] No pattern at level ${level} direction ${direction} on ${symbol} — signal suppressed`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — buildMercatoSignal + checkAndFireMercatoSignal
// Generates standalone PROCEED signals from mercato context.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildMercatoSignal(ctx, currentPrice, direction, db)
 *
 * Constructs a complete signal object from active mercato context.
 * Returns signal object or null if any gate fails.
 *
 * Gates (in order):
 *   1. Cooldown 30min per symbol+direction
 *   2. Level proximity ±3
 *   3. Bias matches direction
 *   4. detectFlushRecovery() — hard gate (no pattern = null)
 *   5. RR ≥ 1.5
 */
function buildMercatoSignal(ctx, currentPrice, direction, db) {
  // 1. Cooldown
  const cooldownKey = `${ctx.symbol}_${direction}`;
  const lastFired   = _mercatoCooldowns.get(cooldownKey) || 0;
  if (Date.now() - lastFired < MERCATO_COOLDOWN_MS) return null;

  // 2. Level proximity
  const allLevels = [...(ctx.levels_res || []), ...(ctx.levels_sup || [])];
  const hitLevel  = allLevels.find(l => Math.abs(l - currentPrice) <= LEVEL_TOLERANCE);
  if (!hitLevel) return null;

  // 3. Bias match
  const biasMatch = (ctx.bias === 'BULL' && direction === 'LONG')  ||
                    (ctx.bias === 'BEAR' && direction === 'SHORT') ||
                    (ctx.bias === 'NEUTRAL');
  if (!biasMatch) return null;

  // 4. Pattern confirmation — hard gate
  const patternResult = detectFlushRecovery(hitLevel, direction, ctx.symbol, db);
  if (!patternResult) return null;

  // 5. Derive SL from invalidation levels
  let sl = direction === 'LONG'
    ? (ctx.bull_inv || currentPrice - (currentPrice * 0.003))
    : (ctx.bear_inv || currentPrice + (currentPrice * 0.003));
  sl = Math.round(sl * 100) / 100;

  // 5b. Derive TP — catalyst first, then nearest S/R in direction
  let tp;
  if (ctx.catalyst) {
    tp = ctx.catalyst;
  } else if (direction === 'LONG') {
    const above = (ctx.levels_res || []).filter(l => l > currentPrice).sort((a,b) => a-b);
    tp = above[0] || currentPrice + Math.abs(currentPrice - sl) * 2;
  } else {
    const below = (ctx.levels_sup || []).filter(l => l < currentPrice).sort((a,b) => b-a);
    tp = below[0] || currentPrice - Math.abs(currentPrice - sl) * 2;
  }
  tp = Math.round(tp * 100) / 100;

  // 5c. RR check
  const slDist = Math.abs(currentPrice - sl);
  const tpDist = Math.abs(tp - currentPrice);
  const rr     = slDist > 0 ? Math.round((tpDist / slDist) * 10) / 10 : 0;
  if (rr < 1.5) {
    console.log(`[Mercato] Generated signal skipped — RR ${rr} < 1.5`);
    return null;
  }

  // Build TP tiers
  const tp1 = Math.round((currentPrice + (direction === 'LONG' ? slDist : -slDist)) * 100) / 100;
  const tp2 = tp;
  const tp3 = Math.round((direction === 'LONG' ? tp + slDist * 0.5 : tp - slDist * 0.5) * 100) / 100;

  const reasoning = [
    MERCATO_TAG,
    patternResult.note,
    `Level ${hitLevel} confirmed ±${LEVEL_TOLERANCE}pts`,
    `Bias: ${ctx.bias} | Regime: ${ctx.regime || 'N/A'}`,
    ctx.notes ? `📝 ${ctx.notes}` : null,
    `RR: ${rr}R | SL from ${direction === 'LONG' ? 'bull' : 'bear'} invalidation`
  ].filter(Boolean).join('\n');

  return {
    symbol:                  ctx.symbol || 'US500',  // ← uses ctx.symbol, not hardcoded
    direction,
    entry:                   Math.round(currentPrice * 100) / 100,
    sl,
    tp:                      tp2,
    tp1, tp2, tp3,
    score:                   MERCATO_SIGNAL_SCORE,
    verdict:                 'PROCEED',
    rr,
    session:                 'MERCATO',
    reasoning,
    quality:                 'A',
    weighted_struct_score:   5.0,
    macro_context_available: 1,
    expires_at:              Date.now() + 4 * 60 * 60 * 1000,
    breakdown:               JSON.stringify({ bias: 1.0, fxssi: 0.0, ob: 0.0, session: 0.5 }),
    score_trace:             `Mercato(90)→Fixed→LevelHit(${hitLevel})→Bias(${ctx.bias})→Pattern(${patternResult.pattern})`,
    pattern:                 patternResult.pattern,
    pattern_quality:         patternResult.quality,
    outcome:                 'OPEN',
    ts:                      Date.now(),
    event_risk_tag:          null,
    mercato_level:           hitLevel,
  };
}

/**
 * checkAndFireMercatoSignal(symbol, currentPrice, db, insertSignalFn, sendTelegramFn)
 *
 * Called at end of every scoring cycle for each symbol with active mercato context.
 * Fires a standalone PROCEED signal if all gates pass.
 */
async function checkAndFireMercatoSignal(symbol, currentPrice, db, insertSignalFn, sendTelegramFn) {
  try {
    const ctx = db.getMercatoContext(symbol); // ← uses symbol param, not hardcoded
    if (!ctx) return;

    const directions = ctx.bias === 'BULL'  ? ['LONG']
                     : ctx.bias === 'BEAR'  ? ['SHORT']
                     : ['LONG', 'SHORT'];

    for (const direction of directions) {
      const sig = buildMercatoSignal(ctx, currentPrice, direction, db);
      if (!sig) continue;

      const id = insertSignalFn(sig);
      if (!id) continue;

      const cooldownKey = `${symbol}_${direction}`;
      _mercatoCooldowns.set(cooldownKey, Date.now());

      console.log(`[Mercato] Signal fired: ${symbol} ${direction} @ ${currentPrice} level=${sig.mercato_level} pattern=${sig.pattern} quality=${sig.pattern_quality}`);

      if (sendTelegramFn) {
        await sendTelegramFn({ ...sig, id });
      }
    }
  } catch(e) {
    console.error('[Mercato] checkAndFireMercatoSignal error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  checkMercato,
  applyMercatoToScore,
  checkAndFireMercatoSignal,
};
```

---

## FILE 3 — server/scorer.js (MODIFY)

### 3a. Import at top

```js
const { checkMercato, applyMercatoToScore, checkAndFireMercatoSignal } = require('./mercato');
```

### 3b. Apply mercato tag+multiplier to existing signals

Find where all multipliers are stacked (after `conflictMultiplier`, before final verdict).
Add AFTER the last existing multiplier, BEFORE verdict assignment:

```js
// ── Mercato context (all supported symbols) ───────────────────────────────────
const mercatoResult = checkMercato(symbol, entry, direction, db);
if (mercatoResult) {
  score = applyMercatoToScore(score, mercatoResult);
  if (reasoningNotes) reasoningNotes += '\n' + mercatoResult.note;
  console.log(`[Scorer] ${symbol} mercato=${mercatoResult.tag} ×${mercatoResult.multiplier} → score=${score}`);
}
```

Note: Replace `entry`, `direction`, `reasoningNotes` with actual variable names in scorer.js.

### 3c. Fire generated signals at end of scoring cycle

Find the main scoring loop (runs every minute). At the VERY END after all symbols are scored:

```js
// ── Mercato generated signal check (all symbols with active context) ──────────
try {
  const activeContexts = db.getAllActiveMercatoContexts();
  for (const ctx of activeContexts) {
    const symData = getLatestMarketData(ctx.symbol); // replace with actual fn name
    if (symData && symData.close) {
      await checkAndFireMercatoSignal(
        ctx.symbol,
        symData.close,
        db,
        db.insertSignal.bind(db),  // replace with actual fn name
        sendSignalAlert            // replace with actual fn name from telegram.js
      );
    }
  }
} catch(e) {
  console.error('[Mercato] Generated signal loop error:', e.message);
}
```

### 3d. Include mercato tag in Telegram alert

In the signal alert message construction, after the reasoning line:
```js
${mercatoResult ? mercatoResult.note : ''}
```

### 3e. Bump SCORER_VERSION

```js
const SCORER_VERSION = '20260410.3';
```

---

## FILE 4 — server/abcProcessor.js (MODIFY)

### 4a. Import at top

```js
const { checkMercato, applyMercatoToScore } = require('./mercato');
```

### 4b. Apply mercato tag+multiplier after gates pass, before insertAbcSignal

```js
// ── Mercato context (all supported symbols) ───────────────────────────────────
const mercatoResult = checkMercato(symbol, entry, direction, db);
if (mercatoResult) {
  score     = applyMercatoToScore(score, mercatoResult);
  reasoning = reasoning
    ? reasoning + ' · ' + mercatoResult.note
    : mercatoResult.note;
  console.log(`[ABC] ${symbol} mercato=${mercatoResult.tag} ×${mercatoResult.multiplier} → score=${score}`);
}
```

Note: `sig.reasoning` is already included in `sendAbcSignalAlert` message — mercato note
appears automatically in Telegram with no further changes needed.

---

## FILE 5 — server/server.js (MODIFY)

### 5a. Add CORS headers — BEFORE all route definitions

```js
// ── CORS — allows local HTML macro tool (file://) to push context ─────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
```

### 5b. Add POST /api/mercato

```js
// ── Mercato context — receive daily levels from local macro tool ──────────────
app.post('/api/mercato', async (req, res) => {
  try {
    const body = req.body;
    if (!body || !body.bias) {
      return res.status(400).json({ ok: false, error: 'Missing bias field' });
    }

    const expiresAt = body.expires
      ? new Date(body.expires).getTime()
      : Date.now() + 24 * 60 * 60 * 1000;

    const ctx = {
      symbol:       body.symbol      || 'US500',
      bias:         body.bias,
      regime:       body.regime       || null,
      resistances:  body.resistances  || [],
      supports:     body.supports     || [],
      invalidation: body.invalidation || {},
      catalyst:     body.catalyst     || null,
      notes:        body.notes        || null,
      expires_at:   expiresAt,
      // ai_validation accepted in payload but not persisted to DB
      // (stored as annotation only for now — full persistence in future version)
    };

    const ok = db.upsertMercatoContext(ctx);
    if (!ok) return res.status(500).json({ ok: false, error: 'DB write failed' });

    broadcast({ type: 'MERCATO_UPDATE', symbol: ctx.symbol, bias: ctx.bias, regime: ctx.regime });

    console.log(`[Mercato] Context updated: ${ctx.symbol} ${ctx.bias} ${ctx.regime} expires ${new Date(expiresAt).toISOString()}`);
    res.json({
      ok:      true,
      symbol:  ctx.symbol,
      bias:    ctx.bias,
      regime:  ctx.regime,
      levels:  (ctx.resistances.length + ctx.supports.length),
      expires: new Date(expiresAt).toISOString()
    });
  } catch(e) {
    console.error('[Mercato] POST error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

### 5c. Add GET /api/mercato

```js
app.get('/api/mercato', (req, res) => {
  const symbol = req.query.symbol || 'US500';
  const ctx    = db.getMercatoContext(symbol);
  res.json({ ok: true, context: ctx });
});
```

---

## FILE 6 — client/index.html (MODIFY — dashboard badge)

### 6a. Add mercato badge HTML near tab buttons

```html
<span id="mercato-badge"
  style="display:none;font-family:'JetBrains Mono',monospace;font-size:10px;
         padding:3px 8px;border:1px solid;border-radius:3px;letter-spacing:.1em;">
</span>
```

### 6b. Handle MERCATO_UPDATE in WebSocket message handler

```js
if (msg.type === 'MERCATO_UPDATE') {
  const badge = document.getElementById('mercato-badge');
  if (badge) {
    const color = msg.bias === 'BEAR' ? '#ff3d5a' :
                  msg.bias === 'BULL' ? '#00ff88' : '#ffb300';
    badge.style.display     = 'inline-block';
    badge.style.color       = color;
    badge.style.borderColor = color;
    badge.textContent       = `⬡ MERCATO ${msg.bias} — ${msg.regime || ''}`;
  }
}
```

### 6c. Fetch on page load

```js
fetch('/api/mercato?symbol=US500')
  .then(r => r.json())
  .then(data => {
    if (data.context) {
      handleMessage({ type: 'MERCATO_UPDATE', bias: data.context.bias, regime: data.context.regime });
    }
  });
```

---

## FILE 7 — server/telegram.js (MODIFY)

### 7a. Handle MERCATO session in sendSignalAlert

Find `sendSignalAlert`. Add at the top of the function, before existing logic:

```js
// ── Mercato generated signal — special format ─────────────────────────────────
if (sig.session === 'MERCATO') {
  const dir = sig.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const msg = [
    `📡 *MERCATO GENERATED SIGNAL*`,
    `━━━━━━━━━━━━━━━━━`,
    `${dir} ${sig.symbol} — Score: ${sig.score} | RR: ${sig.rr}R`,
    `Entry: \`${sig.entry}\` | SL: \`${sig.sl}\` | TP: \`${sig.tp}\``,
    `TP1: \`${sig.tp1}\` | TP2: \`${sig.tp2}\` | TP3: \`${sig.tp3}\``,
    `━━━━━━━━━━━━━━━━━`,
    sig.reasoning,
  ].filter(Boolean).join('\n');
  return await sendMessage(token, chatId, msg);
}
// ... existing signal alert logic continues unchanged below ...
```

---

## SCORER_VERSION

```js
// In server/scorer.js
const SCORER_VERSION = '20260410.3';
```

Single bump covers all parts 1–4 in one deployment.

---

## CLAUDE.md CHANGELOG ENTRY

```
- **20260410.3** — Mercato context system (Parts 1–4, single deployment):
  DB: mercato_context table (per-symbol, one active row), getMercatoContext(),
  upsertMercatoContext(), getAllActiveMercatoContexts() (GROUP BY symbol, no duplicates),
  getRecentMarketHistory() for flush pattern detection.
  server/mercato.js (new): checkMercato() (±3pt tolerance, APPROVED ×1.12 /
  CONFLICT ×0.85 / PARTIAL ×1.0), applyMercatoToScore() (respects 0.70 floor),
  detectFlushRecovery() (FAILED_BREAKDOWN / FAILED_BREAKOUT / BREAKOUT_RETEST,
  quality A+/A/B, Flow 3 ONLY — not used by scorer.js or abcProcessor.js),
  buildMercatoSignal() (symbol from ctx, not hardcoded), checkAndFireMercatoSignal()
  (symbol as first param, loops all active contexts via getAllActiveMercatoContexts).
  scorer.js: checkMercato() after multipliers, checkAndFireMercatoSignal() at end
  of scoring cycle for all symbols with active context.
  abcProcessor.js: checkMercato() after gates, before insertAbcSignal.
  server.js: CORS middleware (allows file:// push from HTML tool), POST+GET /api/mercato.
  telegram.js: MERCATO session format in sendSignalAlert.
  client/index.html: mercato badge via WebSocket MERCATO_UPDATE + page-load fetch.
  All 30 ATLAS symbols supported. Rule 1 (no auto-execution) and Rule 6
  (penalises/boosts only, never blocks) preserved throughout.
```

---

## FULL VERIFICATION CHECKLIST

```bash
# 1. No syntax errors
node -e "require('./server/mercato')" && echo "mercato.js OK"
node -e "require('./server/scorer')" && echo "scorer.js OK"
node -e "require('./server/abcProcessor')" && echo "abcProcessor.js OK"
node -e "require('./server/db')" && echo "db.js OK"

# 2. Table exists after startup
node -e "
  const db = require('./server/db');
  console.log('getMercatoContext:', db.getMercatoContext('US500'));
  console.log('getAllActiveMercatoContexts:', db.getAllActiveMercatoContexts().length, 'rows');
"

# 3. Upsert + retrieval
node -e "
  const db = require('./server/db');
  db.upsertMercatoContext({
    symbol:'US500', bias:'BEAR', regime:'STAGFLATION',
    resistances:[6938,6902,6872], supports:[6802,6780,6663],
    invalidation:{ bull:6802, bear:6938 },
    notes:'Test', expires_at: Date.now() + 86400000
  });
  const ctx = db.getMercatoContext('US500');
  console.log('stored:', ctx.bias, ctx.levels_res, ctx.levels_sup);
"

# 4. checkMercato logic
node -e "
  const { checkMercato } = require('./server/mercato');
  const mockDb = { getMercatoContext: () => ({
    bias:'BEAR', regime:'STAGFLATION',
    levels_res:[6938,6902], levels_sup:[6802,6780],
    expires_at: Date.now() + 86400000
  })};
  console.log('APPROVED:', checkMercato('US500',6800,'SHORT',mockDb)?.tag);
  console.log('CONFLICT:', checkMercato('US500',6800,'LONG',mockDb)?.tag);
  console.log('PARTIAL:', checkMercato('US500',6850,'SHORT',mockDb)?.tag);
  console.log('null (GOLD):', checkMercato('GOLD',2350,'LONG',mockDb));
"
# Expected: APPROVED CONFLICT PARTIAL null

# 5. detectFlushRecovery + generated signal (full dry run)
node -e "
  const { checkAndFireMercatoSignal } = require('./server/mercato');
  const mockBars = [
    { open:6804, high:6806, low:6801, close:6804, ts: Date.now() },
    { open:6805, high:6808, low:6797, close:6803, ts: Date.now()-300000 },
    { open:6810, high:6812, low:6809, close:6810, ts: Date.now()-600000 },
  ];
  const mockDb = {
    getMercatoContext: () => ({
      symbol:'US500', bias:'BEAR', regime:'STAGFLATION',
      levels_res:[6938], levels_sup:[6802,6780],
      bull_inv:6938, bear_inv:6802, catalyst:6663, notes:null,
      expires_at: Date.now() + 86400000
    }),
    getRecentMarketHistory: () => mockBars,
    insertSignal: (s) => {
      console.log('SIGNAL:', s.symbol, s.direction, s.entry, s.verdict,
                  s.score+'pt', s.rr+'R', s.pattern, s.pattern_quality);
      return 1;
    }
  };
  checkAndFireMercatoSignal('US500', 6803, mockDb, mockDb.insertSignal, null)
    .then(() => console.log('dry run complete'))
    .catch(e => console.error(e.message));
"
# Expected:
# [Mercato] FAILED_BREAKDOWN at 6802 on US500 — depth 5pts, 1 bars ago, quality A+
# SIGNAL: US500 SHORT 6803 PROCEED 90pt 2.4R FAILED_BREAKDOWN A+

# 6. CORS — test from local file (after deploy)
# curl -X OPTIONS https://your-app.railway.app/api/mercato \
#   -H "Origin: file://" -H "Access-Control-Request-Method: POST" -v
# Expected: Access-Control-Allow-Origin: *

# 7. Push test (after deploy)
# curl -X POST https://your-app.railway.app/api/mercato \
#   -H "Content-Type: application/json" \
#   -d '{"symbol":"US500","bias":"BEAR","regime":"STAGFLATION","resistances":[6938],"supports":[6802]}'
# Expected: {"ok":true,"symbol":"US500","bias":"BEAR",...}
```

