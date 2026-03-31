// COT (Commitment of Traders) Data Fetcher — CFTC weekly reports
// Fetches disaggregated futures positioning from CFTC public API
// Stored at CURRENCY level (EUR, GBP, JPY) not pair level (EURUSD, GBPUSD)
// Resolved to pair level on read via getLatestCOT(symbol)

const COT_API = 'https://publicreporting.cftc.gov/api/explore/v2.1/catalog/datasets/fut_disagg_txt_hist_2006_2016/records';

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
  const where = `market_and_exchange_names = "${contractName}"`;
  const url = `${COT_API}?where=${encodeURIComponent(where)}&order_by=report_date_as_yyyy_mm_dd DESC&limit=2`;
  console.log(`[COT] ${currency} fetching: ${url}`);

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
  const topKeys = Object.keys(data);
  const records = data.results || data.records || [];
  console.log(`[COT] ${currency} response keys: [${topKeys.join(',')}] records: ${records.length}`);

  if (records.length > 0) {
    console.log(`[COT] ${currency} first record keys: [${Object.keys(records[0]).join(',')}]`);
    console.log(`[COT] ${currency} first record sample: ${JSON.stringify(records[0]).slice(0, 400)}`);
  }

  if (records.length === 0) {
    console.log(`[COT] ${currency} — no records found for "${contractName}"`);
    return null;
  }

  function parseRecord(r) {
    const f = r.fields || r;
    return {
      reportDate:     f.report_date_as_yyyy_mm_dd || f.report_date || null,
      noncommLong:    parseInt(f.noncomm_positions_long_all || f.ncomm_positions_long_all || 0),
      noncommShort:   parseInt(f.noncomm_positions_short_all || f.ncomm_positions_short_all || 0),
      commLong:       parseInt(f.comm_positions_long_all || 0),
      commShort:      parseInt(f.comm_positions_short_all || 0),
      openInterest:   parseInt(f.open_interest_all || f.oi_all || 0)
    };
  }

  const current  = parseRecord(records[0]);
  const previous = records.length > 1 ? parseRecord(records[1]) : null;

  const netNonComm = current.noncommLong - current.noncommShort;
  const netComm    = current.commLong - current.commShort;
  const changeNetNonComm = previous
    ? netNonComm - (previous.noncommLong - previous.noncommShort)
    : 0;

  return {
    reportDate: current.reportDate,
    netNonComm,
    netComm,
    openInterest: current.openInterest,
    changeNetNonComm,
    noncommLong:  current.noncommLong,
    noncommShort: current.noncommShort,
    commLong:     current.commLong,
    commShort:    current.commShort
  };
}

async function runCOTFetch() {
  console.log('[COT] Starting weekly COT data fetch...');
  let fetched = 0;

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
        } catch(e) {}
      } else {
        console.log(`[COT] ${currency} — no data returned`);
      }

      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.error(`[COT] ${currency} error:`, e.message);
    }
  }

  console.log(`[COT] Fetch complete — ${fetched}/${Object.keys(COT_CURRENCIES).length} currencies updated`);
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

  // For simple pairs (one side only), return that side's data directly
  // For inverted pairs (USDJPY etc), the caller sees the raw data but
  // getCOTSummary handles the interpretation flip
  const primary = baseCOT || quoteCOT;
  return {
    base:       mapping.base,
    quote:      mapping.quote,
    inverted:   mapping.inverted || false,
    baseCOT,
    quoteCOT,
    // Convenience fields from the primary (or only) currency
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
  // Specs long JPY = bearish USDJPY, so invert the interpretation
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

    // Compare net positioning to determine pair bias
    // For a cross: base stronger than quote = bullish for the pair
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

  // Fallback: one side only on a cross (shouldn't happen but handle gracefully)
  const available = baseCOT || quoteCOT;
  const label = baseCOT ? mapping.base : mapping.quote;
  return singleCurrencySummary(label, available);
}

function getCOTCurrencies() { return COT_CURRENCIES; }

module.exports = { runCOTFetch, getLatestCOT, getCOTSummary, getCOTCurrencies };
