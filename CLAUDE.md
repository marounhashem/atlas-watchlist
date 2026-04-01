# CLAUDE.md — ATLAS // WATCHLIST

## Project overview

ATLAS // WATCHLIST is an autonomous trading signal system. It ingests TradingView Pine Script alerts and FXSSI order book data, scores them through a multi-layer engine, and presents actionable PROCEED / WATCH / SKIP signals on a real-time dashboard. The system does **not** execute trades — it generates signals for a human trader to act on.

**Stack:** Node.js + Express, sql.js (in-memory SQLite persisted to disk), WebSocket for live updates, Anthropic Claude API for learning/regime detection, FXSSI API for order book sentiment, Telegram Bot API for alerts, Resend for health alert emails.

**Coverage:** 22 symbols — 3 commodities (GOLD, SILVER, OILWTI), 2 crypto (BTCUSD, ETHUSD), 2 indices (US30, US100), 15 forex pairs.

## Current scorer version

`SCORER_VERSION = '20260331.10'`

Changes in 20260331.10:
- Macro context persisted to DB (`macro_context` table) — survives Railway restarts
- Startup loads stored macro from DB (3s), only fetches fresh if stale (>26h)
- `macro_context_available` flag now correctly set (checks existence + freshness <26h)
- Stronger macro conflict penalties: strength 8+ → ×0.70, 6-7 → ×0.78 (was: 7+ → ×0.78)
- COT extreme positioning penalty: specs >100k crowded against signal → ×0.88, with → ×1.05
- Telegram MEDIUM MOVE_SL at 80%+ progress now pushed alongside HIGH urgency
- Active signal dedup: belt-and-suspenders check in saveSignal() via getOpenSignals()

Changes in 20260331.9:
- Telegram integration — server/telegram.js (raw fetch, no external libs)
- PROCEED signal alerts pushed to Telegram on save
- HIGH urgency trade monitor recommendations pushed to Telegram
- Morning brief at 05:00 UTC (09:00 Dubai) with macro, COT, carry, CB meetings, positions
- Health alerts sent to Telegram alongside email

Changes in 20260331.8:
- Startup macro context fetch, POST /api/macro-force endpoint
- signals.macro_context_available column (0/1)
- ACTIVE dedup fix in getLatestOpenSignal: checks ALL cycles

Changes in 20260331.7:
- Central bank meeting calendar — event risk gate, forward guidance, consensus fetch

Changes in 20260331.6:
- Rate differentials via Trading Economics scrape — carry gate scoring

Changes in 20260331.5:
- COT refactored to currency-level storage, cross pair support

Changes in 20260331.4:
- COT data integration — CFTC weekly institutional positioning

Changes in 20260331.3:
- Webhook auth, XSS sanitise, async persist, gravity dedupe, RR trim

Changes in 20260331.2:
- FXSSI stale penalty, gravity gate, cluster proximity, structScore 6-TF fix

## Database tables

| Table | Purpose |
|-------|---------|
| market_data | Latest OHLCV + Pine indicators + FXSSI analysis per symbol |
| signals | Live + retired trade signals with outcome tracking |
| weights | Scoring weights per symbol (learner-adjusted) |
| learning_log | Historical weight optimization cycles |
| watch_signals | Non-tradeable WATCH signals for pattern learning |
| settings | Key-value store for persistent state |
| economic_events | Forex Factory HIGH impact events (weekly fetch) |
| macro_context | Persisted macro sentiment per symbol (survives restarts) |
| cb_consensus | Market expectations for upcoming CB meetings |
| cot_data | Weekly CFTC institutional positioning per currency |
| rate_data | Central bank interest rates per currency |

## Architecture decisions

