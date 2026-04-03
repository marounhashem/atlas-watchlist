# CLAUDE.md — ATLAS // WATCHLIST

## Project overview

ATLAS // WATCHLIST is an autonomous trading signal system. It ingests TradingView Pine Script alerts and FXSSI order book data, scores them through a multi-layer engine, and presents actionable PROCEED / WATCH / SKIP signals on a real-time dashboard. The system does **not** execute trades — it generates signals for a human trader to act on.

**Stack:** Node.js + Express, sql.js (in-memory SQLite persisted to disk), WebSocket for live updates, Anthropic Claude API for learning/regime detection, FXSSI API for order book sentiment, Telegram Bot API for alerts, Resend for health alert emails.

**Coverage:** 29 symbols + DXY reference:
- **Main group (22):** GOLD, SILVER, OILWTI, BTCUSD, ETHUSD, US30, US100, EURUSD, GBPUSD, USDJPY, USDCHF, USDCAD, AUDUSD, NZDUSD, EURJPY, EURGBP, EURAUD, EURCHF, GBPJPY, GBPCHF, AUDJPY
- **Global group (8):** US500, DE40, UK100, J225, HK50, CN50, COPPER, PLATINUM — `group:'global'`, `noOrderBook:true`
- **DXY:** reference signal only — stored in `dxy_reference` table, no scoring, no signals

## Current scorer version

`SCORER_VERSION = '20260403.3'`

Changes since 20260401.15 (three review rounds + NFP debug, 21 bugs fixed):
- **20260403.3** — CRITICAL: NFP Telegram alert fixed — three simultaneous bugs prevented ANY event alerts from ever firing: (1) fired detection used Eastern not UTC timestamp (4h offset), (2) actual field never stored in DB upsert (silently dropped), (3) sentiment used forecast as actual fallback (always beat=0). Added retry mechanism for delayed actuals. Note: no event alerts fired since system launch.
- **20260403.2** — OPPORTUNITY scoring finally works end-to-end (currency was missing from getPostEventState() return, ×1.10/×0.90 never fired). Opposite-signal expiry filtered to outcome='OPEN' only (previously could auto-expire ACTIVE live trades). WATCH paper tracking removed (queried wrong table). Accurate DST detection using actual US transition rules. All FairEconomy feeds confirmed Eastern timezone.
- **20260403.1** — Fix dead multipliers (post-event OPPORTUNITY + forecast bias applied after score consumed), FXSSI scoring order bug (70% branch unreachable), session exhaustion used undefined `close`, eventRiskNote used before declaration, pre-event suppression over-applied to unrelated symbols, US500 hours aligned

Changes since 20260401.7:
- **20260401.15** — Forecast-based pre-release scoring (getForecastBias), three-stage event sentiment (beat/miss + trend context)
- **20260401.14** — Zero SL hard gate + enforceMinSL with forex 5dp rounding, DB cleanup of zero-SL signals
- **20260401.13** — Intel key levels in macro fetch queries
- **20260401.12** — JPY pip calc, Kelly cap for insufficient data, zero SL guard, WATCH reason badge
- **20260401.8–11** — Nikkei-JPY correlation, intel key levels scoring, symbol alias mapping, Haiku intel summarisation

## Dashboard UI

- **Fonts:** Space Grotesk (body) + JetBrains Mono (monospace values)
- **Card layout:** 3-column body — levels (185px) | bars (130px) | reasoning (1fr)
- **Left accent bar:** 4px `::before` pseudo-element (green=PROCEED, amber=WATCH, blue=ACTIVE)
- **Level boxes:** vertical stack (Entry/Stop/Target), each row `grid: 40px 1fr`
- **Breakdown bars:** Technical, Sentiment, OB Levels, Session — color-coded hi/mid/lo
- **Reasoning:** always visible, 4-line clamp, expandable via "more" button, color-coded ✓/⚠ prefixes
- **Score:** large JetBrains Mono number, always white, no % symbol
- **Position sizing:** moved to ANALYSE panel (not shown on card)
- **Breakdown fallback:** when DB signals have null breakdown, bars show score-based estimates
- **noOB detection:** hardcoded `NO_OB_SYMBOLS` set + reasoning text fallback

## Database tables

