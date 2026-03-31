// Central Bank Interest Rate Tracker
// Scrapes Trading Economics interest rate table (embedded JSON in HTML)
// Falls back to hardcoded rates if scrape fails
// Used by scorer for carry trade alignment and macro context enrichment

const TE_URL = 'https://tradingeconomics.com/country-list/interest-rate';

// Trading Economics country name → currency mapping
const COUNTRY_MAP = {
  'United States':  'USD',
  'Euro Area':      'EUR',
  'United Kingdom': 'GBP',
  'Japan':          'JPY',
  'Switzerland':    'CHF',
  'Canada':         'CAD',
  'Australia':      'AUD',
  'New Zealand':    'NZD'
};

// Fallback rates — updated when scrape confirms new values
const FALLBACK_RATES = {
  USD: 3.75, EUR: 2.15, GBP: 3.75, JPY: 0.75,
  CHF: 0.00, CAD: 2.25, AUD: 4.10, NZD: 2.25
};

// Map ATLAS pair symbols to base/quote currencies for differential calc
const RATE_PAIRS = {
  EURUSD: { base: 'EUR', quote: 'USD' },
  GBPUSD: { base: 'GBP', quote: 'USD' },
  USDJPY: { base: 'USD', quote: 'JPY' },
  USDCHF: { base: 'USD', quote: 'CHF' },
  USDCAD: { base: 'USD', quote: 'CAD' },
  AUDUSD: { base: 'AUD', quote: 'USD' },
  NZDUSD: { base: 'NZD', quote: 'USD' },
  EURGBP: { base: 'EUR', quote: 'GBP' },
  EURJPY: { base: 'EUR', quote: 'JPY' },
  EURAUD: { base: 'EUR', quote: 'AUD' },
  EURCHF: { base: 'EUR', quote: 'CHF' },
  GBPJPY: { base: 'GBP', quote: 'JPY' },
  GBPCHF: { base: 'GBP', quote: 'CHF' },
  AUDJPY: { base: 'AUD', quote: 'JPY' }
};

// In-memory cache: { currency: { ratePct, source, ts } }
const rateCache = {};

// ── Scrape Trading Economics ────────────────────────────────────────────────
// The page embeds a `var data = [...]` JSON array with all countries
async function scrapeTradingEconomics() {
  console.log('[Rate] Scraping Trading Economics...');
  const res = await fetch(TE_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html'
    }
  });

  if (!res.ok) {
    console.error(`[Rate] Trading Economics HTTP ${res.status}`);
    return null;
  }

  const html = await res.text();
  console.log(`[Rate] HTML length: ${html.length}`);

  // Extract `var data = [...]` JSON block
  const marker = 'var data = [';
  const start = html.indexOf(marker);
  if (start === -1) {
    console.error('[Rate] "var data = [" marker not found in HTML');
    return null;
  }

  const arrStart = start + marker.length - 1; // include the [
  let depth = 0;
  let arrEnd = -1;
  for (let i = arrStart; i < html.length; i++) {
    if (html[i] === '[') depth++;
    if (html[i] === ']') { depth--; if (depth === 0) { arrEnd = i + 1; break; } }
  }

  if (arrEnd === -1) {
    console.error('[Rate] Could not find end of data array');
    return null;
  }

  let arr;
  try {
    arr = JSON.parse(html.slice(arrStart, arrEnd));
  } catch(e) {
    console.error('[Rate] JSON parse error:', e.message);
    return null;
  }

  console.log(`[Rate] Parsed ${arr.length} countries from Trading Economics`);

  const rates = {};
  for (const item of arr) {
    const currency = COUNTRY_MAP[item.name];
    if (currency && item.value != null) {
      const ratePct = parseFloat(item.value);
      if (!isNaN(ratePct) && ratePct >= 0 && ratePct < 30) {
        rates[currency] = ratePct;
        console.log(`[Rate] ✓ ${currency} (${item.name}): ${ratePct}%`);
      }
    }
  }

  return Object.keys(rates).length > 0 ? rates : null;
}

