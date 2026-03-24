// FXSSI Order Book Scraper — Railway server
// Fetches at :01, :21, :41 — caches 20min — full level analysis
// Logic ported from ATLAS//FIVE content_fxssi.js

const { upsertMarketData, getLatestMarketData } = require('./db');

const FXSSI_SYMBOLS = {
  GOLD:   'XAUUSD',
  SILVER: 'XAGUSD',
  OILWTI: 'XTIUSD',
  BTCUSD: 'BTCUSD',
  US100:  'NAS100',
  US30:   'US30'
};

const API_BASE = 'https://c.fxssi.com/api/order-book';
const cache = {}; // { symbol: { data, analysed, ts } }

function shouldFetch() {
  if (process.env.FXSSI_FORCE_FETCH === '1') return true;
  const min = new Date().getUTCMinutes();
  return min === 1 || min === 21 || min === 41;
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

  // In profit/loss — winning (ol, pl orange) vs losing (os, ps blue)
  let totalWinning = 0, totalLosing = 0;
  for (const l of levels) {
    totalWinning += (l.ol || 0) + (l.pl || 0);
    totalLosing  += (l.os || 0) + (l.ps || 0);
  }
  const totalPL = totalWinning + totalLosing;
  const inProfitPct = totalPL > 0 ? Math.round(totalWinning / totalPL * 1000) / 10 : 50;
  const inLossPct   = totalPL > 0 ? Math.round(totalLosing  / totalPL * 1000) / 10 : 50;

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
  if (longPct > 60)  { sentiment = 'BEARISH'; trapped = 'LONG';  } // crowd long = contrarian bearish
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

// ── Fetch from FXSSI API ─────────────────────────────────────────────────────
async function fetchSymbol(pair) {
  const token  = process.env.FXSSI_TOKEN;
  const userId = process.env.FXSSI_USER_ID || '118460';
  if (!token) return null;

  const url = `${API_BASE}?pair=${pair}&view=all&rand=${Math.random()}&token=${token}&user_id=${userId}&period=1200`;

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Referer': 'https://fxssi.com/'
    }
  });

  if (!res.ok) { console.error(`[FXSSI] ${pair} HTTP ${res.status}`); return null; }

  const data = await res.json();

  // Reject stale snapshots (>25 min old)
  const ageMin = (Date.now() / 1000 - (data.time || 0)) / 60;
  if (ageMin > 25) { console.log(`[FXSSI] ${pair} stale (${Math.round(ageMin)}m)`); return null; }

  return data;
}

// ── Main scrape loop ─────────────────────────────────────────────────────────
async function runFXSSIScrape(broadcast) {
  if (!process.env.FXSSI_TOKEN) return;

  const forceFetch = shouldFetch();
  const now = Date.now();

  for (const [symbol, pair] of Object.entries(FXSSI_SYMBOLS)) {
    try {
      const cached   = cache[symbol];
      const cacheAge = cached ? (now - cached.ts) / 60000 : 999;

      let raw;
      if (forceFetch || cacheAge > 21) {
        raw = await fetchSymbol(pair);
        if (raw) {
          const analysed = analyseOrderBook(raw);

          // Check if this is genuinely new data vs same snapshot
          const prevSnap = cache[symbol]?.analysed?.snapshotTime;
          const newSnap  = raw.time; // Unix seconds
          const isNewData = !prevSnap || newSnap !== prevSnap;

          cache[symbol] = { raw, analysed, ts: now };
          if (isNewData) {
            const snapAge = Math.round((Date.now() / 1000 - newSnap) / 60);
            console.log(`[FXSSI] ${symbol} — NEW snapshot (${snapAge}m old). long:${analysed?.longPct}% short:${analysed?.shortPct}% trapped:${analysed?.trapped||'—'} bias:${analysed?.signals?.bias} levels:${raw.levels?.length}`);
          } else {
            console.log(`[FXSSI] ${symbol} — same snapshot repeated, skipping DB write`);
          }

          // Only write to DB if data is actually new
          if (!isNewData) continue;
        } else {
          console.log(`[FXSSI] ${symbol} — fetch returned null`);
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
          fxssiAnalysis: JSON.stringify(analysed)
        });

      if (broadcast) broadcast({ type: 'FXSSI_UPDATE', symbol, analysed, ts: now });

    } catch (e) {
      console.error(`[FXSSI] ${symbol} error:`, e.message);
    }
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
      inProfitPct:      fx.inProfitPct,
      inLossPct:        fx.inLossPct,
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
        fxssiAnalysis: JSON.stringify(analysed)
      });
    }

    console.log(`[FXSSI Bridge] ${symbol} updated from extension — trapped:${analysed.trapped} bias:${analysed.signals?.bias}`);
    return { symbol, analysed };
  } catch (e) {
    console.error('[FXSSI Bridge] Error:', e.message);
    return null;
  }
}

module.exports = { runFXSSIScrape, processBridgePayload };