- **Railway deployment** with a 1 GB persistent volume mounted at `/app/data` for the SQLite file.
- **sql.js** (not better-sqlite3) because Railway runs on Linux containers and sql.js is pure JavaScript — no native compilation required.
- **No execution layer.** The system generates signals; a human decides whether to take them. This is a deliberate safety boundary.
- **Single-process.** All crons (scoring, FXSSI scraping, outcome checking, learning, health) run in one Node.js process via node-cron. Acceptable for current scale (~22 symbols, 1 user).
- **FXSSI as primary weight** (0.45 default). Order book data drives entry/SL/TP placement and contrarian sentiment. Pine technical analysis is secondary (0.40). Session multiplier is 0.15.
- **Claude learning** uses Haiku for cost efficiency. Weight adjustments are capped at ±0.03 per cycle, 6-hour minimum between cycles, 30+ trades required per symbol.
- **Webhook auth** is opt-in via `WEBHOOK_SECRET` env var. When set, `/webhook/pine` and `/webhook/fxssi` require `req.body.secret` to match.
- **persist()** is async with write coalescing — multiple rapid persist() calls collapse into a single disk write. The 15s interval flush remains as a safety net.
- **Macro context** persisted to `macro_context` table. Loaded from DB on startup (3s), only fetches fresh via Claude web search if data is >26h stale. Macro penalises signals (×0.70 to ×0.94) — does not hard-block.
- **Telegram alerts** via raw Bot API fetch (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). PROCEED signals pushed on save, HIGH urgency recs + MEDIUM MOVE_SL at 80%+ progress, morning brief at 05:00 UTC, health alerts alongside email.
- **Forex Factory calendar** fetched weekly from FairEconomy JSON feed. HIGH impact events stored in `economic_events` table. 24h event risk gate caps signals to WATCH. Shown in morning brief with 📊 icon. Cron: Sundays 06:00 UTC + weekdays 06:45.
- **Central bank calendar** hardcoded 2026 meeting dates for 8 banks. Event risk gate caps signals to WATCH within 48h. Consensus auto-fetched via Claude for meetings within 21 days.
- **Rate differentials** scraped daily from Trading Economics (no API key). 8 currencies with hardcoded fallback. Carry gate: >300bps against → ×0.88, >500bps → ×0.80, >300bps with → ×1.05.
- **COT data** fetched weekly from CFTC SODA API. Stored at currency level (EUR, GBP, etc). Resolved to pair level on read. COT extreme penalty: >100k crowded against signal → ×0.88, with → ×1.05.

## Scoring penalty stack (cumulative)

All penalties multiply `conflictMultiplier` which scales the raw score:

| Gate | Condition | Multiplier |
|------|-----------|-----------|
| Macro conflict | Strength 8-10 against | ×0.70 |
| Macro conflict | Strength 6-7 against | ×0.78 |
| Macro conflict | Strength 4-5 against | ×0.88 |
| COT extreme | >100k specs crowded against | ×0.88 |
| COT extreme | >100k specs favours direction | ×1.05 |
| Carry fight | >500bps against direction | ×0.80 |
| Carry fight | >300bps against direction | ×0.88 |
| Carry with | >300bps with direction | ×1.05 |
| Forward guidance | CB consensus confirms | ×1.08 |
| Forward guidance | CB consensus contradicts | ×0.88 |
| Event risk | CB meeting within 48h | Cap to WATCH |
| FXSSI stale | OB data >25min old | ×0.82 |
| Gravity against | Gravity pulls against direction | ×0.88 |
| Cluster proximity | Losing cluster within 0.3% of entry | ×0.85 |

## Daily schedule (UTC)

| Time | Action |
|------|--------|
| 05:00 | Morning brief → Telegram |
| 06:50 | Rate scrape (Trading Economics) |
| 07:00 | Macro context fetch (Claude web search) + CB consensus |
| Every min | Score all symbols → PROCEED signals → Telegram |
| Every min | Outcome check → HIGH urgency recs → Telegram |
| :01/:21/:41 | FXSSI 20-min order book scrape |
| :02/:22/:42 | Signal retirement cycle |
| Hourly | Learning cycle (if thresholds met) |
| Friday 20:45 | COT weekly fetch (CFTC) |
| Every 30min | Health check → email + Telegram if degraded |

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| ANTHROPIC_API_KEY | Yes | Claude API for learning, macro, consensus |
| FXSSI_TOKEN | Yes | FXSSI order book API |
| FXSSI_USER_ID | No | FXSSI user ID (default 118460) |
| TELEGRAM_BOT_TOKEN | No | Telegram Bot API token |
| TELEGRAM_CHAT_ID | No | Telegram chat ID for alerts |
| RESEND_API_KEY | No | Resend email for health alerts |
| ALERT_EMAIL | No | Health alert email (fallback: marounhashem@gmail.com) |
| WEBHOOK_SECRET | No | Body secret for webhook auth |
| DB_PATH | No | SQLite file path (default: ./data/atlas.db) |

## Rules

1. **Never auto-execute trades.** This system is signal-only. No broker API integration, no order placement, no position management. The human trader makes the final call.
2. **Never wipe the database without explicit user confirmation.** The `/api/reset-*` endpoints exist for emergencies only. Always confirm before running destructive operations.
3. **Always bump `SCORER_VERSION`** when scoring logic changes. Old signals are auto-expired on startup based on version mismatch. Format: `YYYYMMDD.N` (date + daily increment).
4. **Never commit secrets.** API keys stay in environment variables only.
5. **Persist before returning.** Any DB write that changes signal state must call `persist()` before returning to the caller.
6. **Macro penalises, not blocks.** Macro context conflicts apply scoring multipliers (×0.70 to ×0.94). Only event risk (CB meeting within 48h) can cap verdict.
