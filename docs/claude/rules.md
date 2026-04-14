# Rules

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
15. **Never DELETE signals on startup.** No automatic cleanup queries that delete from the signals table during init. Signals expire naturally via `expires_at` or get replaced by new scoring runs. Previous cleanup queries wiped all signals after DB restores.
16. **Anthropic API calls are FORBIDDEN except via explicit user-triggered `/api/macro-force` and `/api/macro-refresh` endpoints.** The 07:00 UTC macro cron has been removed. `runMacroContextFetch()` has a hard caller guard — it requires a `caller` string from `MACRO_ALLOWED_CALLERS` (`cron_0700`, `macro_force`, `macro_refresh`). Any other caller is blocked with a throw. On startup, macro context is loaded from DB only. `claudeLearner.onOutcome` has been removed — no Anthropic API calls on WIN/LOSS outcomes.
17. **persist() is debounced to max once per 30 seconds.** `db.export()` serializes the entire in-memory DB synchronously — at scale this blocks the event loop. `persist()` marks dirty, `_flushToDisk()` runs on a 30s setInterval. Backup copies happen ONLY in the 00:00 UTC daily cron, not on every persist. No `fs.statSync` on the hot path. PRAGMA table_info for fxssi_analysis column check is cached after first call.
