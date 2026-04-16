// FXSSI Order Book Scraper — Railway server
// Interval-based: fetches every 20min (cron checks every minute)
// Logic ported from ATLAS//FIVE content_fxssi.js

const { upsertMarketData, getLatestMarketData } = require('./db');

const FXSSI_SYMBOLS = {
  // Core 6
  GOLD:   'XAUUSD',
  SILVER: 'XAGUSD',
  OILWTI: 'XTIUSD',
  BTCUSD: 'BTCUSD',
  US100:  'NAS100',
  US30:   'US30',
  // Forex majors
  EURUSD: 'EURUSD',
  GBPUSD: 'GBPUSD',
  USDJPY: 'USDJPY',
  USDCHF: 'USDCHF',
  USDCAD: 'USDCAD',
  AUDUSD: 'AUDUSD',
  NZDUSD: 'NZDUSD',
  // Forex crosses
  EURJPY: 'EURJPY',
  EURGBP: 'EURGBP',
  EURAUD: 'EURAUD',
  EURCHF: 'EURCHF',
  GBPJPY: 'GBPJPY',
  GBPCHF: 'GBPCHF',
  AUDJPY: 'AUDJPY',
  // Crypto
  ETHUSD: 'ETHUSD'
};

const API_BASE = 'https://c.fxssi.com/api/order-book';
const cache       = {}; // 20-min book: { symbol: { raw, analysed, ts } }
const cacheHourly = {}; // 1-hour book:  { symbol: { raw, analysed, ts } }

// ── Null streak tracker ─────────────────────────────────────────────────────
// Counts consecutive null returns per symbol — used by scorer to detect prolonged outage
const nullStreaks = {}; // { symbol: number }

function getFxssiNullStreak(symbol) {
  return nullStreaks[symbol] || 0;
}

// Interval-based fetch check — replaces exact-minute match (:01/:21/:41)
// Exact-minute was a silent failure mode: if cron fired at :02 the check failed and nothing logged
const FXSSI_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
let lastFxssiFetch = 0;

function shouldFetch(symbol) {
  if (process.env.FXSSI_FORCE === '1') return true;
  // Always fetch if cache is empty (startup / restart)
  if (symbol && !cache[symbol]) return true;
  return Date.now() - lastFxssiFetch > FXSSI_INTERVAL_MS;
}

// ── Core analysis — ported from content_fxssi.js ─────────────────────────────
// Left book (open orders):
//   os = open short orders (blue  = SL + Stop orders → ACCELERATE price = hunt targets)
//   ol = open long orders  (orange = Limit + TP     → SLOW price = real S/R)
// Right book (open positions):
//   ps = pending short positions (blue   = losing positions = fuel for continuation)
//   pl = pending long positions  (orange = winning positions = reversal risk)

