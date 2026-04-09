# ABC System Rebuild — Phase 2: Pine Scripts + Structural Levels + Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create new Pine Scripts (daily bias indicator + live ABC indicator), add structural entry/SL/TP calculation to abcProcessor, update Telegram format, and update dashboard with new breakdown bars and Class C tab.

**Architecture:** Two new Pine Scripts feed the server via webhooks. abcProcessor.js gets structural entry/SL/TP when new payload fields are present (falls back to old format). Dashboard renders new 4-category breakdown bars and adds Observations tab for Class C signals.

**Tech Stack:** Pine Script v5, Node.js, HTML/CSS/JS client

**Constraints:** Same as Phase 1 — no const for reassigned vars, sql.js wrappers only, don't touch scorer.js/outcome.js/Tab 1.

---

### Task 1: Create atlas_daily_bias.pine

**Files:**
- Create: `atlas_daily_bias.pine`

- [ ] **Step 1: Write the Pine Script**

Create `atlas_daily_bias.pine` — a daily timeframe indicator that calculates EMA200 + Ichimoku cloud bias and fires an alert on every bar close.

- [ ] **Step 2: Commit**

---

### Task 2: Create atlas_abc_live.pine

**Files:**
- Create: `atlas_abc_live.pine`

- [ ] **Step 1: Write the Pine Script**

Create `atlas_abc_live.pine` — an indicator-only version of atlas_combined_backtest.pine for live alert use. No strategy calls. Sends structural data (obTop, obBot, preBosSwing, swing1, swing2, atr, rsi, cloudPass, obPresent, pullbackIn, rsiDiv, volConfirmed, rejStrong) in the alert payload. No request.security() for daily bias. Class A/B/C classification.

- [ ] **Step 2: Commit**

---

### Task 3: Structural entry/SL/TP in abcProcessor.js

**Files:**
- Modify: `server/abcProcessor.js`

- [ ] **Step 1: Add structural level calculation**

In processAbcWebhook, after parsing the Pine payload, add structural entry/SL/TP calculation that uses obTop, obBot, obMid, preBosSwing, swing1, swing2 when available. Falls back to old `data.entry`/`data.sl`/`data.tp` if missing.

Entry = obMid (or fallback to close - ATR*0.3)
SL = preBosSwing - ATR*0.25 (or obBot - ATR*0.25)
TP2 = swing1 (or entry + slDist*2.5)
TP3 = swing2 (or entry + slDist*3.5)
TP1 = entry + slDist (1:1 RR)

RR gate: skip if RR < 1.5 after structural placement.

- [ ] **Step 2: Verify syntax + commit**

---

### Task 4: Update Telegram format

**Files:**
- Modify: `server/telegram.js`

- [ ] **Step 1: Update sendAbcSignalAlert**

New format showing TP1/TP2/TP3 with labels:
```
⭐ Class A PROCEED — EURUSD LONG
Entry: 1.08250 | SL: 1.08080 | Score: 86/95

TP1 🎯 1.08430  (partial close)
TP2 🎯 1.08710  (main target)
TP3 🚀 1.09020  (runner)

[reasoning first sentence]
[crowd line]
```

No mention of FXSSI anywhere.

- [ ] **Step 2: Verify syntax + commit**

---

### Task 5: Dashboard — breakdown bars + Class C tab + language

**Files:**
- Modify: `client/index.html`

- [ ] **Step 1: Update breakdown bars for ABC signals**

When `sig._isAbc` and `sig.breakdown` exists (JSON string), parse it and render 4 bars: Structure, Confluence, Momentum, Crowd Sentiment — using score/max percentage. Fall back to current behavior if breakdown is null.

- [ ] **Step 2: Add Observations subtab**

Add [Observations] button to ABC class filter bar. Fetches `/api/class-c-signals`. Cards show 🔍 badge instead of ⭐/🔷. No WIN/LOSS buttons — only Ignore. Small note: "Class C — monitoring only, not traded"

- [ ] **Step 3: Language cleanup**

Replace in display logic:
- "FXSSI" → never shown
- "fxssi_gate" → "crowd_gate" in display
- "ALIGNED" → "Contrarian ✓"
- "MISALIGNED" → "With-crowd ✗"
- "NO_TRAP" → "Crowd split"
- "NO_DATA" → "No sentiment"

- [ ] **Step 4: Commit**

---

### Task 6: API endpoint updates + version filtering

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Update /api/abc-signals with version filter**

Accept `?version=` query param. Default returns current ABC_VERSION only. `?version=all` returns all.

- [ ] **Step 2: Update /api/abc-stats with crowd_gate rename**

In getAbcStats response, rename fxssi references to crowd terminology.

- [ ] **Step 3: Commit**

---

### Task 7: Final verification + CLAUDE.md

- [ ] **Step 1: Syntax check all files**
- [ ] **Step 2: Update CLAUDE.md with Phase 2 changes**
- [ ] **Step 3: Push to deploy**