async function runRateFetch() {
  console.log('[Rate] Starting rate fetch for', Object.keys(COUNTRY_MAP).length, 'currencies');
  let fetched = 0;
  let source = 'fallback';
  const errors = [];

  // Try scraping Trading Economics
  let scraped = null;
  try {
    scraped = await scrapeTradingEconomics();
    if (scraped) source = 'tradingeconomics';
  } catch(e) {
    console.error('[Rate] Scrape failed:', e.message);
    errors.push({ error: 'scrape_failed', message: e.message });
  }

  for (const currency of Object.keys(FALLBACK_RATES)) {
    let ratePct = scraped?.[currency];
    let rateSource = 'tradingeconomics';

    if (ratePct == null) {
      ratePct = FALLBACK_RATES[currency];
      rateSource = 'fallback';
    }

    rateCache[currency] = { ratePct, source: rateSource, ts: Date.now() };
    fetched++;

    try {
      const { upsertRateData } = require('./db');
      upsertRateData(currency, { ratePct, lastUpdated: new Date().toISOString().slice(0, 10) });
    } catch(e) { console.error(`[Rate] ${currency} DB write error:`, e.message); }
  }

  console.log(`[Rate] Fetch complete — ${fetched}/${Object.keys(FALLBACK_RATES).length} currencies (source: ${source})`);
  return { fetched, total: Object.keys(FALLBACK_RATES).length, source, errors };
}

// ── Load from DB on startup (no scrape) ─────────────────────────────────────
function loadRatesFromDB() {
  let loaded = 0;
  const maxAge = 25 * 60 * 60 * 1000;
  for (const currency of Object.keys(FALLBACK_RATES)) {
    if (rateCache[currency]) { loaded++; continue; }
    try {
      const { getRateData } = require('./db');
      const row = getRateData(currency);
      if (row && (Date.now() - row.ts) < maxAge) {
        rateCache[currency] = { ratePct: row.rate_pct, source: 'db', ts: row.ts };
        loaded++;
      }
    } catch(e) {}
  }

  // Fill gaps with fallback
  for (const [currency, rate] of Object.entries(FALLBACK_RATES)) {
    if (!rateCache[currency]) {
      rateCache[currency] = { ratePct: rate, source: 'fallback', ts: 0 };
    }
  }

  console.log(`[Rate] Loaded ${loaded}/${Object.keys(FALLBACK_RATES).length} from DB, rest from fallback`);
  return loaded;
}

// ── Get rate for a currency ─────────────────────────────────────────────────
function getCurrencyRate(currency) {
  if (rateCache[currency]) return rateCache[currency];
  if (FALLBACK_RATES[currency]) return { ratePct: FALLBACK_RATES[currency], source: 'fallback', ts: 0 };
  return null;
}

// ── Get all rates ───────────────────────────────────────────────────────────
function getLatestRates() {
  const rates = {};
  for (const currency of Object.keys(FALLBACK_RATES)) {
    const r = getCurrencyRate(currency);
    if (r) rates[currency] = r;
  }
  return rates;
}

// ── Rate differential for a pair ────────────────────────────────────────────
function getRateDifferential(symbol) {
  const pair = RATE_PAIRS[symbol];
  if (!pair) return null;

  const baseRate = getCurrencyRate(pair.base);
  const quoteRate = getCurrencyRate(pair.quote);
  if (!baseRate || !quoteRate) return null;

  const diffPct = baseRate.ratePct - quoteRate.ratePct;
  const diffBps = Math.round(diffPct * 100);
  const absBps = Math.abs(diffBps);

  let direction, strength;
  if (absBps < 50) {
    direction = 'NEUTRAL';
    strength = 'WEAK';
  } else {
    direction = diffBps > 0 ? 'BASE_FAVOURED' : 'QUOTE_FAVOURED';
    if (absBps > 300)      strength = 'EXTREME';
    else if (absBps > 150) strength = 'STRONG';
    else if (absBps > 50)  strength = 'MODERATE';
    else                   strength = 'WEAK';
  }

  const carryDir = diffBps > 0 ? 'long' : 'short';
  const summary = `${pair.base} ${diffBps > 0 ? '+' : ''}${diffBps}bps vs ${pair.quote} — ${strength.toLowerCase()} carry favours ${symbol} ${carryDir}`;

  return {
    baseCurrency: pair.base,
    quoteCurrency: pair.quote,
    baseRate: baseRate.ratePct,
    quoteRate: quoteRate.ratePct,
    differential: diffBps,
    direction,
    strength,
    summary
  };
}

module.exports = { runRateFetch, loadRatesFromDB, getLatestRates, getRateDifferential };
