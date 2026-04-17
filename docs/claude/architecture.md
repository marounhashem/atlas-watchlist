# Architecture

## Project overview

ATLAS // WATCHLIST is an autonomous trading signal system. It ingests TradingView Pine Script alerts and FXSSI order book data, scores them through a multi-layer engine, and presents actionable PROCEED / WATCH / SKIP signals on a real-time dashboard. The system does **not** execute trades — it generates signals for a human trader to act on.

**Stack:** Node.js + Express, sql.js (in-memory SQLite persisted to disk), WebSocket for live updates, Anthropic Claude API for learning/regime detection, FXSSI API for order book sentiment, Telegram Bot API for alerts, Resend for health alert emails.

**Coverage:** 29 symbols + DXY reference:
- **Main group (22):** GOLD, SILVER, OILWTI, BTCUSD, ETHUSD, US30, US100, EURUSD, GBPUSD, USDJPY, USDCHF, USDCAD, AUDUSD, NZDUSD, EURJPY, EURGBP, EURAUD, EURCHF, GBPJPY, GBPCHF, AUDJPY
- **Global group (8):** US500, DE40, UK100, J225, HK50, CN50, COPPER, PLATINUM — `group:'global'`, `noOrderBook:true`
- **DXY:** reference signal only — stored in `dxy_reference` table, no scoring, no signals

## Dashboard UI

- **Fonts:** Space Grotesk (body) + JetBrains Mono (monospace values)
- **Card layout:** 3-column body — levels (185px) | bars (130px) | reasoning (1fr)
- **Left accent bar:** 4px `::before` pseudo-element (green=PROCEED, amber=WATCH, blue=ACTIVE)
- **Level boxes:** vertical stack (Entry/Stop/Target), each row `grid: 40px 1fr`
- **Breakdown bars:** Technical, Sentiment, OB Levels, Session — color-coded hi/mid/lo
- **Reasoning:** always visible, 4-line clamp, expandable via "more" button, color-coded ✓/⚠ prefixes
- **Score:** large JetBrains Mono number, always white, no % symbol
- **Footer:** single row — left zone (recommendation), right zone (progress bar + MFE + Close/Ignore + ANALYSE + copy)
- **ACTIVE cards:** 44px progress bar toward TP, MFE label, Close button (force close at current price)
- **OPEN cards:** Ignore button (mark as not taken, excluded from win rate)
- **Position sizing:** moved to ANALYSE panel (not shown on card)
- **Breakdown fallback:** when DB signals have null breakdown, bars show score-based estimates
- **noOB detection:** hardcoded `NO_OB_SYMBOLS` set + reasoning text fallback
- **Load order:** WebSocket connects first (before HTTP fetches), skeleton cards shown immediately, signals+past-signals fetched in parallel, secondary data (stats, learning log, market status, regime) deferred 500ms

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
| trade_journal | Auto-generated signal snapshots on every WIN/LOSS/EXPIRED |
| market_data_history | Snapshots of market_data per symbol per scoring run (14-day retention) |
| fxssi_history | Historical FXSSI order book snapshots for backtesting (UNIQUE symbol+snapshot_time) |
| mercato_context | Daily macro context (all 30 symbols, one active row per symbol) — bias, regime, levels, invalidation, catalyst |

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
| quality | TEXT | A/B/C quality tier based on positive vs negative gate count |
| score_trace | TEXT | Score computation path: Raw→Cap→Mult→Regime→Post |
| tp1 | REAL | 1:1 R:R target (partial close level) |
| tp2 | REAL | Full target (same as tp) |
| tp3 | REAL | Stretch target (tp2 + 50% of SL distance) |

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
- Good Friday, Labour Day, UK bank holidays, US Independence Day, Thanksgiving, Christmas, Boxing Day, New Year
- Easter Monday removed — all symbols confirmed trading
- `isBankHoliday(symbol)` + `getBankHolidayName()` exported, diagnostic log on match
- `getClosedReason(symbol)` is symbol-aware — checks actual `weeklyOpen` config per symbol (not generic day-of-week), returns "Daily break", "Before weekly open", "Bank holiday", or "Weekend"
- Sunday 22:00+ UTC treated as trading week start (not "Weekend")
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

## Telegram alerts

