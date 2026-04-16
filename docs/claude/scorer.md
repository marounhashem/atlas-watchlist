# Scorer

## Current scorer version

`SCORER_VERSION = '20260416.1'`

Changes since 20260401.15:
- **20260416.1** — Structure gate guard: `hasMultiTfStructure` flag added. Dynamic minScore floor and lower-TF force-WATCH gate now only apply when Pine sent real multi-TF structure data (raw_payload.structure present). When absent (old Atlas Pine), bias (-3..+3) is used as structure proxy: bias±3=2.0, ±2=1.5, ±1=1.0 weighted struct. Prevents ATLAS Scorer silence when running with atlas_watchlist.pine which sends no multi-TF structure. ABC: cross-symbol burst gate (Class B/C blocked when >=3 OPEN/ACTIVE), conditional market_data upsert for price tracking, stale OB gate data.close fallback, preBosSwing wrong-side guard.
- **20260415.1** — Macro context TTL tightened from 26h to 12h + pre-analyzed inject path. Scorer's macro freshness gate in `scorer.js` now rejects entries older than 12h (both the `macroContextAvailable` flag and the conflict/confirm multiplier block). New `*/15 * * * *` cron in `server/index.js` deletes any `macro_context` row with `ts < now - 12h`, drops the symbol from the in-memory `macroContext` map, and broadcasts `MACRO_DELETED` so dashboards refresh instantly. New `POST /api/macro-inject` endpoint accepts pre-analyzed per-symbol macro context `{symbol, sentiment, strength, summary, key_risks, supports_long, supports_short}` and writes straight to `macro_context` + in-memory map + broadcasts `MACRO_UPDATE` — **bypasses Anthropic entirely**, so it is not subject to the Rule 16 `MACRO_ALLOWED_CALLERS` guard (it never calls the API). New `atlas_macro_inject.js` at repo root ships a 30-symbol payload that posts to this endpoint — intended to be driven by a daily scheduled Claude agent at 11:00 UAE (07:00 UTC). `avoid_until` is no longer used as a macro expiry mechanism; TTL handles expiry entirely.
- **20260414.1** — Bug fixes (7 confirmed bugs): (1) **Inverted thesis-stale expiry** — `abcManagement.js` was expiring OPEN signals when price moved *favourably* (5%+ above entry for LONG) instead of adversely; fixed direction of `awayPct` calculation. (2) **Session weight redistribution** — `scorer.js` was hardcoding `pine=0.50/fxssi=0.50` whenever FXSSI data was present, overwriting all learner-adjusted weights; now redistributes session weight proportionally to preserve the learned pine:fxssi ratio. (3) **Wrong RR message** — user-visible "below 2.0" message corrected to "below 2.5" to match `MIN_RR_PROCEED = 2.5`. (4) **Post-event gate mislabelled** — `abcGates.js` logged post-event volatility blocks as `gate: 'PREEVENT'` corrupting skip stats; fixed to `'POSTEVENT'`. (5) **Gravity staleness gate never firing** — `abcGates.js` checked `fxssiData.fetchedAt` which was never populated; `abcProcessor.js` now passes `fetchedAt: md.fxssi_fetched_at` so the 45-min staleness bypass works. (6) **`/api/signal-ignore` wrong outcome** — was setting `outcome='EXPIRED'` (same as natural expiry); now correctly sets `outcome='IGNORED'` consistent with the ABC system. (7) **Class C tp fallback** — `abcManagement.js` outcome loop used `sig.tp2 || sig.tp1` for Class C signals; falls back to `sig.tp` as final guard to prevent null-TP early-exit on pre-fix rows.
- **20260413.2** — Macro context surfaced in Intel tab + cascade delete. New `📊 MACRO CONTEXT` section under the existing intel list shows one card per symbol with sentiment badge (BULLISH green / BEARISH red / NEUTRAL amber), 1-10 strength bar, summary text, injection date (`d MMM YYYY`), and a × delete button. Dates older than 48h render in amber with a `⚠️` prefix. New `DELETE /api/macro-context/:symbol` deletes from `macro_context` table AND clears the in-memory `macroContext[symbol]` map so the scorer's next pass has nothing to read; broadcasts `MACRO_DELETED` so all open browser tabs refresh instantly. Scorer adds an explicit `[Scorer] {sym} — no macro context, skipping macro multiplier` log when the in-memory entry is missing — the existing 26h freshness gate already prevented stale macro from applying any multiplier, so this only formalizes the no-data case.
- **20260413.1** — Six fixes batch: (1) ABC dedup now uses direct DB query — last 2h same symbol+direction, excludes WIN/LOSS/EXPIRED/ARCHIVED/IGNORED outcomes (was 30min in-memory scan of 200 rows). (2) `insertAbcSignal` already has tp1/tp2/tp3 columns; abcProcessor.js now passes them in the call object so they persist. (3) New `POST /api/abc-archive-old` flips `outcome='ARCHIVED'` on any `abc_signals`/`class_c_signals` row whose `abc_version` is null or != `20260409.1`. Client `renderAbcSignals` already filters ARCHIVED. (4) Gate skip tracking now parses `gates.reason` as a fallback when `gates.gate` is missing — covers GRAVITY/CROWD/RR/BANKHOLIDAY/PREEVENT/MINSL/OTHER. (5) FXSSI watchdog cron — every 15min, counts symbols whose `market_data.fxssi_fetched_at` is >60min stale, forces `runFXSSIScrape()` if >10 are stale. New `GET /api/fxssi-force` endpoint. (6) Macro staleness watchdog cron — every 6h, calls `runMacroContextFetch(broadcast, 'cron_macro_watchdog')` if `getMacroContextAge() > 48h`. New caller added to `MACRO_ALLOWED_CALLERS` — supersedes Rule 16 for the 48h staleness path only; on-demand `/api/macro-force` and `/api/macro-refresh` still the only other Anthropic-billable callers.
- **20260410.4** — Intel upsert: DELETE existing active intel for symbol before inserting fresh pre_analyzed push (prevents stale card stacking). Mercato Flow 3 scanner wired into scorer.js main loop: `checkAndFireMercatoSignal()` fires standalone PROCEED signal + Telegram when price touches published level + pattern confirmed (FAILED_BREAKDOWN / FAILED_BREAKOUT / BREAKOUT_RETEST). MERCATO badge removed from dashboard header (client/index.html). Intel card renderer uses ASCII section markers (`[SYMBOL | BIAS | REGIME]`, `NOTES:`, `=== KEY LEVELS ===`, `[RES]`, `[SUP]`, `[BULL INV]`, `[BEAR INV]`, `[CATALYST]`, `=== RISK EVENTS ===`, `- ` bullets) — emojis dropped because they corrupted in sql.js. `level_types TEXT` column added to `market_intel`. Pre-analyzed bypass stores `body.content` (full text) and writes `level_types`.
- **20260410.3** — `POST /api/market-intel` now accepts pre-analyzed payloads from the local macro tool: if `pre_analyzed === true` and `summary` is present, the handler skips the Haiku call, maps `{text, symbol, summary, direction, levels, urgency, ttl}` onto the existing `insertMarketIntel(content, symbol, analysis, expiryHours)` shape, broadcasts `INTEL_UPDATE`, and returns `{ok, id, symbol, source:'pre_analyzed'}`. `levels` is parsed from the incoming JSON string and re-stringified by `insertMarketIntel` into the existing `key_levels` column so scorer.js intel-level scoring continues to work unchanged. `ttl` is in ms; converted to hours for `expires_at`. Existing Haiku path below the bypass is untouched.
- **20260410.3** — Mercato context expanded to all 30 ATLAS symbols (was US500-only). New `db.getAllActiveMercatoContexts()`. `mercato.js`: `checkAndFireMercatoSignal(symbol, currentPrice, ...)` now takes symbol as first param; `buildMercatoSignal` uses `ctx.symbol` (no more hardcoding); `detectFlushRecovery(level, direction, symbol, db)` also takes symbol so pattern detection runs on the right symbol's market history; cooldown key scoped to `${symbol}_${direction}`. The 1-min scoring cron now loops `getAllActiveMercatoContexts()` and fires per symbol with a current `market_data.close`. New CORS middleware at top of the express stack (`GET/POST/OPTIONS`, any origin, Content-Type) so the local `file://` macro tool can push context via `POST /api/mercato`. Dashboard: `#mercato-badge` span next to the ABC tab, color-coded BULL/BEAR/NEUTRAL, updated via `MERCATO_UPDATE` WebSocket broadcast and initial `GET /api/mercato?symbol=US500` fetch on page load.
- **20260410.2** — Mercato context system (Silvia Vianello US500 analysis, 3 flows). Flow 1 (scorer.js) + Flow 2 (abcProcessor.js): `checkMercato()` with ±3pt level tolerance — APPROVED ×1.12, CONFLICT ×0.85, PARTIAL ×1.0. Applied AFTER all other multipliers in scorer.js, respects structureCap. Both flows append MERCATO note to reasoning. Flow 3 (generated signals): `checkAndFireMercatoSignal()` runs at end of every 1-min scoring cron — fires a standalone PROCEED signal (score=90, session='MERCATO', 4h expiry) into the main `signals` table when US500 price hits one of Silvia's levels AND bias aligns AND `detectFlushRecovery()` finds a FAILED_BREAKDOWN/FAILED_BREAKOUT/BREAKOUT_RETEST pattern in the last 12 × 5min bars of `market_data_history`. No pattern → no signal (hard gate, Flow 3 only). 30-min cooldown per direction. SL from `bull_inv`/`bear_inv`, TP from catalyst or next S/R. Telegram: special `📡 MERCATO GENERATED SIGNAL` format routed via session check in `sendSignalAlert`. New table `mercato_context`, new `POST /api/mercato` + `GET /api/mercato`, new `server/mercato.js`, new `db.getRecentMarketHistory()`. WebSocket broadcast `MERCATO_UPDATE` on context upsert. Rules 1 + 6 preserved (no auto-execution; scorer flows 1+2 never block).
- **20260410.1** — Lower TF only hard gate: signals with `absWeightedStruct < 1.5` (1m/5m/15m alignment only, no 1H+) are forced to WATCH even if score meets PROCEED threshold. Filters 8/11 recent losses while preserving all wins. ABC fixes: cooldown widened from 20→200 signal scan with ARCHIVED/IGNORED exclusion, new ACTIVE guard blocks duplicate signals when one is already ACTIVE for same symbol+direction, noOrderBook routing moved below level calculation so Class C noOrderBook signals save real entry/sl/tp1/tp2/tp3 instead of zeros. New `POST /api/reset-abc` endpoint clears `abc_signals`, `class_c_signals`, `abc_skips`, `abc_rec_sent`.
- **20260409.2** — ABC REBUILD Phase 2: `atlas_daily_bias.pine` (daily EMA200+Ichimoku bias indicator, webhook to `/webhook/pine-daily-bias`). `atlas_abc_live.pine` (live indicator — structural payload: obTop/obBot/preBosSwing/swing1/swing2/atr/rsi + condition flags, no strategy calls, no request.security). Structural entry/SL/TP in abcProcessor (entry=OB midpoint, SL=preBosSwing-ATR*0.25, TP2=swing1, TP3=swing2, with old payload fallbacks). Telegram TP1/TP2/TP3 layout. Dashboard: 4-category breakdown bars (Structure/Confluence/Momentum/Crowd), Observations tab for Class C, crowd sentiment language throughout. API version filtering (`?version=` on /api/abc-signals), stats crowd_gate rename.
- **20260409.1** — ABC REBUILD Phase 1: File restructuring — `abcProcessor.js` (processAbcWebhook + ABC_VERSION + getAbcDp), `abcReasoning.js` (buildAbcScore/Breakdown/Reasoning), `abcManagement.js` (checkAbcOutcomes + 7 recommendation types + rsiHistory + Class C tracking). New DB tables: `abc_rec_sent` (rec dedup), `daily_bias` (replaces request.security), `class_c_signals` (observation). New abc_signals columns: abc_version, ob_top, ob_bot, pre_bos_swing, rsi_at_entry, trail_sl_sent, breakdown, crowd_gate. Condition-based scoring (0-95 scale) replaces hardcoded 88/75/62. 4-category breakdown (structure/confluence/momentum/crowd). abcGates language cleanup (no FXSSI/trapped in user strings). Class C routes to separate table. Daily bias webhook `/webhook/pine-daily-bias`. DB-persisted rec dedup replaces in-memory sentRecs.
- **20260408.1** — ABC ACTIVE tracking: `checkAbcOutcomes()` runs every minute — entry touch (OPEN→ACTIVE), SL/TP hit detection (→WIN/LOSS), MFE tracking, progress bar (% toward TP), PARTIAL_CLOSE recommendation at TP1 (1:1 RR). New columns: mfe_price, progress_pct, tp1/tp2/tp3, active_ts, partial_closed. `claudeLearner.onOutcome` removed (post-trade API calls disabled). 07:00 UTC macro cron removed — macro fetch now manual via `/api/macro-refresh` only. FXSSI cacheAge fix (Date.now() per symbol, not stale captured timestamp).
- **20260407.3** — ABC parallel system: `abcGates.js` gate engine, `/webhook/pine-abc`, `abc_signals` table, three-state verdict mapping (pass/fail/noData), swing Telegram routing for A+B, ⭐ ABC dashboard tab with class filters, outcome tracking (WIN/LOSS/IGNORE), stats by class/FXSSI/session/symbol, level rounding by asset class, min SL distance gate.
- **20260407.2** — SCORING SIMPLIFICATION: removed COT, carry rate, CB consensus, forecast bias, Nikkei-JPY, macro superseded decay, cluster proximity, DXY, long% crowd, absorption multipliers. Kept: macro conflict (×0.70/×0.78/×0.88), intel key levels, pre-event/post-event, FXSSI stale, bank holiday. Weights rebalanced: pine=0.50, fxssi=0.50, session=0.00 for forex (session kept for noOB indices). Multiplier floor raised from 0.65 to 0.70.
- **20260407.1** — Raised MIN_RR_PROCEED from 2.0 to 2.5, rrMax 4.0→5.0, ATR TP fallback 3.0→4.0. Trapped trader hard gate (buyersInProfitPct/sellersInProfitPct <35% blocks). Gravity proximity hard gate (entry within 0.3% of gravity blocks).
- **20260406.1** — Telegram sendMessage retries (2 retries with 2s/4s backoff on fetch failure), morning brief splits >4000 chars on section boundaries with hard-split fallback for oversized sections, market_data_history snapshot offset to :03/:08/:13/… (was :00/:05/:10/… colliding with FXSSI at :01), DXY webhook handles object bias `{score,bull,bear}` from Pine (extracts .score), getClosedReason now symbol-aware (checks actual weeklyOpen config per symbol), Easter Monday removed from bank holidays (all symbols open), isBankHoliday diagnostic log, minutesUntilOpen removed from /api/market-status (just open/closed), WebSocket connects first on page load (before HTTP fetches), secondary API calls deferred 500ms
- **20260403.10** — market_data_history (14-day retention, every 5min, no blob storage), BACKTEST tab, auto-recover corrupted DB from backup on startup (PRAGMA integrity_check), correct market hours (forex 22:00, commodities 23:00, EU/Asia indices Monday), db-cleanup.js runs before server with 4GB heap for bloated DB recovery, ALL automatic signal deletion on startup REMOVED (expireOldVersionSignals disabled, cleanup queries removed — signals expire naturally via expires_at)
- **20260403.9** — TP1/TP2/TP3 multi-level targets (1:1, full, stretch +50%), trade journal table with auto-snapshot on every outcome, MTF bias tab (6TF direction for 29 symbols), STATS tab (win rate, MFE capture, session/loss breakdowns), 29-symbol score heatmap, correlation risk panel (shared currency exposure warnings), ACTIVE as default tab
- **20260403.7** — CRITICAL: structureCap enforcement corrected — re-cap uses `Math.min(structureCap, ...)` not `Math.min(95, ...)`. LARGE event lift raises structureCap itself (+5) before re-cap. SL proximity 50% LOW tier removed (noise on healthy trades). Taxonomy backfill removed from startup (was corrupting analytics).
- **20260403.6** — Structure cap bypass fixed (re-cap after all multipliers). Lost reasoning notes fixed (macroNote snapshot). Dead intermediate verdict removed.
- **20260403.5** — Quality tier A/B/C (positive vs negative gate count), post-event LARGE cap lift (+5 when beat+trend agree), score trace field (Raw→Cap→Mult→Regime→Post), COT re-enabled with age decay (full <48h, 75% 2-4d, 50% 4-6d, 20% >6d)
- **20260403.4** — conflictMultiplier floor 0.65, momentum <25% force WATCH gate, macro event-superseded decay (HIGH event after macro → max staleness), DXY direct USD pairs ×1.07/×0.92 (crosses ×1.03/×0.97)
- **20260403.3** — CRITICAL: NFP Telegram alert fixed — three simultaneous bugs prevented ANY event alerts from ever firing: (1) fired detection used Eastern not UTC timestamp (4h offset), (2) actual field never stored in DB upsert (silently dropped), (3) sentiment used forecast as actual fallback (always beat=0). Added retry mechanism for delayed actuals. Note: no event alerts fired since system launch.
- **20260403.2** — OPPORTUNITY scoring finally works end-to-end (currency was missing from getPostEventState() return, ×1.10/×0.90 never fired). Opposite-signal expiry filtered to outcome='OPEN' only (previously could auto-expire ACTIVE live trades). WATCH paper tracking removed (queried wrong table). Accurate DST detection using actual US transition rules. All FairEconomy feeds confirmed Eastern timezone.
- **20260403.1** — Fix dead multipliers (post-event OPPORTUNITY + forecast bias applied after score consumed), FXSSI scoring order bug (70% branch unreachable), session exhaustion used undefined `close`, eventRiskNote used before declaration, pre-event suppression over-applied to unrelated symbols, US500 hours aligned

