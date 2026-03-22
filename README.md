# ATLAS // WATCHLIST

Autonomous trading signal system — 11 priority symbols, 24/7 monitoring,
self-learning every 30 minutes via Claude AI.

## Priority Symbols
GOLD · SILVER · OIL WTI · BTCUSD · US500 · US100 · DE40 · UK100 · J225 · HK50 · CN50

---

## Deploy to Railway (5 steps)

### 1. GitHub repo
Push this folder to a private GitHub repo.

### 2. Railway setup
- Go to railway.app → New Project → Deploy from GitHub
- Select your repo
- Railway auto-detects Node.js

### 3. Environment variables
In Railway dashboard → Variables tab, add:
```
ANTHROPIC_API_KEY = sk-ant-...
PORT = 3001
```

### 4. Persistent disk
Railway dashboard → your service → Settings → Volumes
Add volume mounted at `/app/data` (1GB, ~$0.25/month)

### 5. Get your URL
Railway gives you: https://atlas-watchlist-xxx.railway.app
This is your webhook base URL.

---

## TradingView Setup

### Pine Script
1. Open TradingView → Pine Editor
2. Paste contents of `atlas_watchlist.pine`
3. Add to chart for each of your 11 symbols

### Alerts (do once per symbol)
1. TradingView → Alerts → Create Alert
2. Condition: ATLAS Bar Close
3. Frequency: Once per bar close
4. Webhook URL: `https://your-url.railway.app/webhook/pine`
5. Message: paste the JSON block from the Pine Script comment
6. Repeat for all 11 symbols

---

## Dashboard
Open `https://your-url.railway.app` in any browser.

- Green border = PROCEED (score ≥ threshold)
- Yellow border = WATCH (score 55–threshold)
- Dim = SKIP
- Log WIN/LOSS on each signal — this feeds the learning engine
- Learning log updates every 30 minutes

---

## FXSSI Integration
Since FXSSI has no API, paste sentiment data manually:

```bash
curl -X POST https://your-url.railway.app/webhook/fxssi \
  -H "Content-Type: application/json" \
  -d '{"symbol":"GOLD","longPct":68,"shortPct":32,"trapped":"SHORT"}'
```

Or build a simple bookmarklet to post FXSSI page data.

---

## Cost Estimate
- Railway Hobby: $5/month
- Railway disk (1GB): ~$0.25/month
- Anthropic API (30m cycles): ~$3–8/month
- Total: ~$8–13/month
