// Central Bank Interest Rate Tracker
// Scrapes Myfxbook interest rates page, falls back to hardcoded rates
// Used by scorer for carry trade alignment and macro context enrichment

const MYFXBOOK_URL = 'https://www.myfxbook.com/forex-economic-calendar/interest-rates';

// Country name → currency mapping (matches Myfxbook table rows)
const COUNTRY_MAP = {
  'United States':  'USD',
  'Euro Zone':      'EUR',
  'United Kingdom': 'GBP',
  'Japan':          'JPY',
  'Switzerland':    'CHF',
  'Canada':         'CAD',
  'Australia':      'AUD',
  'New Zealand':    'NZD'
};

// Fallback rates — updated manually when central banks announce
const FALLBACK_RATES = {
  USD: 4.33, EUR: 2.65, GBP: 4.50, JPY: 0.50,
  CHF: 0.25, CAD: 2.75, AUD: 4.10, NZD: 3.75
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

// ── Scrape Myfxbook interest rates page ─────────────────────────────────────
async function scrapeMyfxbook() {
  console.log('[Rate] Scraping Myfxbook interest rates...');
  const res = await fetch(MYFXBOOK_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html'
    }
  });

  if (!res.ok) {
    console.error(`[Rate] Myfxbook HTTP ${res.status}`);
    return null;
  }

  const html = await res.text();
  console.log(`[Rate] Myfxbook HTML length: ${html.length}`);

  const rates = {};

  for (const [country, currency] of Object.entries(COUNTRY_MAP)) {
    try {
      // Find the country name in the HTML, then extract the rate value nearby
      // Myfxbook table rows contain country name and rate percentage
      // Pattern: country name appears, followed by a rate like "4.33%" in a nearby cell
      const countryIdx = html.indexOf(country);
      if (countryIdx === -1) {
        console.log(`[Rate] ${currency} — "${country}" not found in HTML`);
        continue;
      }

      // Look for percentage pattern within 500 chars after country name
      const searchWindow = html.slice(countryIdx, countryIdx + 500);
      // Match patterns like: >4.33%< or >4.33 %< or "4.33%" or just digits with %
      const rateMatch = searchWindow.match(/(\d+\.?\d*)\s*%/);
      if (rateMatch) {
        const ratePct = parseFloat(rateMatch[1]);
        if (!isNaN(ratePct) && ratePct >= 0 && ratePct < 30) { // sanity check
          rates[currency] = ratePct;
          console.log(`[Rate] ✓ ${currency} (${country}): ${ratePct}%`);
        }
      } else {
        console.log(`[Rate] ${currency} — no rate pattern found near "${country}"`);
      }
    } catch(e) {
      console.error(`[Rate] ${currency} parse error:`, e.message);
    }
  }

  return Object.keys(rates).length > 0 ? rates : null;
}

async function runRateFetch() {
  console.log('[Rate] Starting rate fetch for', Object.keys(COUNTRY_MAP).length, 'currencies');
  let fetched = 0;
  let source = 'scrape';
  const errors = [];

  // Try scraping Myfxbook first
  let scraped = null;
  try {
    scraped = await scrapeMyfxbook();
  } catch(e) {
    console.error('[Rate] Scrape failed:', e.message);
  }

  for (const currency of Object.keys(FALLBACK_RATES)) {
    let ratePct = scraped?.[currency];
    let rateSource = 'myfxbook';

    // Fall back to hardcoded if scrape missed this currency
    if (ratePct == null) {
      ratePct = FALLBACK_RATES[currency];
      rateSource = 'fallback';
      if (!scraped) errors.push({ currency, error: 'scrape failed, using fallback' });
    }

    rateCache[currency] = { ratePct, source: rateSource, ts: Date.now() };
    fetched++;

    try {
      const { upsertRateData } = require('./db');
      upsertRateData(currency, { ratePct, lastUpdated: new Date().toISOString().slice(0, 10) });
    } catch(e) { console.error(`[Rate] ${currency} DB write error:`, e.message); }

    console.log(`[Rate] ${currency}: ${ratePct}% (${rateSource})`);
  }

  console.log(`[Rate] Fetch complete — ${fetched}/${Object.keys(FALLBACK_RATES).length} currencies (source: ${scraped ? 'myfxbook' : 'fallback'})`);
  return { fetched, total: Object.keys(FALLBACK_RATES).length, source: scraped ? 'myfxbook' : 'fallback', errors };
}

// ── Load from DB on startup (no scrape) ─────────────────────────────────────
function loadRatesFromDB() {
  let loaded = 0;
  const maxAge = 25 * 60 * 60 * 1000; // 25 hours
  for (const currency of Object.keys(FALLBACK_RATES)) {
    if (rateCache[currency]) { loaded++; continue; }
    try {
      const { getRateData } = require('./db');
      const row = getRateData(currency);
      if (row && (Date.now() - row.ts) < maxAge) {
        rateCache[currency] = {
          ratePct:     row.rate_pct,
          source:      'db',
          ts:          row.ts
        };
        loaded++;
      }
    } catch(e) {}
  }

  // Fill gaps with hardcoded fallback
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
  // Final fallback
  if (FALLBACK_RATES[currency]) {
    return { ratePct: FALLBACK_RATES[currency], source: 'fallback', ts: 0 };
  }
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
