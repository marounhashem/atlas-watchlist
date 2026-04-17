# Deployment

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

## Daily schedule (UTC)

| Time | Action |
|------|--------|
| 00:00 | Daily DB backup (3 rolling) |
| 03:00 | Retention cleanup — prune fxssi_history/market_data/abc_skips/market_data_history (+ VACUUM) |
| 05:00 | Morning brief → Telegram (includes forecast signals section) |
| :05 hourly | Market intel cleanup (expired) |
| :05 hourly | Mark past events as fired |
| 06:50 | Rate scrape (Trading Economics) |
| — | Macro context fetch — MANUAL ONLY via /api/macro-refresh (07:00 cron removed) |
| Every min | Score all symbols → PROCEED signals → Telegram |
| Every min | Outcome check + PARTIAL_CLOSE + TIME_STOP + MOVE_SL |
| :03/:08/:13/… | market_data_history snapshot (every 5min, offset from FXSSI) |
| */5 min | Economic calendar poll (4 feeds) + fire detection + forecast alerts |
| */5 min | FXSSI 20-min order book scrape (interval-based shouldFetch gate) |
| :02/:22/:42 | Signal retirement cycle |
| Hourly | Learning cycle (if thresholds met) |
| Friday 20:45 | COT weekly fetch (CFTC) |
| 23:30 | Nightly FXSSI history collection (recent, queue-based, non-blocking) |
| Every 30min | Health check → email + Telegram if degraded |