Changes since 20260401.7:
- **20260401.15** — Forecast-based pre-release scoring (getForecastBias), three-stage event sentiment (beat/miss + trend context)
- **20260401.14** — Zero SL hard gate + enforceMinSL with forex 5dp rounding, DB cleanup of zero-SL signals
- **20260401.13** — Intel key levels in macro fetch queries
- **20260401.12** — JPY pip calc, Kelly cap for insufficient data, zero SL guard, WATCH reason badge
- **20260401.8–11** — Nikkei-JPY correlation, intel key levels scoring, symbol alias mapping, Haiku intel summarisation

## Weighted structure scoring

Timeframe weights: `1d=3.0, 4h=2.0, 1h=1.5, 15m=1.0, 5m=0.5, 1m=0.5` (max ±8.5)

Structure cap tiers:

| Weighted score | Score cap | Description |
|---------------|-----------|-------------|
| >= 7.0 | 95 | Daily confirmed — maximum conviction |
| >= 5.0 | 93 | Swing confirmed (4h aligned) |
| >= 3.5 | 89 | 1h confirmed |
| >= 2.0 | 84 | Lower TF with some 15m |
| >= 1.0 | 78 | Lower TF only |
| < 1.0 | 68 | Minimal alignment |

Dynamic minScore floor:

