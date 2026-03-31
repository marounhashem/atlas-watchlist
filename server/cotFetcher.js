// COT (Commitment of Traders) Data Fetcher — CFTC weekly reports
// Fetches disaggregated futures positioning from CFTC Socrata SODA API
// Stored at CURRENCY level (EUR, GBP, JPY) not pair level (EURUSD, GBPUSD)
// Resolved to pair level on read via getLatestCOT(symbol)

// CFTC Socrata SODA API — Disaggregated Futures and Options Combined
// Dataset: jun7-fc8e (fut_disagg_pos_hist_2006_to_present)
const COT_API = 'https://publicreporting.cftc.gov/resource/jun7-fc8e.json';

// Map currency codes to CFTC market_and_exchange_names (exact match required)
// Verified against live API responses 2026-03-31
const COT_CURRENCIES = {
  EUR:    'EURO FX - CHICAGO MERCANTILE EXCHANGE',
  GBP:    'BRITISH POUND STERLING - CHICAGO MERCANTILE EXCHANGE',
  JPY:    'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE',
  CHF:    'SWISS FRANC - CHICAGO MERCANTILE EXCHANGE',
  CAD:    'CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  AUD:    'AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  NZD:    'NEW ZEALAND DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  GOLD:   'GOLD - COMMODITY EXCHANGE INC.',
  SILVER: 'SILVER - COMMODITY EXCHANGE INC.',
  OIL:    'WTI-PHYSICAL - NEW YORK MERCANTILE EXCHANGE'
};

// Map ATLAS pair symbols to their currency components
const PAIR_MAP = {
  // XXX/USD pairs — base has COT, USD does not
  EURUSD: { base: 'EUR', quote: null },
  GBPUSD: { base: 'GBP', quote: null },
  AUDUSD: { base: 'AUD', quote: null },
  NZDUSD: { base: 'NZD', quote: null },
  // USD/XXX pairs — quote has COT, interpretation is inverted
  USDJPY: { base: null, quote: 'JPY', inverted: true },
  USDCHF: { base: null, quote: 'CHF', inverted: true },
  USDCAD: { base: null, quote: 'CAD', inverted: true },
  // Crosses — both sides have COT
  EURGBP: { base: 'EUR', quote: 'GBP' },
  EURJPY: { base: 'EUR', quote: 'JPY' },
  EURAUD: { base: 'EUR', quote: 'AUD' },
  EURCHF: { base: 'EUR', quote: 'CHF' },
  GBPJPY: { base: 'GBP', quote: 'JPY' },
  GBPCHF: { base: 'GBP', quote: 'CHF' },
  AUDJPY: { base: 'AUD', quote: 'JPY' },
  // Commodities — direct mapping
  GOLD:   { base: 'GOLD',   quote: null },
  SILVER: { base: 'SILVER', quote: null },
  OILWTI: { base: 'OIL',    quote: null }
};

// In-memory cache of latest COT data per currency
const cotCache = {};

async function fetchCOTForCurrency(currency, contractName) {
  // SODA API: $where with single-quoted values, $order, $limit
  const url = `${COT_API}?$where=market_and_exchange_names='${encodeURIComponent(contractName)}'&$order=report_date_as_yyyy_mm_dd DESC&$limit=2`;
  console.log(`[COT] ${currency} fetching...`);

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

  console.log(`[COT] ${currency} HTTP ${res.status}`);

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    console.error(`[COT] ${currency} error body: ${body.slice(0, 300)}`);
    return null;
  }

  const data = await res.json();

  // SODA returns flat array or error object
  if (!Array.isArray(data)) {
    console.error(`[COT] ${currency} unexpected response:`, JSON.stringify(data).slice(0, 300));
    return null;
  }

  console.log(`[COT] ${currency} — API returned ${data.length} records`);

  if (data.length === 0) {
    console.log(`[COT] ${currency} — no records for "${contractName}"`);
    return null;
  }

  const r = data[0];
  console.log(`[COT] ${currency} date:${r.report_date_as_yyyy_mm_dd?.slice(0,10)} noncomm_long:${r.noncomm_positions_long_all} noncomm_short:${r.noncomm_positions_short_all}`);

  const noncommLong  = parseInt(r.noncomm_positions_long_all || 0);
  const noncommShort = parseInt(r.noncomm_positions_short_all || 0);
  const commLong     = parseInt(r.comm_positions_long_all || 0);
  const commShort    = parseInt(r.comm_positions_short_all || 0);
  const openInterest = parseInt(r.open_interest_all || 0);

  const netNonComm = noncommLong - noncommShort;
  const netComm    = commLong - commShort;

  // Weekly change from API's built-in change fields
  const changeLong  = parseInt(r.change_in_noncomm_long_all || 0);
  const changeShort = parseInt(r.change_in_noncomm_short_all || 0);
  const changeNetNonComm = changeLong - changeShort;

  let reportDate = r.report_date_as_yyyy_mm_dd || null;
  if (reportDate && reportDate.length > 10) reportDate = reportDate.slice(0, 10);

  return {
    reportDate,
    netNonComm,
    netComm,
    openInterest,
    changeNetNonComm,
    noncommLong,
    noncommShort,
    commLong,
    commShort
  };
}