function analyseOrderBook(data) {
  const levels = data.levels || [];
  const cp     = data.price;   // current price from API

  if (!cp || levels.length === 0) return null;

  // ── Totals for long/short pct ─────────────────────────────────────────────
  let totalLong = 0, totalShort = 0;
  for (const l of levels) {
    totalLong  += (l.ol || 0) + (l.pl || 0);  // orange = long side
    totalShort += (l.os || 0) + (l.ps || 0);  // blue   = short side
  }
  const totalVol = totalLong + totalShort;
  const longPct  = totalVol > 0 ? Math.round((totalLong / totalVol) * 100 * 10) / 10 : 50;
  const shortPct = totalVol > 0 ? Math.round((totalShort / totalVol) * 100 * 10) / 10 : 50;

  // Buy/sell positions (right book only)
  let totalBuyPos = 0, totalSellPos = 0;
  for (const l of levels) {
    totalBuyPos  += (l.pl || 0);
    totalSellPos += (l.ps || 0);
  }
  const totalPos = totalBuyPos + totalSellPos;
  const buyPositionsPct  = totalPos > 0 ? Math.round(totalBuyPos  / totalPos * 1000) / 10 : 50;
  const sellPositionsPct = totalPos > 0 ? Math.round(totalSellPos / totalPos * 1000) / 10 : 50;

  // In profit/loss — based on price position relative to each level
  // pl (longs below price) = in profit | ps (shorts above price) = in profit
  // pl (longs above price) = in loss   | ps (shorts below price) = in loss
  let totalInProfit = 0, totalInLoss = 0;
  for (const l of levels) {
    if (l.price < cp) {
      totalInProfit += (l.pl || 0); // longs below price = in profit
      totalInLoss   += (l.ps || 0); // shorts below price = in loss
    } else {
      totalInProfit += (l.ps || 0); // shorts above price = in profit
      totalInLoss   += (l.pl || 0); // longs above price = in loss
    }
  }
  const totalPL     = totalInProfit + totalInLoss;
  const inProfitPct = totalPL > 0 ? Math.round(totalInProfit / totalPL * 1000) / 10 : 50;
  const inLossPct   = totalPL > 0 ? Math.round(totalInLoss   / totalPL * 1000) / 10 : 50;

  // ── Profit split: buyers vs sellers in profit ────────────────────────────
  // FXSSI Profit Ratio: if spike in inProfitPct AND majority are sellers → BUY
  // If majority are buyers at spike → SELL (crowd manipulation theory)
  let buyersInProfit = 0, sellersInProfit = 0;
  for (const l of levels) {
    if (l.price < cp) {
      buyersInProfit  += (l.pl || 0); // longs below price = buyers in profit
    } else {
      sellersInProfit += (l.ps || 0); // shorts above price = sellers in profit
    }
  }
  const totalProfitSplit = buyersInProfit + sellersInProfit;
  const buyersInProfitPct  = totalProfitSplit > 0 ? Math.round(buyersInProfit  / totalProfitSplit * 1000) / 10 : 50;
  const sellersInProfitPct = totalProfitSplit > 0 ? Math.round(sellersInProfit / totalProfitSplit * 1000) / 10 : 50;

  const above = levels.filter(l => l.price > cp).sort((a,b) => a.price - b.price);
  const below = levels.filter(l => l.price < cp).sort((a,b) => b.price - a.price);

  // ── LIMIT WALLS: ol dominant (orange) = real S/R — SLOW price ────────────
  const limitWalls = levels
    .filter(l => (l.ol||0) > 0.3 && (l.ol||0) >= (l.os||0))
    .sort((a,b) => (b.ol||0) - (a.ol||0));

  const nearestLimitAbove = above.find(l => (l.ol||0) > 0.3 && (l.ol||0) >= (l.os||0)) || null;
  const nearestLimitBelow = below.find(l => (l.ol||0) > 0.3 && (l.ol||0) >= (l.os||0)) || null;

  // SR Wall = strongest limit wall overall
  const srWall = limitWalls[0] ? { price: limitWalls[0].price, volume: limitWalls[0].ol } : null;

  // ── SL CLUSTERS: os dominant (blue) = hunt targets — ACCELERATE price ─────
  const slClusters = levels
    .filter(l => (l.os||0) > 0.3 && (l.os||0) > (l.ol||0))
    .sort((a,b) => (b.os||0) - (a.os||0));

  // Gravity = strongest SL cluster = primary price target (price hunts it)
  const gravity = slClusters[0] ? { price: slClusters[0].price, volume: slClusters[0].os } : null;

  const nearestSLAbove = above.filter(l => (l.os||0) > 0.3)
    .sort((a,b) => (b.os||0) - (a.os||0))[0] || null;
  const nearestSLBelow = below.filter(l => (l.os||0) > 0.3)
    .sort((a,b) => (b.os||0) - (a.os||0))[0] || null;

  // ── LOSING CLUSTERS (right book, blue = ps) = trapped traders = fuel ──────
  const losingClusters = levels
    .filter(l => (l.ps||0) > 1 && (l.ps||0) >= (l.pl||0))
    .sort((a,b) => (b.ps||0) - (a.ps||0));

  // ── WINNING CLUSTERS (right book, orange = pl) = reversal risk ────────────
  const winningClusters = levels
    .filter(l => (l.pl||0) > 1 && (l.pl||0) > (l.ps||0))
    .sort((a,b) => (b.pl||0) - (a.pl||0));

  // ── ABSORPTION: large ol cluster within 0.5% below current price ─────────
  // Orange orders absorbing sell pressure = support
  const absorptionZone = cp * 0.005;
  const nearbyOrange = below.filter(l => l.price >= cp - absorptionZone);
  const avgOl = levels.reduce((s,l) => s+(l.ol||0), 0) / (levels.length||1);
  const absorption = nearbyOrange.some(l => (l.ol||0) > avgOl * 2.5);

  // ── IMBALANCE: longs vs shorts at current price zone (±1%) ───────────────
  const zone = cp * 0.01;
  const zoneLevels = levels.filter(l => Math.abs(l.price - cp) <= zone);
  let zoneLong = 0, zoneShort = 0;
  for (const l of zoneLevels) {
    zoneLong  += (l.ol||0) + (l.pl||0);
    zoneShort += (l.os||0) + (l.ps||0);
  }
  const zoneTotal   = zoneLong + zoneShort;
  const obImbalance = zoneTotal > 0
    ? Math.round(((zoneLong - zoneShort) / zoneTotal) * 100) / 100
    : 0;

  // ── LARGE ORDERS ─────────────────────────────────────────────────────────
  const avgTotal = levels.reduce((s,l) => s+(l.ol||0)+(l.os||0), 0) / (levels.length||1);
  const largeOrders = levels.some(l => (l.ol||0) + (l.os||0) > avgTotal * 3);

  // ── MIDDLE OF VOLUME ──────────────────────────────────────────────────────
  let cumVol2 = 0;
  const totalLeftVol = levels.reduce((s,l) => s+(l.ol||0)+(l.os||0), 0);
  let middleOfVolume = null;
  for (const l of [...levels].sort((a,b) => b.price - a.price)) {
    cumVol2 += (l.ol||0) + (l.os||0);
    if (cumVol2 >= totalLeftVol * 0.5 && !middleOfVolume) { middleOfVolume = l.price; break; }
  }

  // ── OVERBOUGHT/OVERSOLD ───────────────────────────────────────────────────
  const overbought = above.filter(l => (l.pl||0) > 2)
    .sort((a,b) => (b.pl||0) - (a.pl||0))[0] || null;
  const oversold   = below.filter(l => (l.pl||0) > 2)
    .sort((a,b) => (b.pl||0) - (a.pl||0))[0] || null;

  // ── CONTRARIAN SENTIMENT ──────────────────────────────────────────────────
  let sentiment = 'NEUTRAL';
  let trapped   = null;
  // Asymmetric thresholds — SHORT signals need lower crowd trap bar to balance signal generation
  // 55%+ long = bearish sentiment (SHORT opportunity) — lower bar enables more SHORT signals
  // 60%+ short = bullish sentiment (LONG opportunity) — keep higher bar for LONG crowd traps
  if (longPct > 55)  { sentiment = 'BEARISH'; trapped = 'LONG';  } // crowd long = contrarian bearish
  if (shortPct > 60) { sentiment = 'BULLISH'; trapped = 'SHORT'; } // crowd short = contrarian bullish

  // ── SIGNAL COUNTS (buy/sell signals based on structure) ───────────────────
  let buySig = 0, sellSig = 0;
  // Buy signals: SL cluster below (hunt target = price goes there = goes down first then up? no)
  // SL cluster ABOVE = price hunts it upward = buy signal
  // Losing sellers below = trampoline = buy
  // Contrarian: crowd short = buy
  if (nearestSLAbove) buySig++;
  if (losingClusters.some(l => l.price < cp)) buySig++;
  if (sentiment === 'BULLISH') buySig += 2;
  if (absorption) buySig++;
  if (nearestLimitBelow) buySig++; // support wall below

  // Sell signals: SL cluster below = price hunts it downward = sell signal
  // Losing buyers above = trampoline down
  // Contrarian: crowd long = sell
  if (nearestSLBelow) sellSig++;
  if (losingClusters.some(l => l.price > cp)) sellSig++;
  if (sentiment === 'BEARISH') sellSig += 2;
  if (nearestLimitAbove) sellSig++; // resistance wall above

  const signalBias = buySig > sellSig ? 'BUY' : sellSig > buySig ? 'SELL' : 'NEUTRAL';

  return {
    // Position ratio
    longPct, shortPct,
    buyPositionsPct, sellPositionsPct,
    inProfitPct, inLossPct,
    buyersInProfitPct, sellersInProfitPct,
    sentiment, trapped,
    currentPrice: cp,

    // Key levels
    gravity,           // primary SL hunt target
    srWall,            // strongest S/R limit wall
    nearestLimitAbove, nearestLimitBelow,  // real S/R walls
    nearestSLAbove,    nearestSLBelow,     // stop hunt targets
    middleOfVolume,    // trend midpoint
    overbought,        oversold,

    // Cluster analysis
    limitWalls:     limitWalls.slice(0,3),
    slClusters:     slClusters.slice(0,3),
    losingClusters: losingClusters.slice(0,3),
    winningClusters:winningClusters.slice(0,3),

    // Scorer fields
    obAbsorption:  absorption,
    obImbalance,
    largeOrders,

    // Signal counts
    signals: { buy: buySig, sell: sellSig, bias: signalBias },

    snapshotTime: data.time
  };
}

