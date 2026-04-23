# Session Handover — 2026-04-23

> **For the next Claude (or Claude Code) working in this repo.** If you're debugging something and see changes you don't recognize, read this first.

Session window: 2026-04-22 afternoon Dubai → 2026-04-23 early AM Dubai.
**9 commits total** — 8 from the primary session + 1 second-pass via Claude Code (`2d5765a`).
All on `main`, auto-deployed to Railway.

---

## Update: Second pass via Claude Code (commit `2d5765a`)

After the primary session, Claude Code (`claude --dangerously-skip-permissions`) read this handover and did a second pass. What changed:

### Shipped in `2d5765a`

- **`adminGate` extended to 21 more endpoints → 42 total gated.** The first pass (`2d0afca`) covered the obvious ones; the second pass found DELETEs, db-prune, settings writes, calendar/rate mutations, lifecycle mutations, and a Telegram-spam trigger that were still exposed.
- **`STOCK_SCORER_VERSION` format unified**: `'20260421.01'` → `'20260421.1'` (was P1 #1). All three version strings now use the same `YYYYMMDD.N` format.
- **`global.atlasGetActiveIntel` corrupt-JSON default flipped** (was P1 #4). At `server/index.js:4304-4311`, a `JSON.parse` failure on `affected_symbols` used to default to `return true` (treat as global intel, returned for every symbol). Now defaults to `return false` + a warn log. Corrupt rows stop silently polluting the scorer context.

### Intentionally NOT gated (legitimate exceptions)
- `POST /api/macro-inject` and `POST /api/mercato` are called from the file:// macro tool per internal docs. Gating would break that workflow. Left open by design.

### Correction to this handover doc's P1 #3 claim

I wrote that `abcProcessor.js` had ~10 silent `catch(e){}` blocks swallowing errors on `broadcast()` calls. **That was wrong.** Claude Code checked the actual lines (102, 105, 170, 300, 330, 345, 471, 499, 514) and found those catches wrap `db.insertAbcSkip()` analytics inserts, NOT broadcast calls. The real broadcasts at lines 444/569 are unwrapped, and the outer `/webhook/pine-abc` handler at `server/index.js:70-71` already catches at the top level — so the exposure is defense-in-depth at most, not a real silent-swallow bug. P1 #3 downgraded to "nice to have, not urgent". If future-me does a pass here, log inside the analytics catches so we can see when skip-log inserts fail, but the alert-path itself is covered.

### Correction #2: SCORER_VERSION bump does NOT auto-expire (my TL;DR table was wrong)

The table above said `75cf208` "SCORER bump expired OPEN signals on deploy — that was intentional." **Not true.** `db.expireOldVersionSignals(currentVersion)` at `server/db.js:775` is actually DISABLED:
```js
function expireOldVersionSignals(currentVersion) {
  // DISABLED — was expiring all signals after DB restores because restored
  // signals have old scorer versions.
  return 0;
}
```
So the SCORER_VERSION bump did NOT clean up old signals. The cleanup has to be done manually (or through natural `expires_at` TTL). Kept in mind for next version-bump protocol.

### Correction #3: ABC_VERSION bump caused a live outage (`cca7d8b` fix)

The TL;DR flag for `8df19ad` said "ABC_VERSION bump hides pre-bump ABC signals from /api/abc-signals". That description was too narrow. The real impact (discovered ~4pm UAE when user reported "ABC not working"):

1. Dashboard hid old-version rows (expected)
2. **But `getOpenAbcSignals()` at `db.js:1490` was NOT version-filtered** — so 11+ stuck old-version Class C rows still counted against the `BURST` gate (`abcProcessor.js:96`, ≥5 = block non-A) and `ACTIVE_EXISTS` dedup (`abcProcessor.js:337`, same symbol+direction)
3. Result: Pine alerts arrived, got silently rejected, logged as BURST/ACTIVE_EXISTS in `abc_skips`. User saw dead board.

**Fixed in `cca7d8b`:** `getOpenAbcSignals(version)` now takes optional version filter. Burst + ACTIVE_EXISTS callers pass `ABC_VERSION`. Outcome tracking (`abcManagement.js`) intentionally left version-less so real ACTIVE trades from prior versions keep getting tracked to WIN/LOSS. Immediate unblock was a one-off `POST /api/abc-archive-old` at ~17:30 UAE.

**Lesson for future version bumps:** a version filter must be applied *consistently* across all read paths that touch the table. Check every caller of `db.getAbcSignals` / `db.getOpenAbcSignals` before shipping a bump. Or change the write path so old signals auto-ARCHIVE — but beware the DB-restore edge case that killed `expireOldVersionSignals`.

### Deferred to a dedicated session (feature work, not bugs)

- **P1 #2** — Pine version header constants across `atlas_abc_live.pine`, `atlas_watchlist.pine`, `atlas_daily_bias.pine`, `atlas_pullback.pine`. Meaningful work — touches TradingView-side + server-side version cross-check.
- **P1 #5** — Macro staleness Telegram alert for the 12-48h silent-starvation gap. Needs a design decision on the alert channel (spot vs swing vs new admin channel) + quiet-hours logic so it doesn't ping overnight.
- **P1 #6** — Mercato dedicated UI section. Mirror of the Macro Context section pattern but with price-level rendering (resistance/support levels in Silvia-style data).

### Left alone (exploratory / not yet tracked)
- `atlas_abc_logger.pine`, `atlas_abc_logger_strategy.pine`, `atlas_abc_sanity.pine` — untracked Pine scratch files
- `failed_breakout_study/` — untracked Python research folder

---

---

## TL;DR — what changed and why

| # | Commit | One-liner | Risk if misunderstood |
|---|---|---|---|
| 1 | `c28f34f` | **(abandoned approach)** Merged `mercato_context` into `/api/market-intel` to populate Intel tab | Superseded by #2, then #7 |
| 2 | `75cf208` | Also merged `macro_context` + bumped `SCORER_VERSION` 20260416.1 → 20260421.1 | **SCORER bump expired OPEN signals on deploy** — that was intentional |
| 3 | `cbd1d36` | Stocks watchdog: self-heal 16:00 Dubai cron misses | New code path in `routes/stocks.js` |
| 4 | `8df19ad` | `/api/agent` auth + `ABC_VERSION` 20260416.2 → 20260423.1 + calendar cron `dbReady` guard | **ABC_VERSION bump hides pre-bump ABC signals from /api/abc-signals** |
| 5 | `06beebc` | Intel card shows "fetched X ago" for macro/mercato rows (was misread as age) | Frontend `fmtFetchedAge` helper added |
| 6 | `bf3ca9e` | **Killed zombie intel seed** that re-injected two hardcoded strings on every restart | Intel table now genuinely starts empty on fresh DB |
| 7 | `a068bae` | Reverted macro merge from `/api/market-intel` (was double-rendering with dedicated Macro Context section) | Mercato merge KEPT. Macro now served only via `/api/macro-context`. |
| 8 | `2d0afca` | **Auth-hardened 21 endpoints** via shared `adminGate` middleware | Every admin/reset/paid-API endpoint now requires Origin OR `WEBHOOK_SECRET` |

---

## Why each change happened — if you're debugging, read the relevant section

### 1-2. Intel tab was empty after macro refresh

**Symptom:** user injected 30 symbols via `/api/macro-inject`, then the Intel tab showed nothing.

**Root cause:** `/api/market-intel` only returned rows from the `market_intel` table (ad-hoc user-injected), never the 30 macro rows in `macro_context`.

**First attempt (`c28f34f`):** merged `mercato_context` — but that table was empty.

**Second attempt (`75cf208`):** also merged `macro_context`. This worked, but caused a later issue (#7).

**Side effect of `75cf208`:** `SCORER_VERSION` bumped 20260416.1 → 20260421.1. This triggers `expireOldVersionSignals(SCORER_VERSION)` at `server/index.js` on every startup. OPEN signals from the old version get archived (clean board), ACTIVE signals (real trades) are preserved. This is by design but surprising.

### 3. Stocks pre-market scan cron dropped a tick silently

**Symptom:** on 2026-04-22, the `0 16 * * 1-5` Asia/Dubai cron registered at startup but **never fired** — no `[scanner] Scheduled scan triggered` in Railway logs at 12:00 UTC. Manual `POST /api/stocks/scan` with `x-scan-secret` header worked fine, proving the scanner itself was healthy. Likely causes: Railway container restart aligned to the minute, or node-cron dropping a tick.

**Fix (`cbd1d36`):** `server/routes/stocks.js:39-85` — added `_watchdogInFlight` flag + `isPastScanTimeDubaiWeekday()` helper. On every `GET /api/stocks/watchlist/today`, if it's past 16:00 Dubai on a weekday AND no scan exists for today, kick off `runScan()` fire-and-forget. UI polls every 120s; next refresh picks up the fresh scan.

**If you see `[scanner][watchdog]` logs,** it means the primary cron missed its tick and the watchdog self-healed. Check Railway restart history around that minute.

### 4. Three P0 fixes from first audit

- **`/api/agent` was unauthenticated** and forwarded to Anthropic with the server's API key. Any script hitting that URL could burn the budget. Fix: `server/index.js:1335-1415` — added `checkAgentAuth(req)` that requires matching `Origin`/`Referer` + 20 req/5min/IP rate limit.
- **`ABC_VERSION` drift:** `server/abcProcessor.js:6` was `20260416.2`, `server/scorer.js:157` was `20260421.1`. `/api/abc-signals` and analytics filter by `ABC_VERSION`, so writes under the old version tag were polluting dashboards. Bumped to `20260423.1` to reflect the `0453abe` noOrderBook one-class demotion change. No auto-expire fires from ABC version bumps (unlike SCORER). Old ABC rows are still in DB but hidden from filtered views until `/api/abc-archive-old` is called manually.
- **Calendar cron `*/5 * * * *` had no `dbReady` guard** (`server/index.js:3761`). Fix: added `if (!dbReady) return;`. **Audit originally flagged FXSSI cron here too — that was wrong, FXSSI at `:3634` already has the guard at `:3635`.**

### 5. "11h 58m" display lie on Intel cards

**Symptom:** user freshly refreshed macro → cards showed "11h 58m" → user read it as "posted 11h ago and still not expired, WTF?"

**Root cause:** `fmtIntelExpiry(expires_at)` at `client/index.html:2728` is a countdown formatter — it shows `expires_at - Date.now()` as "Xh Ym remaining". For user-injected intel with a 12h TTL this is useful. For macro rows freshly fetched, it shows "11h 58m remaining of 12h TTL" which looks identical to "11h 58m old".

**Fix (`06beebc`):** added `fmtFetchedAge(ts)` helper at `client/index.html:2735`. Then in `loadIntel()` around `:2754`, check `i.source === 'macro' || i.source === 'mercato'` — if yes, use `fmtFetchedAge` (shows "just now", "23m ago", "4h 12m ago"). Else use the countdown formatter (user set the expiry, they care about the countdown).

### 6. Zombie intel that wouldn't die

**Symptom:** user reported two intel messages ("Geopolitical tensions..." and "Nikkei Futures at critical juncture...") had been stuck in the Intel tab for weeks. Deletes didn't stick. TTL didn't kill them.

**Root cause:** `server/index.js:4343-4358` had a "DB-wipe recovery" block: on every startup, if `market_intel` table was empty, it re-seeded two hardcoded strings with fresh 48h/72h expiry. Every Railway deploy = restart = empty table? = re-seed. User deletes → TTL expires → next deploy re-seeds. Infinite loop.

**Fix (`bf3ca9e`):** ripped the block entirely. Table now stays empty unless user injects via `POST /api/market-intel`.

**Pattern to look for elsewhere:** `if (count === 0) { seed hardcoded data; }` is an anti-pattern. Real DB-wipe recovery should pull from an authoritative external source (like COT does from CFTC), not hardcoded strings. Audit found this was the only instance in the codebase — don't re-introduce it.

### 7. Macro data rendering twice on Intel tab

**Symptom:** after `75cf208`, 30 macro rows showed up in the Intel list at the TOP of the tab — but they ALSO already rendered in the dedicated `MACRO CONTEXT` section at the BOTTOM.

**Root cause:** I didn't know the dedicated section existed. `client/index.html:2855` has `fetchAndRenderMacroContext()` which hits `/api/macro-context` directly and renders into `#macro-list`. It's called from the tab switch handler at `:2571`. The section has been there all along.

**Fix (`a068bae`):** removed macro merge from `/api/market-intel`. **Kept mercato merge** because mercato has NO dedicated UI section (the Silvia-style data only surfaces via the intel list today).

**Lesson for the next audit:** when a frontend has multiple render paths, a server merge can easily create duplication. Read the client HTML first, then match endpoints to views. Doc at `server/index.js:2820-2835` (comment block on `/api/market-intel`) explains the current design.

### 8. Auth-hardening 21 endpoints

**Context:** the deeper audit surfaced a lot more unauthenticated endpoints that either mutate data destructively, call paid APIs, trigger external scrapers, or send Telegram. Left alone, any cross-origin HTML form or link-preview bot could wipe the DB, drain Anthropic credits, or IP-ban the server from CFTC/FXSSI.

**Fix (`2d0afca`):** added shared `adminGate` middleware at `server/index.js:1388-1425`. Accepts EITHER:
1. **`WEBHOOK_SECRET`** via `x-webhook-secret` header, `?secret=` query, or `body.secret` (for curl/scripts/browser-extension use). Reuses the same env var that `/webhook/alert` already uses.
2. **Origin/Referer allowlist match** (for browser UI) — same allowlist as `checkAgentAuth`.

**Endpoints now gated** (21 total):

| Group | Endpoints |
|---|---|
| DB-destructive | `POST /api/reset-abc`, `/api/reset-signals`, `/api/reset-data`, `/api/reset-all`, `/api/reset-cycles`; `GET /api/db-recover` |
| Market-data webhook | `POST /webhook/fxssi-rich` |
| Anthropic paid API | `GET/POST /api/macro-refresh`, `GET/POST /api/macro-force`, `GET /api/macro-test`, `POST /api/claude/optimise/:symbol`, `POST /api/claude/regime-now` |
| External scrapers | `GET/POST /api/cot-force`, `GET /api/cot-test`, `GET /api/calendar-force`, `GET /api/rate-force`, `GET /api/fxssi-fetch`, `GET /api/fxssi-force`, `GET /api/fxssi-test` |
| Telegram spam | `POST /api/stocks/push-swing` — uses existing `STOCK_SCAN_SECRET` pattern for consistency |

**Not gated (intentionally public):** `/api/market-intel` (GET), `/api/macro-context` (GET), `/api/macro-debug` (GET), `/api/signals`, `/api/stocks/watchlist/today`, and other read-only endpoints used by the dashboard.

**Already gated before this session:** `/webhook/alert` (Pine — uses `WEBHOOK_SECRET` in body), `/api/stocks/scan` (uses `STOCK_SCAN_SECRET`), `/api/agent` (from commit 8df19ad).

---

## Things that might trip you up

1. **`/api/abc-signals` returns fewer rows than you expect.** This is because of the ABC_VERSION bump in `8df19ad`. The filter at `server/index.js:597-598` + `:1086` + `:1096` only returns rows where `abc_version === ABC_VERSION`. Pre-20260423.1 ABC rows are in DB but hidden. To see them, call `POST /api/abc-archive-old` (archives old versions), or lower the filter temporarily.

2. **The 30 macro rows currently in DB are from a manual refresh around 21:15 UTC on 2026-04-23.** They'll expire at 12h TTL (`*/15 * * * *` cron deletes `macro_context` rows older than 12h per `server/index.js:4175-4189`). After that, `/api/macro-refresh` must be called manually. The `0 */6 * * *` watchdog at `:3748` only auto-refreshes if age is >48h, so there's a 12-48h gap where macro can be silently empty. P1 item not shipped yet.

3. **`adminGate` blocks curl without auth.** If you're testing endpoints from a terminal and see "missing origin/secret", add `-H "x-webhook-secret: $WEBHOOK_SECRET"`. The secret value is in Railway env vars.

4. **Intel table is currently EMPTY.** That's expected. The two zombie messages are gone (`bf3ca9e`), user hasn't injected anything new, mercato hasn't pushed today. Tab will show only the Macro Context section (30 rows). This is correct.

5. **Stocks `scan_id 2` Boeing pick still exists** from the manual trigger at ~18:40 Dubai 2026-04-22. The `0 16 * * 1-5` cron hasn't fired a fresh scan yet at time of this handover (first chance: Thursday 2026-04-23 16:00 Dubai = 12:00 UTC). If tomorrow's cron drops again, the watchdog from `cbd1d36` will auto-heal.

---

## P1 items NOT shipped yet (carry over)

**Status after `2d5765a` second pass: P1 #1 and P1 #4 shipped, P1 #3 downgraded. Remaining:**

- ~~P1 #1 Version format inconsistency~~ — **done in `2d5765a`** (STOCK_SCORER_VERSION now `.1` format).
- **P1 #2 — Pine scripts have no version header constant.** `atlas_abc_live.pine`, `atlas_pullback.pine`, `atlas_watchlist.pine`, `atlas_daily_bias.pine` carry no version string. If Pine logic changes on TradingView without bumping `ABC_VERSION` server-side, old Pine signals keep the new tag silently. Needs coordinated change on TradingView charts.
- ~~P1 #3 Silent catches in abcProcessor~~ — **downgraded to "nice to have"**. Original claim was wrong (see Second-pass correction above). Defense-in-depth only.
- ~~P1 #4 `global.atlasGetActiveIntel` corrupt-JSON default~~ — **done in `2d5765a`** (flipped to `return false` + warn).
- **P1 #5 — Macro staleness Telegram alert** for the 12-48h silent-starvation gap. Telegram ping when `macroContext` is empty for >2h during market hours. Needs design: which channel, quiet hours, dedupe.
- **P1 #6 — Mercato dedicated UI section.** Mirror the Macro Context section pattern but render price-levels (resistance/support) for the Silvia-style data. Would let us drop the mercato merge from `/api/market-intel` and leave the intel list purely for user-injected rows.

---

## Verification state at end of session

All 7 auth tests passed against `2d0afca`:

| Test | Expected | Got |
|---|---|---|
| `POST /api/reset-abc` no auth | 403 | 403 "missing origin/secret" |
| `POST /api/reset-abc` bad Origin | 403 | 403 "bad origin (and no secret)" |
| `GET /api/macro-test` no auth | 403 | 403 (no Anthropic call, no $ burned) |
| `GET /api/fxssi-test` correct Origin | 200 | 200 (FXSSI data returned, Origin path works) |
| `GET /api/market-intel` no auth | 200 | 200 (public read still works) |
| `GET /api/macro-debug` no auth | 200 | 200 (30 macro rows present) |
| `POST /api/reset-abc` wrong secret | 403 | 403 |

**DB state check:** 59 active signals in `signals` table, `scan_id 2` Boeing preserved in `stock_scans`, 30 macro rows in `macro_context`, 0 ABC signals visible (filtered by version bump), 0 rows in `market_intel` (zombies removed + user never reinjected), 0 active mercato rows.

---

## Docs updated in this session

- `docs/claude/architecture.md` — `/api/market-intel` description updated to reflect intel+mercato merge (NOT macro, per `a068bae`). Pullback routing note updated.
- `docs/claude/scorer.md` — `SCORER_VERSION` bumped to `20260421.1` with changelog entry.
- `docs/claude/deployment.md` — unchanged this session.
- **This file** — `docs/claude/session_20260423_handover.md` — new.

---

## If you're Claude Code and you saw something weird

Most likely suspects:
- "There's this weird `adminGate` middleware on everything" → read section 8 above. It's intentional.
- "Why does `abcProcessor.js` have a comment referencing commit `0453abe`?" → the noOrderBook one-class demotion ships the logic change; `ABC_VERSION` bump in `8df19ad` makes it visible in analytics.
- "`/api/market-intel` used to merge 3 tables, now only 2" → `a068bae` — dedicated macro section exists in frontend, merge was causing duplication.
- "`server/index.js:4343` has just a comment block where there used to be code" → `bf3ca9e` — zombie seed removal. Do NOT re-add it. Read section 6.
- "`fmtFetchedAge` and `fmtIntelExpiry` look similar" → they ARE similar. One is countdown (user-set expiry), the other is age (auto-source data). Use the right one per `loadIntel()` logic.

When in doubt, `git log --oneline -10` and start from 2026-04-23 commits.
