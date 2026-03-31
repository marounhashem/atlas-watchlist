// Central Bank Interest Rate Tracker
// Fetches rates from API Ninjas, calculates pair differentials
// Used by scorer for carry trade alignment and macro context enrichment

const RATE_API = 'https://api.api-ninjas.com/v1/interestrate';

// Map currencies to API Ninjas central bank names
const RATE_ENDPOINTS = {
  USD: 'central_bank_us',
  EUR: 'central_bank_euro_area',
  GBP: 'central_bank_uk',
  JPY: 'central_bank_japan',
  CHF: 'central_bank_switzerland',
  CAD: 'central_bank_canada',
  AUD: 'central_bank_australia',
  NZD: 'central_bank_new_zealand'
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

// In-memory cache: { currency: { ratePct, lastUpdated, ts } }
const rateCache = {};

async function fetchRate(currency, bankName) {
  const apiKey = process.env.INTEREST_RATE_API_KEY;
  if (!apiKey) return null;

  const url = `${RATE_API}?name=${encodeURIComponent(bankName)}`;
  const res = await fetch(url, {
    headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' }
  });

  console.log(`[Rate] ${currency} HTTP ${res.status}`);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[Rate] ${currency} error: ${body.slice(0, 300)}`);
    return null;
  }

  const data = await res.json();
  console.log(`[Rate] ${currency} raw response: ${JSON.stringify(data).slice(0, 400)}`);

  // API Ninjas v1 returns: { central_bank_rates: [{ central_bank, country, rate_pct, last_updated }] }
  const rates = data.central_bank_rates || (Array.isArray(data) ? data : null);
  if (!rates || rates.length === 0) {
    console.log(`[Rate] ${currency} — no rates array in response`);
    return null;
  }

  // First result is the match (we queried by exact name)
  const match = rates[0];
  console.log(`[Rate] ${currency} matched: ${match.central_bank || match.name} = ${match.rate_pct ?? match.rate}%`);

  return {
    ratePct: parseFloat(match.rate_pct ?? match.rate ?? 0),
    lastUpdated: match.last_updated || match.date || null
  };
}

async function runRateFetch() {
  const apiKey = process.env.INTEREST_RATE_API_KEY;
  if (!apiKey) {
    console.log('[Rate] No INTEREST_RATE_API_KEY — skipping rate fetch');
    return { fetched: 0, total: Object.keys(RATE_ENDPOINTS).length, errors: [] };
  }

  console.log('[Rate] Fetching rates for', Object.keys(RATE_ENDPOINTS).length, 'currencies');
  let fetched = 0;
  const errors = [];

  for (const [currency, bankName] of Object.entries(RATE_ENDPOINTS)) {
    try {
      const result = await fetchRate(currency, bankName);
      if (result && result.ratePct != null) {
        rateCache[currency] = { ...result, ts: Date.now() };
        fetched++;
        console.log(`[Rate] ✓ ${currency} — ${result.ratePct}% (updated: ${result.lastUpdated})`);

        try {
          const { upsertRateData } = require('./db');
          upsertRateData(currency, result);
        } catch(e) { console.error(`[Rate] ${currency} DB write error:`, e.message); }
      } else {
        errors.push({ currency, error: 'no rate returned' });
      }

      await new Promise(r => setTimeout(r, 300));
    } catch(e) {
      errors.push({ currency, error: e.message });
      console.error(`[Rate] ✗ ${currency} error:`, e.message);
    }
  }

  console.log(`[Rate] Fetch complete — ${fetched}/${Object.keys(RATE_ENDPOINTS).length} currencies`);
  return { fetched, total: Object.keys(RATE_ENDPOINTS).length, errors };
}

// ── Get cached or DB rate for a currency ────────────────────────────────────
function getCurrencyRate(currency) {
  if (rateCache[currency]) return rateCache[currency];
  try {
    const { getRateData } = require('./db');
    const row = getRateData(currency);
    if (row) {
      rateCache[currency] = {
        ratePct:     row.rate_pct,
        lastUpdated: row.last_updated,
        ts:          row.ts
      };
      return rateCache[currency];
    }
  } catch(e) {}
  return null;
}

// ── Get all rates ───────────────────────────────────────────────────────────
function getLatestRates() {
  const rates = {};
  for (const currency of Object.keys(RATE_ENDPOINTS)) {
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
  const diffBps = Math.round(diffPct * 100); // basis points
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

  // Build summary
  const favoured = diffBps > 0 ? pair.base : pair.quote;
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

module.exports = { runRateFetch, getLatestRates, getRateDifferential };