| Condition | minScore raised to |
|-----------|-------------------|
| weightedStruct < 2.0 | 85 |
| weightedStruct < 3.5 | 82 |
| weightedStruct < 5.0 | 80 |
| noOrderBook + < 5.0 | +3 additive |

## Scoring penalty stack (cumulative) — simplified 20260407.2

| Gate | Condition | Effect |
|------|-----------|--------|
| Macro conflict | Strength 8-10 against | ×0.70 |
| Macro conflict | Strength 6-7 against | ×0.78 |
| Macro conflict | Strength 4-5 against | ×0.88 |
| Event sentiment | Beat confirms + trend confirms | ×1.10–1.20 (+5% trend bonus) |
| Event sentiment | Miss contradicts direction | ×0.85–0.95 |
| noOrderBook | No FXSSI data | ×0.92 |
| Pre-event | HIGH impact within 10min | ×0.75 + cap WATCH |
| Post-event VOLATILITY | 0-5min after fire | Hard block (null) |
| Post-event OPPORTUNITY | 5-120min after fire | ×1.10 confirms / ×0.90 against |
| Intel key levels | Price at resistance vs LONG | ×0.80 |
| Intel key levels | Price at support confirms LONG | ×1.08 |
| Intel approaching | Price approaching key level | ×0.92 |
| Bank holiday | Symbol affected by bank holiday | session ×0.5 + force WATCH |
| Momentum <15% | momScore critically weak | ×0.88 + force WATCH |
| Momentum <25% | momScore weak | force WATCH |
| Lower TF only | absWeightedStruct < 1.5 | force WATCH |
| Mercato APPROVED | Any symbol w/ active context, ±3pt level match + bias aligned | ×1.12 |
| Mercato CONFLICT | Any symbol w/ active context, direction opposes daily bias | ×0.85 |
| Multiplier floor | All penalties combined | min 0.70 |