| Table | Purpose |
|-------|---------|
| market_data | Latest OHLCV + Pine indicators + FXSSI analysis per symbol |
| signals | Live + retired trade signals with outcome tracking + breakdown JSON |
| weights | Scoring weights per symbol (learner-adjusted) |
| learning_log | Historical weight optimization cycles |
| watch_signals | Non-tradeable WATCH signals for pattern learning |
| settings | Key-value store for persistent state (30+ settings) |
| economic_events | Forex Factory HIGH impact events (5min poll, 4 feeds) |
| macro_context | Persisted macro sentiment per symbol (survives restarts) |
| cb_consensus | Market expectations for upcoming CB meetings |
| cot_data | Weekly CFTC institutional positioning per currency |
| rate_data | Central bank interest rates per currency |
| market_intel | Short-lived user-injected context (24h TTL) with Haiku analysis |
| dxy_reference | DXY reference data (never traded, used for correlation) |

### Key columns on signals table

| Column | Type | Purpose |
|--------|------|---------|
| weighted_struct_score | REAL | Weighted TF alignment score /8.5 |
| is_swing | INTEGER | 1 if meets swing criteria |
| expires_at | INTEGER | Expiry timestamp (asset-class based) |
| event_risk_tag | TEXT | PRE_EVENT / VOLATILITY / null |
| macro_context_available | INTEGER | 1 if macro data was fresh at scoring |
| outcome_category | TEXT | Loss/win taxonomy category |
| outcome_notes | TEXT | Auto-generated explanation |
| partial_closed | INTEGER | 1 if partial close was recommended |
| breakdown | TEXT | JSON `{bias, fxssi, ob, session}` scores for bar rendering |

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

## Scoring penalty stack (cumulative)

| Gate | Condition | Effect |
|------|-----------|--------|
| Macro conflict | Strength 8-10 against | ×0.70 |
| Macro conflict | Strength 6-7 against | ×0.78 |
| Macro conflict | Strength 4-5 against | ×0.88 |
| COT extreme | >100k crowded against | ×0.88 |
| COT extreme | >100k favours direction | ×1.05 |
| Carry fight | >500bps against | ×0.80 |
| Carry fight | >300bps against | ×0.88 |
| Carry with | >300bps with | ×1.05 |
| Forward guidance | CB consensus confirms | ×1.08 |
| Forward guidance | CB consensus contradicts | ×0.88 |
| Forecast bias | Pre-release confirms (strength 3) | ×1.12 |
| Forecast bias | Pre-release confirms (strength 2) | ×1.07 |
| Forecast bias | Pre-release contradicts | ×0.88–0.97 |
| Event sentiment | Beat confirms + trend confirms | ×1.10–1.20 (+5% trend bonus) |
| Event sentiment | Miss contradicts direction | ×0.85–0.95 |
| noOrderBook | No FXSSI data | ×0.92 |
| Pre-event | HIGH impact within 10min | ×0.75 + cap WATCH |
| Post-event VOLATILITY | 0-5min after fire | Hard block (null) |
| Post-event OPPORTUNITY | 5-120min after fire | ×1.10 confirms / ×0.90 against |
| FXSSI stale | OB data >25min old | ×0.82 |
| Gravity against | Gravity pulls against direction | ×0.88 |
| Cluster proximity | Losing cluster within 0.3% of entry | ×0.85 |
| Intel key levels | Price at resistance vs LONG | ×0.80 |
| Intel key levels | Price at support confirms LONG | ×1.08 |
| Intel approaching | Price approaching key level | ×0.92 |
| Bank holiday | Symbol affected by bank holiday | session ×0.5 + force WATCH |
| Nikkei-JPY | J225 bearish + JPY LONG | ×0.93 |

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

## Telegram alerts

- **Forecast appears:** sent when FF scrape detects new forecast on upcoming HIGH event
- **Event fired:** compact format — actual|forecast|prev on one line, directional arrows grouped by direction
- **Signal alert:** PROCEED signals pushed to spot channel
- **Swing alert:** pushed to swing channel when criteria met
- **Recommendations:** PARTIAL_CLOSE, TIME_STOP, MOVE_SL, CLOSE
- **Arrow format:** `🟢 USDJPY ↑  USDCHF ↑` / `🔴 EURUSD ↓  GBPUSD ↓` — single lines grouped by direction
- **Special cases:** GOLD, OIL, indices get context lines for USD events

## Architecture decisions

- **Webhook body parsing**: Uses custom stream-based parser NOT express.json(). TradingView Pine Script sends invalid JSON with NaN literals (e.g. `"bias":NaN`). express.json() silently fails on these, setting req.body to `{}`. The working parser sanitizes NaN before parsing: `body.replace(/:NaN/g, ':null')`. **NEVER replace this with express.json(). NEVER add content-type middleware that bypasses this parser.** This is why webhooks broke when express.json() was added — do not "fix" it again.