// ── Fetch from FXSSI API (with retry) ───────────────────────────────────────
async function fetchSymbol(pair, period = 1200) {
  const token  = process.env.FXSSI_TOKEN;
  const userId = process.env.FXSSI_USER_ID || '118460';
  if (!token) return null;

  const url = `${API_BASE}?pair=${pair}&view=all&rand=${Math.random()}&token=${token}&user_id=${userId}&period=${period}`;

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          'Referer': 'https://fxssi.com/'
        }
      });

      if (res.status === 429 || res.status === 503) {
        const wait = (attempt + 1) * 2000; // 2s, 4s, 6s backoff
        console.log(`[FXSSI] ${pair} HTTP ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        return null;
      }

      if (!res.ok) { console.error(`[FXSSI] ${pair} HTTP ${res.status}`); return null; }

      const data = await res.json();

      // Diagnostic: FXSSI should update at :00/:20/:40 — log actual vs expected
      const nowDate = new Date();
      const snapDate = new Date((data.time || 0) * 1000);
      const snapMin = snapDate.getUTCMinutes();
      const expectedSlot = [0, 20, 40].reduce((best, slot) => Math.abs(snapMin - slot) < Math.abs(snapMin - best) ? slot : best, 0);
      const ageMin = (Date.now() / 1000 - (data.time || 0)) / 60;
      const driftMin = Math.abs(snapMin - expectedSlot);

      if (ageMin > 25 || driftMin > 5) {
        console.log(`[FXSSI-DIAG] ${pair} snap=${snapDate.toISOString().slice(11,19)} age=${Math.round(ageMin)}m expected=:${String(expectedSlot).padStart(2,'0')} drift=${driftMin}m now=${nowDate.toISOString().slice(11,19)} levels=${data.levels?.length||0}`);
      }

      // Reject stale snapshots (>45 min old) — FXSSI updates at :00/:20/:40
      if (ageMin > 45) { console.log(`[FXSSI] ${pair} REJECTED stale (${Math.round(ageMin)}m)`); return null; }

      return data;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        const wait = (attempt + 1) * 1500;
        console.log(`[FXSSI] ${pair} fetch error (${e.message}) — retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error(`[FXSSI] ${pair} fetch failed after ${MAX_RETRIES + 1} attempts:`, e.message);
      return null;
    }
  }
  return null;
}