### Hard gates (return null — no signal)

| Gate | Condition |
|------|-----------|
| Trapped trader | LONG + buyersInProfitPct <35% |
| Trapped trader | SHORT + sellersInProfitPct <35% |
| Gravity proximity | Entry within 0.3% of gravity price |
| RR kill | R:R < 1.5 |
| RSI extreme | LONG + RSI < 40, SHORT + RSI > 75 |

### Removed multipliers (20260407.2)

COT positioning, carry rate, CB consensus, forecast bias, Nikkei-JPY correlation, macro superseded decay, cluster proximity, DXY confirms/conflicts, long% crowd positioning, absorption scoring.

## Minimum SL enforcement

`enforceMinSL()` runs after price rounding, before signal return:

| Asset class | Min SL distance | Rounding |
|-------------|----------------|----------|
| forex | 0.20% of entry | 5 decimal places |
| index | 0.30% of entry | 2 decimal places |
| commodity | 0.50% of entry | 2 decimal places |
| crypto | 0.80% of entry | 2 decimal places |

Nuclear fallback: if `abs(sl - entry) < 0.00001` after enforcement, signal is blocked.
On startup: auto-expire any OPEN/ACTIVE signals with zero SL distance.

## Three-stage event scoring

1. **Stage 1 — Forecast bias (pre-release):** `getForecastBias()` uses forecast vs previous to generate directional bias before event fires. Applies multiplier when >10min from event.
2. **Stage 2 — Beat/miss (at release):** `calculateEventSentiment()` computes actual vs forecast with commodity-aware rules.
3. **Stage 3 — Trend context:** actual vs previous — NFP, CPI, unemployment, GDP, earnings pattern-matched. Combined strength upgrades when beat+trend agree, downgrades when they conflict.