## Webhook architecture

- **Body parser:** Custom stream reader that sanitizes `NaN`/`Infinity` → `null` BEFORE `JSON.parse()`. **Do NOT replace with `express.json()`** — TradingView sends NaN literals which are invalid JSON and will silently fail.
- **Pattern:** `res.status(200).json({ok:true})` fires immediately, processing via `setImmediate()` + `processPineWebhook()`
- **TradingView timeout:** guaranteed <10ms response regardless of server load
- **Content-type:** TradingView sends `text/plain` — the stream parser handles all content types (no rewrite needed)
- **Auth:** Optional `WEBHOOK_SECRET` env var — if set, payload must include matching `secret` field. Clear the env var to disable.
- **WebSocket:** `noServer: true` mode with try/catch upgrade handler
- **Startup:** `server.listen()` first, DB init async in callback via setTimeout chains
- **Railway region:** `us-west1` (set in railway.toml) for lowest latency to TradingView servers

## Bank holiday awareness

`BANK_HOLIDAYS` map in `marketHours.js` with 2026 dates:
- Good Friday, Easter Monday, Labour Day, UK bank holidays, US Independence Day, Thanksgiving, Christmas, Boxing Day, New Year
- `isBankHoliday(symbol)` + `getBankHolidayName()` exported
- Scorer: session score halved, force WATCH, macroNote warning
- Card: 🏦 Bank Holiday tag in header

## Recommendation types

| Type | Trigger | Urgency | Telegram | Expiry |
|------|---------|---------|----------|--------|
| MOVE_SL | Progress milestone / gravity cluster | LOW-MEDIUM | At 80%+ progress | 6h |
| PARTIAL_CLOSE | 1:1 R:R achieved | MEDIUM | Always | Once per signal |
| CLOSE | RSI extreme / structure flip | HIGH | Always | 20min |
| TIME_STOP | Low MFE after hours | MEDIUM | Always | Once per signal |

Time stop thresholds (spot-focused): forex 4h/0.15%, index 3h/0.20%, commodity 6h/0.25%, crypto 8h/0.30%

## Swing signal criteria

Pushed to `TELEGRAM_SWING_BOT_TOKEN` channel when all met:
- `weightedStructScore >= 5.0` (4h+ confirmed)
- `score >= 82`
- `rr >= 2.0`
- `session !== 'offHours'`
- No `eventRiskTag`

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

## Event calendar architecture

- **4 feeds polled every 5 minutes:** FF (forex), EE (energy), MM (metals), CC (crypto)
- **Timezone:** FF dates in US Eastern converted to UTC via `easternToUTC()` on storage (EDT +4h, EST +5h)
- **Selective routing:** Indices only penalised for macro-moving events (NFP, CPI, FOMC, Trump). NOT penalised for Natural Gas, EIA, Crude Inventories, Unemployment Claims, Housing.
- **Pre-event:** 10-minute window, ×0.75 + cap WATCH
- **Post-event VOLATILITY:** 0-5min, hard block (null)
- **Post-event OPPORTUNITY:** 5-120min, ×1.10 confirms / ×0.90 contradicts
- **Three-stage sentiment:** forecast bias → beat/miss → trend context (see above)
- **Trump/Fed speech routing:** automatically affects all precious metals + all indices
- **Forecast alert:** Telegram alert when FF scrape detects new forecast on upcoming event

## Daily schedule (UTC)