// ── Main scrape loop ─────────────────────────────────────────────────────────
async function runFXSSIScrape(broadcast, forceWrite = false) {
  if (!process.env.FXSSI_TOKEN) return;

  const scrapeStart = Date.now();
  const now = Date.now();

  for (const [symbol, pair] of Object.entries(FXSSI_SYMBOLS)) {
    try {
      // 300ms inter-symbol delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));

      const cached   = cache[symbol];
      const cacheAge = cached ? (Date.now() - cached.ts) / 60000 : 999;

      let raw;
      if (shouldFetch(symbol) || cacheAge > 21) {
        raw = await fetchSymbol(pair);
        if (raw) {
          nullStreaks[symbol] = 0; // reset on success
          const analysed = analyseOrderBook(raw);

          // Check freshness BEFORE updating cache
          // prevSnap must be read from old cache value
          // forceWrite bypasses the check — always writes (used by /api/fxssi-force)
          const prevSnap = cache[symbol]?.analysed?.snapshotTime;
          const newSnap  = raw.time; // Unix seconds from FXSSI API
          const isNewData = forceWrite || !prevSnap || newSnap !== prevSnap;

          // Read prevInProfitPct BEFORE updating cache — otherwise prev === curr (delta always 0)
          const prevInProfitPct = cache[symbol]?.analysed?.inProfitPct ?? null;
          // Always update cache with latest fetch
          cache[symbol] = { raw, analysed, ts: now };

          if (isNewData) {
            const snapAge = Math.round((Date.now() / 1000 - newSnap) / 60);
            // ── Profit Ratio Delta ───────────────────────────────────────────────
            // Delta = change in inProfitPct since last scrape
            // Spike > 2% = potential reversal signal (FXSSI theory)
            const currInProfitPct = analysed?.inProfitPct || 50;
            const profitDelta = prevInProfitPct !== null
              ? Math.round((currInProfitPct - prevInProfitPct) * 10) / 10
              : 0;

            // Determine reversal signal from delta
            // If delta > 2%: check who is winning — sellers winning → BUY signal (crowd was wrong)
            //                                       buyers winning → SELL signal (crowd was wrong)
            const buyersWinning  = (analysed?.buyersInProfitPct  || 0) > 55;
            const sellersWinning = (analysed?.sellersInProfitPct || 0) > 55;
            const deltaReversalBias = Math.abs(profitDelta) > 2
              ? (sellersWinning ? 'BUY' : buyersWinning ? 'SELL' : 'NEUTRAL')
              : 'NEUTRAL';

            if (Math.abs(profitDelta) > 2) {
              console.log(`[FXSSI] ${symbol} — Profit Ratio DELTA: ${profitDelta > 0 ? '+' : ''}${profitDelta}% (${currInProfitPct}% profitable). Reversal bias: ${deltaReversalBias}`);
            }

            // Store delta on analysed object for scorer
            analysed.profitDelta       = profitDelta;
            analysed.deltaReversalBias = deltaReversalBias;
            analysed.buyersInProfitPct  = analysed.buyersInProfitPct  || 50;
            analysed.sellersInProfitPct = analysed.sellersInProfitPct || 50;

            // Store fetchedAt — scorer uses this for age, not snapshotTime
            // snapshotTime = when FXSSI last updated their data (~30min cycles)
            // fetchedAt = when WE last successfully fetched it (our 20min cycles)
            // Stale should mean: we haven't fetched recently, not that FXSSI hasn't updated
            analysed.fetchedAt = Date.now();
            console.log(`[FXSSI] ${symbol} — NEW snapshot (${snapAge}m old). long:${analysed?.longPct}% short:${analysed?.shortPct}% trapped:${analysed?.trapped||'—'} bias:${analysed?.signals?.bias} delta:${profitDelta > 0 ? '+' : ''}${profitDelta}% levels:${raw.levels?.length}`);
          } else {
            // Same snapshot from FXSSI API — data hasn't changed on their end
            // Still write to DB to refresh timestamp, carry forward fetchedAt = now
            analysed.profitDelta        = cache[symbol]?.analysed?.profitDelta       ?? 0;
            analysed.deltaReversalBias  = cache[symbol]?.analysed?.deltaReversalBias ?? 'NEUTRAL';
            analysed.buyersInProfitPct  = analysed.buyersInProfitPct  || 50;
            analysed.sellersInProfitPct = analysed.sellersInProfitPct || 50;
            analysed.fetchedAt = Date.now(); // mark as freshly fetched even if data unchanged
            console.log(`[FXSSI] ${symbol} — same snapshot, refreshing DB timestamp (fetchedAt updated)`);
            // fall through to DB write below
          }
        } else {
          nullStreaks[symbol] = (nullStreaks[symbol] || 0) + 1;
          console.log(`[FXSSI] ${symbol} — fetch returned null (streak: ${nullStreaks[symbol]})`);
        }
      } else {
        raw = cached?.raw;
        console.log(`[FXSSI] ${symbol} — using cache (${Math.round(cacheAge)}m old), skipping DB write`);
        continue; // cache is fresh, no need to re-write DB
      }

      const analysed = cache[symbol]?.analysed;
      if (!analysed) { console.log(`[FXSSI] ${symbol} — no analysed data, skipping`); continue; }

      // Merge into existing market data — only reached when data is genuinely new
      const existing = getLatestMarketData(symbol);
      if (!existing) { console.log(`[FXSSI] ${symbol} — no Pine data yet, skipping write`); continue; }
      upsertMarketData(symbol, {
          close:         existing.close,
          high:          existing.high,
          low:           existing.low,
          volume:        existing.volume,
          ema200:        existing.ema200,
          vwap:          existing.vwap,
          rsi:           existing.rsi,
          macdHist:      existing.macd_hist,
          bias:          existing.bias,
          biasScore:     existing.bias_score,
          structure:     existing.structure,
          fvgPresent:    existing.fvg_present === 1,
          fvgHigh:       existing.fvg_high   || null,
          fvgLow:        existing.fvg_low    || null,
          fvgMid:        existing.fvg_mid    || null,
          fxssiLongPct:  analysed.longPct,
          fxssiShortPct: analysed.shortPct,
          fxssiTrapped:  analysed.trapped,
          obAbsorption:  analysed.obAbsorption,
          obImbalance:   analysed.obImbalance,
          obLargeOrders: analysed.largeOrders,
          fxssiAnalysis: JSON.stringify(analysed),
          fxssiFetchedAt: now
        });

      if (broadcast) broadcast({ type: 'FXSSI_UPDATE', symbol, analysed, ts: now });

    } catch (e) {
      console.error(`[FXSSI] ${symbol} error:`, e.message);
    }
  }

  // ── Separated hourly scrape pass ────────────────────────────────────────────
  // Run hourly book scrapes as a separate pass with 500ms inter-symbol delay
  // to avoid rate limiting and keep 20-min + hourly fetches decoupled
  for (const [symbol, pair] of Object.entries(FXSSI_SYMBOLS)) {
    try {
      const cachedH   = cacheHourly[symbol];
      const cacheAgeH = cachedH ? (now - cachedH.ts) / 60000 : 999;
      if (!forceWrite && cacheAgeH <= 55) continue; // hourly: once per hour

      await new Promise(r => setTimeout(r, 500)); // 500ms inter-symbol delay for hourly pass

      const rawH = await fetchSymbol(pair, 3600);
      if (rawH) {
        const analysedH = analyseOrderBook(rawH);
        const prevSnapH = cacheHourly[symbol]?.analysed?.snapshotTime;
        const isNewH    = forceWrite || !prevSnapH || rawH.time !== prevSnapH;
        cacheHourly[symbol] = { raw: rawH, analysed: analysedH, ts: now };
        if (isNewH) {
          console.log(`[FXSSI-H] ${symbol} — NEW hourly snapshot. bias:${analysedH?.signals?.bias} levels:${rawH.levels?.length} gravity:${analysedH?.gravity?.price}`);
          // Merge hourly analysis into existing market data
          const existingH = getLatestMarketData(symbol);
          if (existingH) {
            upsertMarketData(symbol, {
              close: existingH.close, high: existingH.high, low: existingH.low,
              volume: existingH.volume, ema200: existingH.ema200, vwap: existingH.vwap,
              rsi: existingH.rsi, macdHist: existingH.macd_hist,
              bias: existingH.bias, biasScore: existingH.bias_score,
              structure: existingH.structure,
              fvgPresent: existingH.fvg_present === 1,
              fvgHigh: existingH.fvg_high || null,
              fvgLow: existingH.fvg_low || null,
              fvgMid: existingH.fvg_mid || null,
              fxssiLongPct: existingH.fxssi_long_pct,
              fxssiShortPct: existingH.fxssi_short_pct,
              fxssiTrapped: existingH.fxssi_trapped,
              obAbsorption: existingH.ob_absorption,
              obImbalance: existingH.ob_imbalance,
              obLargeOrders: existingH.ob_large_orders,
              fxssiAnalysis: existingH.fxssi_analysis,
              fxssiFetchedAt: existingH.fxssi_fetched_at || null,
              fxssiHourlyAnalysis: JSON.stringify(analysedH)
            });
          }
        } else {
          console.log(`[FXSSI-H] ${symbol} — same hourly snapshot, skipping write`);
        }
      }
    } catch(eH) {
      console.error(`[FXSSI-H] ${symbol} hourly error:`, eH.message);
    }
  }

  lastFxssiFetch = Date.now();
  const scrapeDuration = Math.round((Date.now() - scrapeStart) / 1000);
  console.log(`[FXSSI] Scrape complete in ${scrapeDuration}s (${Object.keys(FXSSI_SYMBOLS).length} symbols)`);
  if (scrapeDuration > 30) {
    console.warn(`[FXSSI] ⚠ Scrape took ${scrapeDuration}s — approaching rate limit window. Consider reducing symbol count.`);
  }
}