## Loss taxonomy

Auto-categorised on every WIN/LOSS:

**Loss categories:** EVENT_RISK, IGNORED_RECS, MOMENTUM_FAILURE, WEAK_STRUCTURE, COUNTER_TREND, NO_MACRO_CONTEXT, OFF_HOURS, NO_OB_DATA, MFE_CAPTURE_FAILURE, UNKNOWN

**Win categories:** STRONG_STRUCTURE, MACRO_ALIGNED, COT_CONTRARIAN, PEAK_SESSION, TECHNICAL

`GET /api/taxonomy` returns aggregated counts + auto-generated insight for the most common loss category.

## CFD position sizing

**Fixed fractional:** `lots = riskAmount / (slDistance × pipValue)` for forex, `units = riskAmount / slDistance` for others

**Kelly criterion:** `f = ((winRate × avgRR) - (1-winRate)) / avgRR × kellyFraction`
- Auto mode: calculated from ≥10 closed signals
- Manual mode: user inputs win rate + avg R:R
- Default fraction: 25% of full Kelly

**CFD lot sizes (configurable):** Gold=100oz, Silver=5000oz, Oil=1000bbls, Copper=25000lbs, Platinum=50oz, Forex=100k units

**Portal only — never included in Telegram messages.** Shown in ANALYSE panel only.