| Time | Action |
|------|--------|
| 00:00 | Daily DB backup (3 rolling) |
| 05:00 | Morning brief → Telegram (includes forecast signals section) |
| :05 hourly | Market intel cleanup (expired) |
| :05 hourly | Mark past events as fired |
| 06:50 | Rate scrape (Trading Economics) |
| 07:00 | Macro context fetch (Claude web search + intel key levels) + CB consensus |
| Every min | Score all symbols → PROCEED signals → Telegram |
| Every min | Outcome check + PARTIAL_CLOSE + TIME_STOP + MOVE_SL |
| */5 min | Economic calendar poll (4 feeds) + fire detection + forecast alerts |
| :01/:21/:41 | FXSSI 20-min order book scrape |
| :02/:22/:42 | Signal retirement cycle |
| Hourly | Learning cycle (if thresholds met) |
| Friday 20:45 | COT weekly fetch (CFTC) |
| Every 30min | Health check → email + Telegram if degraded |

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/signals | Active/open signals (scores if DB empty) |
| GET | /api/past-signals | WIN/LOSS/EXPIRED signals |
| GET | /api/taxonomy | Loss/win category breakdown + insight |
| GET | /api/debug | Comprehensive 9-section health + quality report |
| POST | /api/trade-feedback | System analysis (no API call) |
| GET/POST | /api/market-intel | Active intel items / inject intel |
| DELETE | /api/market-intel/:id | Remove intel item |
| GET | /api/dxy-status | Latest DXY reference data |
| GET | /api/macro-context | All macro sentiment data |
| GET | /api/macro-debug | DB vs in-memory macro state |
| GET | /api/macro-force | Trigger macro fetch |
| GET | /api/calendar-status | Upcoming HIGH impact events (with debug timing) |
| GET | /api/calendar-force | Trigger immediate FF fetch |
| POST | /api/calendar-force-fired | Mark all past unfired events as fired |
| POST | /api/calendar-fix | Manual event time correction |
| GET | /api/settings | All settings with defaults |
| POST | /api/settings | Update single setting |
| POST | /api/settings/bulk | Update multiple settings |
| GET | /api/rate-status | Rates + pair differentials |
| GET | /api/cot-status | COT currencies + pair summaries |
| GET | /api/cb-calendar | CB meetings + consensus |
| GET | /api/health | System health per symbol (full DB scan) |
| GET | /health | Fast health check (no DB, <5ms) for Railway |
| GET | /api/db-status | DB file sizes + signal count |
| GET | /api/db-recover | Restore from .bak if needed |
| GET | /api/db-verify | Test persist protection |
| GET | /api/telegram-test | Send test message |
| GET | /api/morning-brief | Preview brief HTML |
| POST | /api/morning-brief-send | Send brief to Telegram |

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| ANTHROPIC_API_KEY | Yes | Claude API for learning, macro, consensus |
| FXSSI_TOKEN | Yes | FXSSI order book API |
| FXSSI_USER_ID | No | FXSSI user ID (default 118460) |
| TELEGRAM_BOT_TOKEN | No | Telegram Bot API token (spot channel) |
| TELEGRAM_CHAT_ID | No | Telegram chat ID for alerts |
| TELEGRAM_SWING_BOT_TOKEN | No | Swing channel bot token |
| TELEGRAM_SWING_CHAT_ID | No | Swing channel chat ID |
| RESEND_API_KEY | No | Resend email for health alerts |
| ALERT_EMAIL | No | Health alert email |
| WEBHOOK_SECRET | No | Body secret for webhook auth |
| DB_PATH | No | SQLite file path (default: ./data/atlas.db) |

## Startup sequence

1. Process started → module imports
2. Express + WS ready (noServer mode with try/catch upgrade)
3. Static files + `/health` endpoint (fast, no DB)
4. Crons registered
5. `server.listen()` — HTTP accepting connections
6. DB init (async in callback) → schema + migrations + zero-SL cleanup
7. Background tasks via setTimeout chain: FXSSI (2s), COT seed (5s), rates (8s), calendar (9s), macro from DB (10s)

## Rules

1. **Never auto-execute trades.** Signal-only system. No broker API, no order placement.
2. **Never wipe the database without explicit user confirmation.** `/api/reset-*` endpoints are emergencies only.
3. **Always bump `SCORER_VERSION`** when scoring logic changes. Format: `YYYYMMDD.N`.
4. **Never commit secrets.** API keys stay in environment variables only.
5. **Persist before returning.** Any DB write must call `persist()` before returning.
6. **Macro penalises, not blocks.** Multipliers ×0.70 to ×0.94. Only event risk caps verdict.
7. **Background tasks use Haiku only.** Sonnet only on explicit user-triggered analysis.
8. **Position sizing is portal-only.** Never include lot sizes or position sizes in Telegram messages.
9. **CLAUDE.md must be updated** with every scorer version bump and every new feature.
10. **Webhook responds immediately.** `res.status(200)` before any processing, `setImmediate()` for async work. **Never replace the stream body parser with `express.json()`** — TradingView sends NaN literals that break standard JSON parsing.
11. **Forex rounds to 5dp, others to 2dp.** Prevents SL enforcement from being destroyed by rounding.
12. **Eastern → UTC on storage.** FF calendar times converted via `easternToUTC()` before DB write.
13. **Update CLAUDE.md before closing.** Every session that makes code changes must end with CLAUDE.md updated to reflect all changes. Never close a session without confirming CLAUDE.md matches the actual codebase.
14. **Never replace the stream body parser with express.json().** Pine Script sends NaN literals which are invalid JSON. The stream parser with NaN sanitisation is intentional and must not be changed.