async function runCOTFetch() {
  console.log('[COT] runCOTFetch() called — fetching', Object.keys(COT_CURRENCIES).length, 'currencies');
  let fetched = 0;
  const errors = [];

  try {
    for (const [currency, contractName] of Object.entries(COT_CURRENCIES)) {
      try {
        const result = await fetchCOTForCurrency(currency, contractName);
        if (result) {
          cotCache[currency] = { ...result, ts: Date.now() };
          fetched++;
          console.log(`[COT] ✓ ${currency} — date:${result.reportDate} net:${result.netNonComm > 0 ? '+' : ''}${result.netNonComm} Δ:${result.changeNetNonComm > 0 ? '+' : ''}${result.changeNetNonComm} OI:${result.openInterest}`);

          try {
            const { upsertCOTData } = require('./db');
            upsertCOTData(currency, result);
          } catch(e) { console.error(`[COT] ${currency} DB write error:`, e.message); }
        } else {
          errors.push({ currency, error: 'no data returned' });
        }

        await new Promise(r => setTimeout(r, 500));
      } catch(e) {
        errors.push({ currency, error: e.message });
        console.error(`[COT] ✗ ${currency} error:`, e.message);
      }
    }

    console.log(`[COT] Fetch complete — ${fetched}/${Object.keys(COT_CURRENCIES).length} currencies updated${errors.length ? ', ' + errors.length + ' errors' : ''}`);
  } catch(e) {
    console.error('[COT] FATAL fetch error:', e.message, e.stack);
    errors.push({ currency: 'FATAL', error: e.message });
  }

  return { fetched, total: Object.keys(COT_CURRENCIES).length, errors };
}

// ── Get raw COT data for a single currency ──────────────────────────────────
function getCurrencyCOT(currency) {
  if (cotCache[currency]) return cotCache[currency];
  try {
    const { getCOTData } = require('./db');
    const dbRow = getCOTData(currency);
    if (dbRow) {
      cotCache[currency] = {
        reportDate:       dbRow.report_date,
        netNonComm:       dbRow.net_noncomm,
        netComm:          dbRow.net_comm,
        openInterest:     dbRow.open_interest,
        changeNetNonComm: dbRow.change_net_noncomm,
        noncommLong:      dbRow.noncomm_long,
        noncommShort:     dbRow.noncomm_short,
        commLong:         dbRow.comm_long,
        commShort:        dbRow.comm_short,
        ts:               dbRow.ts
      };
      return cotCache[currency];
    }
  } catch(e) {}
  return null;
}

// ── Resolve ATLAS pair symbol to COT data ───────────────────────────────────
function getLatestCOT(symbol) {
  const mapping = PAIR_MAP[symbol];
  if (!mapping) return null;

  const baseCOT  = mapping.base  ? getCurrencyCOT(mapping.base)  : null;
  const quoteCOT = mapping.quote ? getCurrencyCOT(mapping.quote) : null;

  if (!baseCOT && !quoteCOT) return null;

  const primary = baseCOT || quoteCOT;
  return {
    base:       mapping.base,
    quote:      mapping.quote,
    inverted:   mapping.inverted || false,
    baseCOT,
    quoteCOT,
    reportDate:       primary.reportDate,
    netNonComm:       primary.netNonComm,
    netComm:          primary.netComm,
    openInterest:     primary.openInterest,
    changeNetNonComm: primary.changeNetNonComm,
    ts:               primary.ts
  };
}

