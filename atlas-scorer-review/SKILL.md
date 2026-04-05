---
name: atlas-scorer-review
description: Review changes to the ATLAS WATCHLIST scoring system for correctness and CLAUDE.md compliance. Use this skill EVERY TIME you modify server/scorer.js, server/db.js insertSignal/addRecommendation, server/index.js webhook handlers, or server/outcome.js. Also use when committing any server-side changes to verify nothing breaks. This catches the bugs that have historically caused silent scoring errors, webhook failures, and data loss in this codebase.
---

# ATLAS Scorer Review Checklist

Run this checklist after making changes to the scoring system, webhooks, or database layer. These checks are derived from 4 rounds of code review that found 24+ bugs — every item on this list caught a real production issue.

## When to Run

After modifying ANY of these files:
- `server/scorer.js` — scoring logic, multipliers, verdicts
- `server/db.js` — signal storage, recommendations, migrations
- `server/index.js` — webhook handlers, API endpoints, startup
- `server/outcome.js` — signal lifecycle, recommendations
- `server/forexCalendar.js` — event detection, sentiment

## The Checklist

### 1. SCORER_VERSION Bump

If scoring logic changed (multipliers, gates, caps, verdicts, new penalties), SCORER_VERSION must be bumped.

**How to check:**
```bash
grep "SCORER_VERSION" server/scorer.js
```
Format: `YYYYMMDD.N` (e.g., `20260403.10`). If you changed how scores are calculated but didn't bump this, old signals won't be expired on deploy and the dashboard will mix old and new scoring logic.

### 2. Webhook Body Parser Integrity (Rule #14)

The webhook body parser MUST be the custom stream-based reader that sanitizes NaN/Infinity before JSON.parse. TradingView sends `NaN` literals which are invalid JSON.

**What to look for:**
```bash
grep -n "express.json\|bodyParser.json" server/index.js
```
If this returns results, the webhook is broken. The correct parser looks like:
```js
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', () => {
    // sanitize NaN BEFORE parse
    req.body = JSON.parse(sanitized);
    next();
  });
});
```
`express.json()` will silently set `req.body = {}` on NaN payloads, causing all webhook data to be lost.

### 3. Webhook Immediate Response (Rule #10)

`res.status(200).json({ok:true})` must be the first statement in webhook route handlers, before any processing.

**What to look for:**
```bash
grep -A3 "app.post.*webhook/pine" server/index.js
```
The response must fire before DB writes, scoring, or any async work. TradingView times out after 3 seconds.

### 4. structureCap Enforcement

After ALL post-score multipliers (opportunity, consensus, forecast), `macroAdjustedScore` must be re-capped to `structureCap`. Without this, weak-structure signals can score above their tier ceiling.

**What to check:** Look for the re-cap line:
```js
macroAdjustedScore = Math.min(structureCap, Math.min(95, Math.max(0, macroAdjustedScore)));
```
This must appear AFTER all multipliers that modify `macroAdjustedScore` and BEFORE the verdict calculation. The only exception is the LARGE event cap lift which raises `structureCap` itself.

### 5. conflictMultiplier Single Consumption

`conflictMultiplier` must be consumed exactly ONCE in the score calculation:
```js
const score = Math.round(cappedRaw * conflictMultiplier);
```
Any code that modifies `conflictMultiplier` AFTER this line has zero effect — it's a dead multiplier. Post-score adjustments must modify `macroAdjustedScore` instead.

**How to check:**
```bash
grep -n "conflictMultiplier" server/scorer.js | tail -5
```
The last modification must be before the consumption line. If you see modifications after `const score = Math.round(cappedRaw * conflictMultiplier)`, those are bugs.

### 6. Variable Declaration Before Use

JavaScript `const` and `let` have no hoisting. Using them before declaration causes ReferenceError.

**Known historical bugs:**
- `eventRiskNote` used before declaration (crashed R:R WATCH logic)
- `cardId` used before declaration in renderCard (crashed entire dashboard)
- `close` referenced as bare variable when `data.close` was intended

**What to check:** For any new variable introduced, verify its `const`/`let` declaration appears BEFORE its first use in the same scope.

### 7. DB Function Exports

Every `db.functionName()` call must reference a function that exists in `db.js` `module.exports`.

**Known historical bugs:**
- `db.all()` — not exported (use `db.getAllSignals()`, `db.getAllEconomicEvents()`, etc.)
- `db.get()` — not exported (use specific getters like `db.getLatestOpenSignal()`)
- `db.query()` — doesn't exist

**How to check:**
```bash
grep "module.exports" server/db.js
```
Cross-reference any new `db.xxx()` calls against this export list.

### 8. insertSignal Column Count

When adding columns to the signals table, ALL THREE of these must be updated:
1. `ALTER TABLE signals ADD COLUMN xxx` in `initSchema()` migrations
2. The INSERT statement in `insertSignal()` — column list AND values list
3. The `?` placeholder count must match the column count

**How to check:** Count the columns in the INSERT and the `?` placeholders — they must be equal.

### 9. Late-Stage Reasoning Notes

`buildReasoning()` is called early in `scoreSymbol()`. Any `macroNote` additions after that call (momentum gate, post-event, forecast bias, bank holiday) must be appended to `finalReasoning` via the `_macroNoteSnapshot` mechanism. Otherwise the user sees modified scores without explanation.

### 10. Recommendation Dedup

New recommendations must pass through `addRecommendation()` in db.js which handles deduplication. Never push recs directly to the array — always use the DB function which checks the 6h window, urgency escalation, and MOVE_SL target matching.

### 11. Market Hours Bank Holiday

`isBankHoliday()` is checked FIRST in `isMarketOpen()`. If you modify bank holiday lists, remember:
- Forex pairs trade 24/5 — only list indices and commodities
- Exception: Easter Monday includes GBP/EUR forex pairs (thin liquidity)

### 12. CLAUDE.md Update (Rule #13)

Every session that makes code changes must update CLAUDE.md before closing. Check:
- SCORER_VERSION matches code
- New API endpoints documented
- New DB tables/columns documented
- Changelog entry for the version bump

## Quick Verification Commands

Run these after any scorer change:

```bash
# Check SCORER_VERSION is current
grep "SCORER_VERSION" server/scorer.js

# Verify no express.json in middleware
grep -c "express.json" server/index.js  # should be 0

# Check structureCap re-cap exists
grep -n "Math.min(structureCap" server/scorer.js

# Verify conflictMultiplier consumption
grep -n "conflictMultiplier" server/scorer.js | tail -3

# Check insertSignal column count
grep "INSERT INTO signals" server/db.js | head -1

# Verify db.js exports match usage
grep "module.exports" server/db.js
```
