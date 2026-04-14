# ATLAS — Claude Code Session Instructions

## Session goal
Two separate tasks in this session:
1. Implement the Mercato context system (Parts 1–4)
2. Add pre-analyzed intel support to /api/market-intel

Do NOT modify any other existing logic.

---

## TASK 1 — Mercato Context System

Implement the spec file exactly as written:
**File: ATLAS_MERCATO_FINAL_SPEC.md**

Hand it the spec and say:
> "Implement this spec exactly. Do not modify any existing scorer logic,
> webhook handlers, or Telegram functions beyond what is specified."

Files modified by this task:
- server/db.js (new table + 4 new functions)
- server/mercato.js (NEW FILE — create from scratch)
- server/scorer.js (import + checkMercato after multipliers + generated signal loop)
- server/abcProcessor.js (import + checkMercato after gates)
- server/server.js (CORS + POST/GET /api/mercato)
- server/telegram.js (MERCATO session format in sendSignalAlert)
- client/index.html (mercato badge)

After implementation run the full verification checklist from the spec.
SCORER_VERSION must be bumped to 20260410.3.

---

## TASK 2 — Pre-analyzed Intel Support

Modify the existing POST /api/market-intel endpoint to accept
pre-analyzed payloads from the local HTML macro tool.

### What the local tool sends

```json
{
  "symbol":           "US500",
  "text":             "original raw text",
  "summary":          "2-3 sentence AI summary",
  "levels":           "[6802, 6938]",
  "level_types":      "{\"6802\": \"support\", \"6938\": \"resistance\"}",
  "direction":        "BEARISH",
  "urgency":          "HIGH",
  "ttl":              86400000,
  "source":           "ATLAS//MACRO LOCAL",
  "pre_analyzed":     true
}
```

### What to change in server.js / index.js

Find the POST /api/market-intel handler.

Currently it takes raw text and calls Haiku to analyse it.

Add a bypass at the TOP of the handler:

```js
// ── Pre-analyzed intel from local macro tool — skip Haiku call ────────────
if (body.pre_analyzed === true && body.summary) {
  const intelItem = {
    symbol:      body.symbol || 'ALL',
    text:        body.text   || body.summary,
    summary:     body.summary,
    levels:      body.levels || '[]',      // already JSON string
    level_types: body.level_types || '{}', // already JSON string
    direction:   body.direction   || 'NEUTRAL',
    urgency:     body.urgency     || 'MEDIUM',
    source:      body.source      || 'EXTERNAL',
    expires_at:  body.ttl ? Date.now() + body.ttl : Date.now() + 86400000,
    created_at:  Date.now()
  };

  const id = db.insertMarketIntel(intelItem); // use whatever the existing insert fn is called
  if (!id) return res.status(500).json({ ok: false, error: 'DB write failed' });

  broadcast({ type: 'INTEL_UPDATE', symbol: intelItem.symbol, summary: intelItem.summary });

  return res.json({ ok: true, id, symbol: intelItem.symbol, source: 'pre_analyzed' });
}
// ── Existing Haiku analysis path continues below unchanged ────────────────
```

### Important notes for Claude Code

1. Use whatever the existing DB insert function is called for market_intel
   (it might be insertMarketIntel, saveIntel, upsertIntel — check db.js)
2. The `levels` field MUST be stored as a JSON string (matches db.getLatestIntel usage)
3. Do NOT change the existing Haiku analysis path below the bypass
4. Do NOT change how the scorer reads intel levels
5. The CORS middleware (added in Task 1 via ATLAS_MERCATO_FINAL_SPEC.md) covers this endpoint too

### Verification

```bash
# Test pre-analyzed push (after deploy)
curl -X POST https://your-app.railway.app/api/market-intel \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"US500",
    "text":"CPI came in at 3.3% - hot print",
    "summary":"CPI hot print bearish for US500. Resistance at 6938.",
    "levels":"[6802,6938]",
    "level_types":"{\"6802\":\"support\",\"6938\":\"resistance\"}",
    "direction":"BEARISH",
    "urgency":"HIGH",
    "ttl":86400000,
    "pre_analyzed":true
  }'

# Expected: {"ok":true,"id":N,"symbol":"US500","source":"pre_analyzed"}

# Verify it appears in active intel
curl https://your-app.railway.app/api/market-intel
# Expected: array containing the new intel item with levels and summary
```

---

## SUMMARY — Files changed this session

| File | Task | Change |
|------|------|--------|
| server/db.js | 1 | mercato_context table, 4 new functions |
| server/mercato.js | 1 | NEW FILE |
| server/scorer.js | 1 | checkMercato + generated signal loop |
| server/abcProcessor.js | 1 | checkMercato after gates |
| server/server.js | 1+2 | CORS + /api/mercato + pre_analyzed bypass |
| server/telegram.js | 1 | MERCATO session format |
| client/index.html | 1 | mercato badge |

## Rules reminder (from CLAUDE.md)
- NEVER replace stream body parser with express.json()
- NEVER auto-execute trades
- ALWAYS bump SCORER_VERSION (must be 20260410.3 after this session)
- ALWAYS update CLAUDE.md changelog
- persist() after every DB write
- Mercato penalises/boosts only — never blocks (Rule 6)
