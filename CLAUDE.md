# CLAUDE.md — ATLAS // WATCHLIST

## Project overview

ATLAS // WATCHLIST is an autonomous trading signal system. It ingests TradingView Pine Script alerts and FXSSI order book data, scores them through a multi-layer engine, and presents actionable PROCEED / WATCH / SKIP signals on a real-time dashboard. The system does **not** execute trades — it generates signals for a human trader to act on.

**Stack:** Node.js + Express, sql.js (in-memory SQLite persisted to disk), WebSocket for live updates, Anthropic Claude API for learning/regime detection, FXSSI API for order book sentiment, Telegram Bot API for alerts, Resend for health alert emails.

**Coverage:** 29 symbols + DXY reference:
- **Main group (22):** GOLD, SILVER, OILWTI, BTCUSD, ETHUSD, US30, US100, EURUSD, GBPUSD, USDJPY, USDCHF, USDCAD, AUDUSD, NZDUSD, EURJPY, EURGBP, EURAUD, EURCHF, GBPJPY, GBPCHF, AUDJPY
- **Global group (8):** US500, DE40, UK100, J225, HK50, CN50, COPPER, PLATINUM — `group:'global'`, `noOrderBook:true`
- **DXY:** reference signal only — stored in `dxy_reference` table, no scoring, no signals

## Current scorer version

`SCORER_VERSION = '20260401.7'`

Changes in 20260401.7:
- Partial TP at 1:1 R:R — new PARTIAL_CLOSE recommendation type
- Time stop on dead trades — new TIME_STOP recommendation type
- Loss/Win taxonomy — auto-categorisation on every outcome
- Selective event impact — indices/metals NOT penalised for irrelevant events
- Trump/political speech routes to all precious metals + indices
- PLATINUM + COPPER added to macro context (12 symbols total)
- Pre-event window: 2h → 10 minutes
- Post-event: 30min suppression → 5min volatility block + 2h opportunity window
- Commodity CFD lot sizing (gold=100oz, silver=5000oz, oil=1000bbls per lot)
- FF calendar timezone fix (Eastern → UTC)
- Dynamic minScore floor by weighted structure
- noOrderBook minScore: +3 additive penalty
- WS keepalive (30s ping), sidebar market hours fix
- Signal card UI redesign (3-column, collapsible reasoning)
- SKIP signals hidden from main view (collapsible section)
- HTTP prefetch on page load (no blank screen)
- 5-layer DB race condition protection + daily backup

## Database tables

| Table | Purpose |
|-------|---------|
| market_data | Latest OHLCV + Pine indicators + FXSSI analysis per symbol |
| signals | Live + retired trade signals with outcome tracking |
| weights | Scoring weights per symbol (learner-adjusted) |
| learning_log | Historical weight optimization cycles |
| watch_signals | Non-tradeable WATCH signals for pattern learning |
| settings | Key-value store for persistent state (30+ settings) |
| economic_events | Forex Factory HIGH impact events (5min poll, 4 feeds) |
| macro_context | Persisted macro sentiment per symbol (survives restarts) |
| cb_consensus | Market expectations for upcoming CB meetings |
| cot_data | Weekly CFTC institutional positioning per currency |
| rate_data | Central bank interest rates per currency |
| market_intel | Short-lived user-injected context (24h TTL) |
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
| noOrderBook | No FXSSI data | ×0.92 |
| Pre-event | HIGH impact within 10min | ×0.75 + cap WATCH |
| Post-event VOLATILITY | 0-5min after fire | Hard block (null) |
| Post-event OPPORTUNITY | 5-120min after fire | ×1.10 confirms / ×0.90 against |
| Event sentiment | Beat confirms direction | ×1.05 to ×1.15 |
| Event sentiment | Miss contradicts direction | ×0.85 to ×0.95 |
| FXSSI stale | OB data >25min old | ×0.82 |
| Gravity against | Gravity pulls against direction | ×0.88 |
| Cluster proximity | Losing cluster within 0.3% of entry | ×0.85 |

## Recommendation types

| Type | Trigger | Urgency | Telegram | Expiry |
|------|---------|---------|----------|--------|
| MOVE_SL | Progress milestone / gravity cluster | LOW-MEDIUM | At 80%+ progress | 6h |
| PARTIAL_CLOSE | 1:1 R:R achieved | MEDIUM | Always | Once per signal |
| CLOSE | RSI extreme / structure flip | HIGH | Always | 20min |
| TIME_STOP | Low MFE after hours | MEDIUM | Always | Once per signal |

Time stop thresholds: forex 6h/0.2%, index 4h/0.3%, commodity 8h/0.3%, crypto 12h/0.5%

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

**Portal only — never included in Telegram messages.**

## Event calendar architecture

- **4 feeds polled every 5 minutes:** FF (forex), EE (energy), MM (metals), CC (crypto)
- **Timezone:** FF dates in US Eastern converted to UTC on storage
- **Selective routing:** Indices only penalised for macro-moving events (NFP, CPI, FOMC, Trump). NOT penalised for Natural Gas, EIA, Crude Inventories, Unemployment Claims, Housing.
- **Pre-event:** 10-minute window, ×0.75 + cap WATCH
- **Post-event VOLATILITY:** 0-5min, hard block (null)
- **Post-event OPPORTUNITY:** 5-120min, ×1.10 confirms / ×0.90 contradicts
- **Sentiment:** calculateEventSentiment() — beat/miss based on actual vs forecast
- **Trump/Fed speech routing:** automatically affects all precious metals + all indices

## Daily schedule (UTC)

| Time | Action |
|------|--------|
| 00:00 | Daily DB backup (3 rolling) |
| 05:00 | Morning brief → Telegram |
| :05 hourly | Market intel cleanup (expired) |
| :05 hourly | Mark past events as fired |
| 06:50 | Rate scrape (Trading Economics) |
| 07:00 | Macro context fetch (Claude web search) + CB consensus |
| Every min | Score all symbols → PROCEED signals → Telegram |
| Every min | Outcome check + PARTIAL_CLOSE + TIME_STOP + MOVE_SL |
| */5 min | Economic calendar poll (4 feeds) + fire detection |
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
| POST | /api/trade-feedback | System analysis (no API call) |
| GET/POST | /api/market-intel | Active intel items / inject intel |
| DELETE | /api/market-intel/:id | Remove intel item |
| GET | /api/dxy-status | Latest DXY reference data |
| GET | /api/macro-context | All macro sentiment data |
| GET | /api/macro-debug | DB vs in-memory macro state |
| GET | /api/macro-force | Trigger macro fetch |
| GET | /api/calendar-status | Upcoming HIGH impact events |
| GET | /api/calendar-force | Trigger immediate FF fetch |
| GET | /api/settings | All settings with defaults |
| POST | /api/settings | Update single setting |
| POST | /api/settings/bulk | Update multiple settings |
| GET | /api/rate-status | Rates + pair differentials |
| GET | /api/cot-status | COT currencies + pair summaries |
| GET | /api/cb-calendar | CB meetings + consensus |
| GET | /api/health | System health per symbol |
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
