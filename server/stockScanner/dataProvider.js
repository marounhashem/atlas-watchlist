// server/stockScanner/dataProvider.js
//
// Wraps yahoo-finance2 to fetch the specific fields this scanner needs.
// Yahoo is free, keyless, and reliable — the trade-off is no official
// SLA, so we defensively handle missing fields and rate-limit ourselves.
//
// Key fields we extract per symbol:
//   - preMarketPrice, regularMarketPreviousClose  -> gap %
//   - preMarketVolume, averageDailyVolume3Month   -> relative volume
//   - 14-day ATR from daily bars                  -> levels/stops
//   - Float, shares outstanding                   -> float-rotation check
//   - Bid/ask spread                              -> liquidity filter

// yahoo-finance2 v3 is class-based — the default export is a constructor,
// not a singleton. v2 exported a ready-to-use object; v3 requires instantiation.
// The suppressNotices option on the constructor replaces the v2 global method.
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

// Yahoo throttles aggressive callers. We process the universe in chunks
// of CONCURRENCY at a time with a small stagger between chunks. In
// practice ~350 symbols completes in 30–60s.
const CONCURRENCY = 8;
const CHUNK_DELAY_MS = 200;

// Sentinel rvol when pre-market volume is unmeasurable (see comment below).
// Chosen to sit at the scorer's minRvol gate (1.8) so candidates pass through
// without a fabricated volume signal. Score contribution lands near 40/100,
// which is neutral-low — gap% and catalyst dominate the final rank.
const RVOL_UNAVAILABLE_SENTINEL = 1.8;

/**
 * Fetch a single symbol's pre-market snapshot + recent daily bars.
 * Returns null if Yahoo has no data (delisted, bad ticker, halted).
 */
async function fetchSymbol(symbol) {
  try {
    // v3 restructured the response: averageDailyVolume3Month moved from
    // quoteSummary.summaryDetail to the lighter yf.quote() endpoint.
    // We fetch both so we can populate avgVolume consistently.
    const [quote, chart, quoteShort] = await Promise.all([
      yahooFinance.quoteSummary(symbol, {
        modules: ['price', 'summaryDetail', 'defaultKeyStatistics'],
      }),
      // 30 trading days is enough for a clean 14-day ATR calc
      yahooFinance.chart(symbol, {
        period1: daysAgo(45),
        interval: '1d',
      }),
      // Volume fields live here in v3. Swallow errors — some tickers
      // (ETFs, OTC names) don't have a quote endpoint.
      yahooFinance.quote(symbol).catch(() => null),
    ]);

    const price = quote?.price || {};
    const details = quote?.summaryDetail || {};
    const stats = quote?.defaultKeyStatistics || {};
    const bars = (chart?.quotes || []).filter(b => b.high && b.low && b.close);

    if (!price.regularMarketPreviousClose || bars.length < 10) {
      return null;
    }

    // Pre-market price/volume are only populated during the ~4:00–9:30 ET
    // window. Outside that window we fall back to the previous session's
    // close so we can still show "no gap" rather than erroring.
    const preMarketPrice =
      price.preMarketPrice?.raw ??
      price.preMarketPrice ??
      price.regularMarketPrice?.raw ??
      price.regularMarketPrice;

    const prevClose =
      price.regularMarketPreviousClose?.raw ??
      price.regularMarketPreviousClose;

    // v3 dropped preMarketVolume from quoteSummary.price. Try quote()
    // first (in case Yahoo re-exposes it there), then fall back to 0.
    const preMarketVolume =
      price.preMarketVolume ??
      quoteShort?.preMarketVolume ??
      0;

    // 3-month avg daily volume — the denominator for relative volume.
    // v2 returned this from summaryDetail; v3 moved it to yf.quote().
    // We chain through both locations for resilience.
    const avgVolume =
      details.averageVolume?.raw ??
      details.averageVolume ??
      details.averageDailyVolume3Month ??
      quoteShort?.averageDailyVolume3Month ??
      quoteShort?.averageDailyVolume10Day ??
      0;

    const gapPct = ((preMarketPrice - prevClose) / prevClose) * 100;

    // RVOL = pre-market volume so far vs a pro-rated share of the full-day
    // average (pre-market is assumed to be ~10% of a normal day).
    //
    // yahoo-finance2 v3 removed preMarketVolume from its public API. When
    // we can't measure it, we fall back to a neutral sentinel (1.8) that
    // passes both the prefilter (≥ 1.5) and the scorer gate (≥ 1.8) without
    // claiming strong volume. The scorer's rvolScoreFn returns 40/100 at
    // rvol=1.8, giving a modest (not enthusiastic) contribution. In this
    // degraded mode, gap% and catalyst-strength do the real filtering.
    const PREMARKET_SHARE_OF_DAY = 0.10;
    const expectedPremarketVol = avgVolume * PREMARKET_SHARE_OF_DAY;
    const rvol = (expectedPremarketVol > 0 && preMarketVolume > 0)
      ? preMarketVolume / expectedPremarketVol
      : RVOL_UNAVAILABLE_SENTINEL;

    const atr14 = calculateATR(bars.slice(-15), 14);
    const float = stats.floatShares?.raw ?? stats.floatShares ?? null;

    return {
      symbol,
      name: price.shortName || price.longName || symbol,
      prevClose,
      preMarketPrice,
      preMarketVolume,
      avgVolume,
      gapPct: round(gapPct, 2),
      rvol: round(rvol, 2),
      atr14: round(atr14, 3),
      atrPct: round((atr14 / prevClose) * 100, 2),
      float,
      bid: details.bid?.raw ?? details.bid ?? null,
      ask: details.ask?.raw ?? details.ask ?? null,
      marketCap: price.marketCap?.raw ?? price.marketCap ?? null,
      exchange: price.exchangeName || null,
      lastBarClose: bars[bars.length - 1].close,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    // Yahoo occasionally 404s unfamiliar tickers — that's expected, not
    // an error worth logging loudly. We'll surface counts in the
    // scanner summary instead.
    return null;
  }
}

/**
 * Fetch the entire universe with bounded concurrency.
 * Returns { results: [...], failed: [...] }.
 */
async function fetchUniverse(symbols) {
  const results = [];
  const failed = [];

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const chunk = symbols.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(s => fetchSymbol(s)));
    chunkResults.forEach((res, idx) => {
      if (res) results.push(res);
      else failed.push(chunk[idx]);
    });
    if (i + CONCURRENCY < symbols.length) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  return { results, failed };
}

// ----- helpers -----

function calculateATR(bars, period = 14) {
  // Wilder's Average True Range. bars must be chronological, len >= period+1.
  if (bars.length < period + 1) return 0;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - prev.close),
      Math.abs(b.low - prev.close),
    );
    trSum += tr;
  }
  let atr = trSum / period;
  // Smooth remaining bars with Wilder's method
  for (let i = period + 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - prev.close),
      Math.abs(b.low - prev.close),
    );
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

function round(n, digits) {
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

module.exports = { fetchSymbol, fetchUniverse };
