# ATLAS ABC System — Implementation Steps

## What you're doing
Two parallel systems, fully isolated:
- **Tab 1 (Scorer):** unchanged scoring system, all signals → main Telegram
- **Tab 2 (ABC):** Pine-driven class A/B/C, server gates only, A+B → swing Telegram

---

## Step 1 — Pull latest code
```bash
git pull origin main
```

---

## Step 2 — Apply all code changes (paste into Claude Code)
Hand Claude Code the spec file `ATLAS_ABC_CLAUDE_CODE_SPEC.md` and say:
> "Implement this spec exactly. Do not modify any existing scorer logic."

Claude Code will modify 4 files and create 1 new file.

---

## Step 3 — Verify no existing tests break
```bash
node -e "require('./server/scorer')" && echo OK
node -e "require('./server/db')" && echo OK
node -e "require('./server/abcGates')" && echo OK
```

---

## Step 4 — Deploy to Railway
```bash
git add -A
git commit -m "feat: ABC tab — parallel signal system with Pine class routing"
git push origin main
```
Railway auto-deploys. Watch logs for:
```
[DB] abc_signals table ready
[DB] abc_signals migration complete
```

---

## Step 5 — Add TradingView webhook
In TradingView → Alerts → your `atlas_combined_backtest` alert:
- Change webhook URL from `/webhook/pine` to `/webhook/pine-abc`
- Message format stays identical (script already sends `class` field)

---

## Step 6 — Verify in Railway logs
Fire a test alert manually or wait for next signal. You should see:
```
[ABC] EURUSD LONG ClassA — FXSSI trapped aligned → PROCEED
[ABC] Saved to abc_signals id:1
[Telegram] Swing alert sent: EURUSD LONG ClassA
```

---

## Step 7 — Check dashboard
Open your Railway URL → you should see a new **ABC** tab next to FOREX.
Filter buttons: ALL / A / B / C

---

## Done. Both systems run in parallel from this point.
