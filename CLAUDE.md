# CLAUDE.md — ATLAS // WATCHLIST

## Project overview

ATLAS // WATCHLIST is an autonomous trading signal system. It ingests TradingView Pine Script alerts and FXSSI order book data, scores them through a multi-layer engine, and presents actionable PROCEED / WATCH / SKIP signals on a real-time dashboard. The system does **not** execute trades — it generates signals for a human trader to act on.

**Stack:** Node.js + Express, sql.js (in-memory SQLite persisted to disk), WebSocket for live updates, Anthropic Claude API for learning/regime detection, FXSSI API for order book sentiment, Resend for health alert emails.

**Coverage:** 22 symbols — 3 commodities (GOLD, SILVER, OILWTI), 2 crypto (BTCUSD, ETHUSD), 2 indices (US30, US100), 15 forex pairs.

## Current scorer version

`SCORER_VERSION = '20260331.3'`

Changes in 20260331.3:
- Webhook authentication middleware (WEBHOOK_SECRET env var, bearer token)
- XSS sanitisation via `esc()` helper on all innerHTML signal content
- Async persist() with write coalescing (no longer blocks event loop)
- Gravity double-dip removed — scoreFXSSI no longer applies +0.10 for SL cluster in direction (post-score ×0.88 gate handles it)
- RR sanity check trims TP instead of discarding FXSSI-based SL/TP entirely
- FXSSI scrape duration tracking with >30s warning
- WebSocket reconnect with exponential backoff (1s → 60s max)
- Agent API fetch timeout (30s AbortController)
- Error stack no longer leaked to client on /api/score-now
- Health alert email moved to ALERT_EMAIL env var

Changes in 20260331.2:
- FXSSI stale penalty (×0.82 when order book data > 25 min old)
- Gravity direction gate (×0.88 when gravity pulls against trade direction)
- Losing cluster proximity penalty (×0.85 when clusters within 0.3% of entry)
- Merge RR guard in db.js (block merge if RR cannot reach 1.5 after TP recalc)
- structScore fixed to use all 6 TFs (was silently using only 1h + 4h)
- structureZero hoisted before counter-trend gate (was undefined when referenced)
- insertWatchSignal fixed to return correct ID

## Known issues and fixes applied (2026-03-31)

### Fixed today

| # | Issue | File(s) | Fix | Commit |
|---|-------|---------|-----|--------|
| 1 | FXSSI rate limiting | fxssiScraper.js | Retry with backoff, 300ms delay, separated hourly pass | c933c90 |
| 2 | FXSSI stale penalty + gravity gate + cluster proximity | scorer.js | ×0.82 / ×0.88 / ×0.85 multipliers | c933c90 |
| 3 | Merge creates untradeable RR | db.js | Block merge if RR < 1.5 after TP recalc | c933c90 |
| 4 | structScore used 2/6 TFs | scorer.js | Removed orphaned line that overwrote 6-TF sum | aeb2e79 |
| 5 | structureZero undefined | scorer.js | Hoisted before counter-trend gate | aeb2e79 |
| 6 | Watch signal ID always null | db.js | Switched to `get()` consistent with insertSignal | aeb2e79 |
| 7 | No webhook authentication | index.js | Bearer token middleware on all /webhook/* routes | pending |
| 8 | XSS via innerHTML | index.html | `esc()` sanitiser on symbol, label, reasoning, error msgs | pending |
| 9 | Error stack leak on /api/score-now | index.js | Log internally, return generic error to client | pending |
| 10 | Synchronous persist() blocks event loop | db.js | Async fs.writeFile with write coalescing | pending |
| 14 | Gravity penalty double-dip | scorer.js | Removed +0.10 from scoreFXSSI (post-score gate handles it) | pending |
| 15 | RR recalc discards FXSSI levels | scorer.js | Trim TP to cap/floor RR instead of full ATR rebuild | pending |
| 17 | FXSSI scrape timing tight | fxssiScraper.js | Duration tracking + >30s warning | pending |
| 18 | WebSocket reconnect no backoff | index.html | Exponential backoff 1s → 60s | pending |
| 20 | Agent API no timeout | index.html | 30s AbortController on fetch | pending |
| 21 | Health email hardcoded | index.js | Moved to ALERT_EMAIL env var | pending |

### Deferred issues

| # | Issue | Reason |
|---|-------|--------|
| 4 | Weight backfill migration references nonexistent columns | Low impact — silent catch, defaults work. Needs schema archaeology. |
| 5 | Settings value never converted back from string | Works via JS type coercion. Fix when it causes a real bug. |
| 6 | retireActiveCycle cycle semantics (timestamp as cycle ID) | Functional, just confusing. Refactor when touching retirement logic. |
| 11 | Recommendations stored as JSON string (race condition) | Needs separate table. Larger refactor — schedule separately. |
| 12 | Session multiplier ignores time-to-close | Requires market hours rework. Low frequency edge case. |
| 13 | No per-symbol weight differentiation in defaults | Waiting for enough trade data per asset class to calibrate. |
| 16 | Structure cap tiers too flat at top (93/94/95%) | Needs backtesting data to validate new tier spread. |
| 19 | No CSV export | Feature request, not a bug. Build when needed. |

## Architecture decisions

- **Railway deployment** with a 1 GB persistent volume mounted at `/app/data` for the SQLite file.
- **sql.js** (not better-sqlite3) because Railway runs on Linux containers and sql.js is pure JavaScript — no native compilation required.
- **No execution layer.** The system generates signals; a human decides whether to take them. This is a deliberate safety boundary.
- **Single-process.** All crons (scoring, FXSSI scraping, outcome checking, learning, health) run in one Node.js process via node-cron. Acceptable for current scale (~22 symbols, 1 user).
- **FXSSI as primary weight** (0.45 default). Order book data drives entry/SL/TP placement and contrarian sentiment. Pine technical analysis is secondary (0.40). Session multiplier is 0.15.
- **Claude learning** uses Haiku for cost efficiency. Weight adjustments are capped at ±0.03 per cycle, 6-hour minimum between cycles, 30+ trades required per symbol.
- **Webhook auth** is opt-in via `WEBHOOK_SECRET` env var. When set, all `/webhook/*` routes require `Authorization: Bearer <token>` or `X-Webhook-Secret` header. TradingView alerts support custom headers.
- **persist()** is async with write coalescing — multiple rapid persist() calls collapse into a single disk write. The 15s interval flush remains as a safety net.

## Rules

1. **Never auto-execute trades.** This system is signal-only. No broker API integration, no order placement, no position management. The human trader makes the final call.
2. **Never wipe the database without explicit user confirmation.** The `/api/reset-*` endpoints exist for emergencies only. Always confirm before running destructive operations.
3. **Always bump `SCORER_VERSION`** when scoring logic changes. Old signals are auto-expired on startup based on version mismatch. Format: `YYYYMMDD.N` (date + daily increment).
4. **Never commit secrets.** API keys (ANTHROPIC_API_KEY, FXSSI_TOKEN, RESEND_API_KEY, WEBHOOK_SECRET) stay in environment variables only.
5. **Persist before returning.** Any DB write that changes signal state must call `persist()` before returning to the caller.
