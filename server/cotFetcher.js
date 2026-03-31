// COT (Commitment of Traders) Data Fetcher — CFTC weekly reports
// Fetches disaggregated futures positioning from CFTC public API
// Stored at CURRENCY level (EUR, GBP, JPY) not pair level (EURUSD, GBPUSD)
// Resolved to pair level on read via getLatestCOT(symbol)

// CFTC public explore API — Disaggregated Futures Positions (2006-present)
const COT_BASE = 'https://publicreporting.cftc.gov/api/explore/dataset/fut_disagg_pos_hist_2006_to_present/records';

// Map currency codes to CFTC contract names — stored at currency level
const COT_CURRENCIES = {
  EUR:    'EURO FX - CHICAGO MERCANTILE EXCHANGE',
  GBP:    'BRITISH POUND - CHICAGO MERCANTILE EXCHANGE',
  JPY:    'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE',
  CHF:    'SWISS FRANC - CHICAGO MERCANTILE EXCHANGE',
  CAD:    'CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  AUD:    'AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  NZD:    'NEW ZEALAND DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  GOLD:   'GOLD - CHICAGO MERCANTILE EXCHANGE',
  SILVER: 'SILVER - CHICAGO MERCANTILE EXCHANGE',
  OIL:    'CRUDE OIL, LIGHT SWEET - ICE FUTURES EUROPE'
};

// Map ATLAS pair symbols to their currency components
// base: currency that is "bought" when going LONG on the pair
// quote: currency that is "sold" when going LONG on the pair
// inverted: if true, specs long on the quote currency = bearish for the pair
const PAIR_MAP = {
  // XXX/USD pairs — base has COT, USD does not
  EURUSD: { base: 'EUR', quote: null },
  GBPUSD: { base: 'GBP', quote: null },
  AUDUSD: { base: 'AUD', quote: null },
  NZDUSD: { base: 'NZD', quote: null },
  // USD/XXX pairs — quote has COT, interpretation is inverted
  // specs long JPY = bearish USDJPY
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
const cotCache = {}; // { currency: { netNonComm, netComm, ... , ts } }

async function fetchCOTForCurrency(currency, contractName) {
  // CFTC explore API: refine= for filtering, order_by= for sorting
  const url = `${COT_BASE}?limit=2&order_by=report_date_as_yyyy_mm_dd+desc&refine=market_and_exchange_names=${encodeURIComponent(contractName)}`;
  console.log(`[COT] ${currency} fetching: ${url.slice(0, 250)}`);

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

  console.log(`[COT] ${currency} HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    console.error(`[COT] ${currency} error body: ${body.slice(0, 500)}`);
    return null;
  }

  const data = await res.json();
  // Explore API returns { total_count, records: [{ record: { fields: {...} } }] }
  const records = data.records || data.results || [];
  console.log(`[COT] ${currency} total_count: ${data.total_count} records: ${records.length}`);

  if (records.length === 0) {
    console.log(`[COT] ${currency} — no records found for "${contractName}"`);
    return null;
  }

  // Extract fields — explore API nests under record.fields
  const f = records[0].record?.fields || records[0].fields || records[0];
  console.log(`[COT] ${currency} date: ${f.report_date_as_yyyy_mm_dd} noncomm_long: ${f.noncomm_positions_long_all} noncomm_short: ${f.noncomm_positions_short_all}`);

  const noncommLong  = parseInt(f.noncomm_positions_long_all || 0);
  const noncommShort = parseInt(f.noncomm_positions_short_all || 0);
  const commLong     = parseInt(f.comm_positions_long_all || 0);
  const commShort    = parseInt(f.comm_positions_short_all || 0);
  const openInterest = parseInt(f.open_interest_all || 0);

  const netNonComm = noncommLong - noncommShort;
  const netComm    = commLong - commShort;

  // Weekly change: use the API's built-in change fields (this week vs last week)
  // changeNetNonComm = change_in_noncomm_long - change_in_noncomm_short
  const changeLong  = parseInt(f.change_in_noncomm_long_all || 0);
  const changeShort = parseInt(f.change_in_noncomm_short_all || 0);
  const changeNetNonComm = changeLong - changeShort;

  // Extract report date — may be ISO timestamp or date string
  let reportDate = f.report_date_as_yyyy_mm_dd || null;
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
  console.log('[COT] runCOTFetch() called — starting fetch for', Object.keys(COT_CURRENCIES).length, 'currencies');
  let fetched = 0;
  const errors = [];

  try {
    for (const [currency, contractName] of Object.entries(COT_CURRENCIES)) {
      try {
        const result = await fetchCOTForCurrency(currency, contractName);
        if (result) {
          cotCache[currency] = { ...result, ts: Date.now() };
          fetched++;
          console.log(`[COT] ${currency} — date:${result.reportDate} netNonComm:${result.netNonComm > 0 ? '+' : ''}${result.netNonComm} change:${result.changeNetNonComm > 0 ? '+' : ''}${result.changeNetNonComm} OI:${result.openInterest}`);

          // Persist to DB keyed by currency code
          try {
            const { upsertCOTData } = require('./db');
            upsertCOTData(currency, result);
          } catch(e) { console.error(`[COT] ${currency} DB write error:`, e.message); }
        } else {
          errors.push({ currency, error: 'no data returned' });
          console.log(`[COT] ${currency} — no data returned`);
        }

        await new Promise(r => setTimeout(r, 500));
      } catch(e) {
        errors.push({ currency, error: e.message });
        console.error(`[COT] ${currency} error:`, e.message);
      }
    }

    console.log(`[COT] Fetch complete — ${fetched}/${Object.keys(COT_CURRENCIES).length} currencies updated`);
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
// Returns { base, quote, baseCOT, quoteCOT, inverted } or null
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
