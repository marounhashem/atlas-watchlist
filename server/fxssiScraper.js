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

// Cache: holds last fetch per symbol, valid for 20 minutes
const cache = {};

function shouldFetch() {
  const min = new Date().getUTCMinutes();
  return min === 1 || min === 21 || min === 41;
}

function analyseOrderBook(data) {
  const currentPrice = data.price;
  const levels = data.levels || [];

  let totalLong = 0, totalShort = 0;
  let supportLevels = [], resistanceLevels = [];
  const volumePerLevel = [];

  for (const lvl of levels) {
    const longVol  = (lvl.ol || 0) + (lvl.pl || 0);
    const shortVol = (lvl.os || 0) + (lvl.ps || 0);
    const total    = longVol + shortVol;

    totalLong  += longVol;
    totalShort += shortVol;
    volumePerLevel.push(total);

    // Support: high long orders below current price
    if (lvl.price < currentPrice && longVol > 0) {
      supportLevels.push({ price: lvl.price, volume: longVol });
    }
    // Resistance: high short orders above current price
    if (lvl.price > currentPrice && shortVol > 0) {
      resistanceLevels.push({ price: lvl.price, volume: shortVol });
    }
  }

  const totalVolume = totalLong + totalShort;
  const longPct  = totalVolume > 0 ? Math.round((totalLong  / totalVolume) * 100) : 50;
  const shortPct = totalVolume > 0 ? Math.round((totalShort / totalVolume) * 100) : 50;

  // Imbalance: positive = more longs, negative = more shorts (-1 to +1)
  const imbalance = totalVolume > 0
    ? Math.round(((totalLong - totalShort) / totalVolume) * 100) / 100
    : 0;

  // Large orders: any level with volume > 3x average
  const avgVolume = volumePerLevel.length > 0
    ? volumePerLevel.reduce((a, b) => a + b, 0) / volumePerLevel.length
    : 0;

  const largeOrderThreshold = avgVolume * 3;
  const largeOrders = levels.some(lvl =>
    ((lvl.ol || 0) + (lvl.pl || 0) + (lvl.os || 0) + (lvl.ps || 0)) > largeOrderThreshold
  );

  // Absorption: large long cluster within 0.5% below current price
  const absorptionZone = currentPrice * 0.005;
  const nearbyLongs = levels.filter(lvl =>
    lvl.price >= currentPrice - absorptionZone && lvl.price < currentPrice
  );
  const absorption = nearbyLongs.some(lvl => (lvl.ol || 0) > largeOrderThreshold * 0.5);

  // Top support/resistance levels
  supportLevels.sort((a, b) => b.volume - a.volume);
  resistanceLevels.sort((a, b) => b.volume - a.volume);

  // Trapped: who is on the wrong side based on imbalance
  let trapped = null;
  if (longPct >= 65)  trapped = 'LONG';  // crowd is long = trapped bulls
  if (shortPct >= 65) trapped = 'SHORT'; // crowd is short = trapped bears

  return {
    longPct,
    shortPct,
    imbalance,
    absorption,
    largeOrders,
    trapped,
    topSupport:    supportLevels.slice(0, 3).map(l => l.price),
    topResistance: resistanceLevels.slice(0, 3).map(l => l.price),
    snapshotTime:  data.time,
    currentPrice
  };
}

async function fetchSymbol(symbol, pair) {
  const token  = process.env.FXSSI_TOKEN;
  const userId = process.env.FXSSI_USER_ID || '118460';

  if (!token) {
    console.log('[FXSSI] No token set — add FXSSI_TOKEN to Railway variables');
    return null;
  }

  const rand = Math.random();
  const url  = `${API_BASE}?pair=${pair}&view=all&rand=${rand}&token=${token}&user_id=${userId}&period=1200`;

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Referer': 'https://fxssi.com/'
    }
  });

  if (!res.ok) {
    console.error(`[FXSSI] ${symbol} HTTP ${res.status}`);
    return null;
  }

  const data = await res.json();

  // Validate freshness — reject if snapshot older than 25 minutes
  const snapshotAge = (Date.now() / 1000) - (data.time || 0);
  if (snapshotAge > 25 * 60) {
    console.log(`[FXSSI] ${symbol} snapshot too old (${Math.round(snapshotAge/60)}m) — skipping`);
    return null;
  }

  return data;
}

async function runFXSSIScrape(broadcast) {
  const token = process.env.FXSSI_TOKEN;
  if (!token) return;

  const forceFetch = shouldFetch();
  const now = Date.now();

  for (const [symbol, pair] of Object.entries(FXSSI_SYMBOLS)) {
    try {
      // Use cache unless it's a fetch minute or cache is older than 21 minutes
      const cached = cache[symbol];
      const cacheAge = cached ? (now - cached.ts) / 60000 : 999;

      let data;
      if (forceFetch || cacheAge > 21) {
        data = await fetchSymbol(symbol, pair);
        if (data) {
          cache[symbol] = { data, ts: now };
          console.log(`[FXSSI] ${symbol} — fresh fetch`);
        }
      } else {
        data = cached?.data;
      }

      if (!data) continue;

      const analysis = analyseOrderBook(data);

      // Merge into existing market data
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
          fxssiLongPct:  analysis.longPct,
          fxssiShortPct: analysis.shortPct,
          fxssiTrapped:  analysis.trapped,
          obAbsorption:  analysis.absorption,
          obImbalance:   analysis.imbalance,
          obLargeOrders: analysis.largeOrders
        });

        console.log(`[FXSSI] ${symbol} updated — long:${analysis.longPct}% short:${analysis.shortPct}% trapped:${analysis.trapped||'none'} absorption:${analysis.absorption}`);
      }

      if (broadcast) {
        broadcast({ type: 'FXSSI_UPDATE', symbol, analysis, ts: now });
      }

    } catch (e) {
      console.error(`[FXSSI] ${symbol} error:`, e.message);
    }
  }
}

module.exports = { runFXSSIScrape, shouldFetch };