// ── Format helpers ──────────────────────────────────────────────────────────
function fmtK(n) { return `${n > 0 ? '+' : ''}${Math.round(n / 1000)}k`; }
function fmtChangeK(n) { return `${n > 0 ? '↑' : '↓'}${Math.abs(Math.round(n / 1000))}k WoW`; }

function singleCurrencySummary(label, cot) {
  if (!cot) return null;
  const net = cot.netNonComm;
  const change = cot.changeNetNonComm;
  const side = net > 0 ? 'NET LONG' : 'NET SHORT';

  let assessment = 'moderate positioning';
  const absNet = Math.abs(net);
  if (absNet > 100000) {
    assessment = net > 0 ? 'extreme long, crowding risk' : 'extreme short, squeeze potential';
  } else if (absNet > 50000) {
    assessment = net > 0 ? 'elevated long, crowding risk' : 'elevated short, squeeze potential';
  }

  return `${label} specs ${side} ${fmtK(net)} (${fmtChangeK(change)}) — ${assessment}`;
}

// ── Public summary for an ATLAS pair symbol ─────────────────────────────────
function getCOTSummary(symbol) {
  const mapping = PAIR_MAP[symbol];
  if (!mapping) return null;

  const baseCOT  = mapping.base  ? getCurrencyCOT(mapping.base)  : null;
  const quoteCOT = mapping.quote ? getCurrencyCOT(mapping.quote) : null;

  if (!baseCOT && !quoteCOT) return null;

  // ── Commodities and simple XXX/USD pairs (only base has COT) ────────────
  if (baseCOT && !quoteCOT && !mapping.inverted) {
    return singleCurrencySummary(mapping.base, baseCOT);
  }

  // ── USD/XXX inverted pairs (only quote has COT) ─────────────────────────
  if (!baseCOT && quoteCOT && mapping.inverted) {
    const net = quoteCOT.netNonComm;
    const change = quoteCOT.changeNetNonComm;
    const side = net > 0 ? 'NET LONG' : 'NET SHORT';
    const pairBias = net > 0 ? `bearish ${symbol}` : `bullish ${symbol}`;
    return `${mapping.quote} specs ${side} ${fmtK(net)} (${fmtChangeK(change)}) — ${pairBias} (USD weakening vs ${mapping.quote})`;
  }

  // ── Crosses — both sides have COT ──────────────────────────────────────
  if (baseCOT && quoteCOT) {
    const basePart  = `${mapping.base} specs ${baseCOT.netNonComm > 0 ? 'NET LONG' : 'NET SHORT'} ${fmtK(baseCOT.netNonComm)} (${fmtChangeK(baseCOT.changeNetNonComm)})`;
    const quotePart = `${mapping.quote} specs ${quoteCOT.netNonComm > 0 ? 'NET LONG' : 'NET SHORT'} ${fmtK(quoteCOT.netNonComm)} (${fmtChangeK(quoteCOT.changeNetNonComm)})`;

    const baseBias  = baseCOT.netNonComm;
    const quoteBias = quoteCOT.netNonComm;
    let crossBias;
    if (baseBias > quoteBias + 10000) {
      crossBias = `${mapping.base} bias stronger, favours ${symbol} long`;
    } else if (quoteBias > baseBias + 10000) {
      crossBias = `${mapping.quote} bias stronger, favours ${symbol} short`;
    } else {
      crossBias = 'positioning roughly balanced';
    }

    return `${basePart} vs ${quotePart} — ${crossBias}`;
  }

  const available = baseCOT || quoteCOT;
  const label = baseCOT ? mapping.base : mapping.quote;
  return singleCurrencySummary(label, available);
}

function getCOTCurrencies() { return COT_CURRENCIES; }

module.exports = { runCOTFetch, getLatestCOT, getCOTSummary, getCOTCurrencies };