## Pine Script backtest strategies

| File | Approach | Chart TF | Key Features |
|------|----------|----------|-------------|
| `atlas_backtest.pine` | EMA + bias score + structure | Any | Optimizable inputs, structure fallback in dead zone, bias bypass for structGate |
| `atlas_smc_backtest.pine` | Smart Money Concepts | Any | BOS + Order Blocks + Ichimoku cloud filter, swing pivots |
| `atlas_mtf_backtest.pine` | MTF confluence (daily/4h/1h) | 10m | Pullback from 4H extreme + rejection candle, no indicators except ATR |
| `atlas_combined_backtest.pine` | Combined SMC + MTF + RSI div + volume | 1m | Three-class system (A/B/C), 10-layer confluence, request.security for daily/4H |
| `atlas_daily_bias.pine` | Daily EMA200 + Ichimoku cloud | Daily | Fires bias (BULL/BEAR/MIXED) to `/webhook/pine-daily-bias` on bar close |
| `atlas_abc_live.pine` | Live SMC indicator | Any | Structural payload (obTop/obBot/preBosSwing/swing1/swing2), no strategy, no request.security |

### Combined strategy class system

| Class | Requirements | Score | SL Placement |
|-------|-------------|-------|-------------|
| A | Tier1 + all 3 strong filters + 1+ bonus | 88 | Order Block |
| B | Tier1 + 2+ strong filters | 75 | Swing level |
| C | Tier1 + 1 strong filter | 62 | ATR × 1.5 |