// ── Accept POST from browser extension (backup method) ──────────────────────
function processBridgePayload(payload) {
  try {
    const fx = payload.fxssi;
    if (!fx || !fx.symbol) return null;

    // Map FXSSI symbol to our symbol
    const symbolMap = {
      XAUUSD: 'GOLD', XAGUSD: 'SILVER', XTIUSD: 'OILWTI',
      BTCUSD: 'BTCUSD', NAS100: 'US100', US30: 'US30'
    };
    const symbol = symbolMap[fx.symbol];
    if (!symbol) return null;

    const ob = fx.orderBook || {};

    // Build analysed object from bridge format
    const analysed = {
      longPct:          fx.longPct,
      shortPct:         fx.shortPct,
      buyPositionsPct:  fx.buyPositionsPct,
      sellPositionsPct: fx.sellPositionsPct,
      inProfitPct:       fx.inProfitPct,
      inLossPct:         fx.inLossPct,
      buyersInProfitPct: fx.buyersInProfitPct  || 50,
      sellersInProfitPct:fx.sellersInProfitPct || 50,
      profitDelta:       fx.profitDelta        || 0,
      deltaReversalBias: fx.deltaReversalBias  || 'NEUTRAL',
      sentiment:        fx.sentiment,
      trapped:          fx.longPct > 60 ? 'LONG' : fx.shortPct > 60 ? 'SHORT' : null,
      gravity:          ob.gravity,
      srWall:           ob.srWall,
      nearestLimitAbove: ob.nearestLimitAbove,
      nearestLimitBelow: ob.nearestLimitBelow,
      nearestSLAbove:    ob.nearestSLAbove,
      nearestSLBelow:    ob.nearestSLBelow,
      limitWalls:        ob.limitWalls || [],
      slClusters:        ob.slClusters || [],
      losingClusters:    ob.losingClusters || [],
      winningClusters:   ob.winningClusters || [],
      obAbsorption:      ob.nearestLimitBelow != null,
      obImbalance:       fx.longPct > fx.shortPct ? 0.3 : -0.3,
      largeOrders:       (ob.limitWalls||[]).length > 0,
      signals:           fx.signals || { buy: 0, sell: 0, bias: 'NEUTRAL' },
      middleOfVolume:    ob.middleOfVolume,
      overbought:        ob.overbought,
      oversold:          ob.oversold
    };

    const existing = getLatestMarketData(symbol);
    if (existing) {
      upsertMarketData(symbol, {
        close:         existing.close,
        high:          existing.high,
        low:           existing.low,
        volume:        existing.volume,
        ema200:        existing.ema200,
        vwap:          existing.vwap,
        rsi:           existing.rsi,
        macdHist:      existing.macd_hist,
        bias:          existing.bias,
        biasScore:     existing.bias_score,
        structure:     existing.structure,
        fvgPresent:    existing.fvg_present === 1,
        fxssiLongPct:  analysed.longPct,
        fxssiShortPct: analysed.shortPct,
        fxssiTrapped:  analysed.trapped,
        obAbsorption:  analysed.obAbsorption,
        obImbalance:   analysed.obImbalance,
        obLargeOrders: analysed.largeOrders,
        fxssiAnalysis: JSON.stringify(analysed),
        fxssiFetchedAt: Date.now()
      });
    }

    console.log(`[FXSSI Bridge] ${symbol} updated from extension — trapped:${analysed.trapped} bias:${analysed.signals?.bias}`);
    return { symbol, analysed };
  } catch (e) {
    console.error('[FXSSI Bridge] Error:', e.message);
    return null;
  }
}

// Expose cache timestamps for health check
// Returns age in ms of the last successful FXSSI scrape for a symbol
// Returns null if never scraped
function getFxssiCacheAge(symbol) {
  const cached = cache[symbol];
  if (!cached || !cached.ts) return null;
  return Date.now() - cached.ts;
}

module.exports = {
  runFXSSIScrape, processBridgePayload, getFxssiCacheAge, getFxssiNullStreak,
  analyseOrderBook, FXSSI_SYMBOLS, shouldFetch,
  get lastFxssiFetch() { return lastFxssiFetch; }
};