- **Forecast appears:** sent when FF scrape detects new forecast on upcoming HIGH event
- **Event fired:** compact format — actual|forecast|prev on one line, directional arrows grouped by direction
- **Signal alert:** PROCEED signals pushed to spot channel
- **Swing alert:** pushed to swing channel when criteria met
- **Recommendations:** PARTIAL_CLOSE, TIME_STOP, MOVE_SL, CLOSE
- **Morning brief:** splits into multiple messages if >4000 chars (Telegram 4096 limit), hard-splits oversized sections on newlines
- **Retry:** `sendMessage` retries up to 2 times with backoff (2s, 4s) on fetch failure
- **Arrow format:** `🟢 USDJPY ↑  USDCHF ↑` / `🔴 EURUSD ↓  GBPUSD ↓` — single lines grouped by direction
- **Special cases:** GOLD, OIL, indices get context lines for USD events

## Event calendar architecture

- **4 feeds polled every 5 minutes:** FF (forex), EE (energy), MM (metals), CC (crypto)
- **Timezone:** FF dates in US Eastern converted to UTC via `easternToUTC()` on storage (EDT +4h, EST +5h)
- **Selective routing:** Indices only penalised for macro-moving events (NFP, CPI, FOMC, Trump). NOT penalised for Natural Gas, EIA, Crude Inventories, Unemployment Claims, Housing.
- **Pre-event:** 10-minute window, ×0.75 + cap WATCH
- **Post-event VOLATILITY:** 0-5min, hard block (null)
- **Post-event OPPORTUNITY:** 5-120min, ×1.10 confirms / ×0.90 contradicts
- **Three-stage sentiment:** forecast bias → beat/miss → trend context (see scorer.md)
- **Trump/Fed speech routing:** automatically affects all precious metals + all indices
- **Forecast alert:** Telegram alert when FF scrape detects new forecast on upcoming event

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/signals | Active/open signals (scores if DB empty) |
| GET | /api/past-signals | WIN/LOSS/EXPIRED signals |
| GET | /api/taxonomy | Loss/win category breakdown + insight |
| GET | /api/debug | Comprehensive 9-section health + quality report |
| POST | /api/signal-force-close | Force close ACTIVE signal at current price |
| POST | /api/signal-ignore | Mark signal as not taken (IGNORED) |
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
| GET | /api/mtf-bias | Multi-timeframe structure direction for all symbols |
| GET | /api/stats | Performance analytics (win rate, MFE, sessions, loss cats) |
| GET | /api/journal | Trade journal — last 100 auto-generated entries |
| GET | /api/backtest | Backtest signals with filters — win rate, P&L, breakdowns |
| GET | /api/db-status | DB file sizes + signal count |
| POST | /api/db-prune | Manual retention cleanup + VACUUM (returns before/after counts + DB size) |
| GET | /api/db-recover | Restore from .bak if needed |
| GET | /api/db-verify | Test persist protection |
| GET | /api/telegram-test | Send test message |
| GET | /api/morning-brief | Preview brief HTML |
| POST | /api/morning-brief-send | Send brief to Telegram |
| GET | /api/fxssi-history/collect | Trigger FXSSI history collection (?mode=recent or full) |
| GET | /api/fxssi-history/status | Count + earliest/latest snapshot per symbol |
| GET | /api/fxssi-history/query | Lookup snapshot by symbol + timestamp |
| GET | /api/fxssi-history/stop | Cancel in-progress collection |
| GET | /api/fxssi-history/sample-full | Raw full_analysis JSON for 3 symbols |
| POST | /api/backtest-analyze | Correlate trades with FXSSI history (6 alignment dimensions) |

## FXSSI history collector

- `server/fxssi-history-collector.js` — standalone, queue-based, non-blocking
- Processes ONE job at a time via `setTimeout(processNext, 350)`
- Jobs: `[{symbol, pair, offset}]` for 21 symbols × offsets
- `INSERT OR IGNORE` handles duplicates — safe to restart mid-collection
- Cancellable via `/api/fxssi-history/stop`
- `POST /api/backtest-analyze` correlates trades with historical FXSSI snapshots
- 6 alignment dimensions: sentiment, long_pct, trapped, ob_imbalance, absorption, gravity