Tier 1 (mandatory): daily bias + BOS direction + rejection candle
Tier 2 (0-3): cloud + order block + pullback
Bonus (0-2): RSI divergence + volume

## ABC parallel signal system

**File structure (Phase 1 rebuild):**
- `server/abcProcessor.js` — processAbcWebhook, ABC_VERSION, getAbcDp, processDailyBiasWebhook
- `server/abcReasoning.js` — buildAbcScore, buildAbcBreakdown, buildAbcReasoning
- `server/abcManagement.js` — checkAbcOutcomes, rsiHistory, 7 recommendation types, Class C tracking
- `server/abcGates.js` — runAbcGates, mapVerdict, checkFxssi (crowd sentiment language)

**Flow:** `/webhook/pine-abc` → `abcProcessor.processAbcWebhook()` → Class C → `class_c_signals` | Class A/B → `abcGates.runAbcGates()` → `abc_signals`

**Scoring:** `buildAbcScore()` (0-95 scale, condition-based) replaces hardcoded 88/75/62
**Breakdown:** 4 categories — Structure (33), Confluence (30), Momentum (17), Crowd (17)

**New tables:** `abc_rec_sent` (rec dedup), `daily_bias` (replaces request.security), `class_c_signals`
- Telegram: Class A+B → swing channel via `sendAbcSignalAlert()`
- Dashboard: ⭐ ABC tab with class filters (ALL/A/B/C)

### Verdict mapping (class × FXSSI × noData)

| Class | FXSSI Pass | FXSSI Fail | FXSSI No Data |
|-------|-----------|-----------|---------------|
| A | PROCEED | WATCH | WATCH |
| B | PROCEED | SKIP | WATCH |
| C | WATCH | SKIP | SKIP |

### Gates (checked in order)

1. Bank holiday → SKIP
2. Pre-event suppression → SKIP
3. Post-event volatility → SKIP
4. RR sanity (< 1.5) → SKIP
5. FXSSI trapped alignment (opposing side must be trapped)
6. Gravity proximity (blocks if gravity in 70% of TP path)
7. Class × FXSSI verdict mapping
8. Intel key levels (annotation only, no block)

### Cooldown + ACTIVE guard

- **ACTIVE guard:** if an ACTIVE signal exists for the same symbol+direction, new signals are rejected immediately (before cooldown check). Prevents duplicate entries while a trade is live.
- **Cooldown:** 30-minute window per symbol+direction. Scans last 200 signals from `abc_signals` and ignores `ARCHIVED`/`IGNORED` outcomes so archived rows don't poison the check.
- Both guards run after level calculation and RR gate, before FXSSI fetch, so noOrderBook symbols are also subject to them.

### ACTIVE tracking (`checkAbcOutcomes`, every minute)

- OPEN → ACTIVE: entry touch ±0.15% tolerance, saves TP1/TP2/TP3
- SL hit → LOSS: barLow ≤ SL (LONG) or barHigh ≥ SL (SHORT)
- TP hit → WIN: barHigh ≥ TP (LONG) or barLow ≤ TP (SHORT)
- MFE: max favorable excursion tracked per bar, stored as mfe_pct + mfe_price
- Progress: % toward TP, updated every minute
- PARTIAL_CLOSE: recommended at TP1 (1:1 RR), uses `partial_closed` INTEGER column
- WebSocket: ABC_OUTCOME (ACTIVE/WIN/LOSS), ABC_RECOMMENDATION (PARTIAL_CLOSE)

### API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/abc-signals | All ABC signals (200 limit) |
| POST | /api/abc-outcome | Log WIN/LOSS on ABC signal |
| POST | /api/abc-ignore | Mark signal as not taken |
| GET | /api/abc-stats | Analytics by class, FXSSI gate, session, symbol |
| POST | /api/reset-abc | Clear abc_signals, class_c_signals, abc_skips, abc_rec_sent |
| POST | /api/mercato | Upsert daily Mercato context (any of 30 symbols) — bias, levels, invalidation, catalyst |
| GET | /api/mercato | Current Mercato context — `?symbol=US500` (any supported symbol) |
