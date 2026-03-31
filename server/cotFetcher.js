// COT (Commitment of Traders) Data Fetcher — CFTC weekly reports
// Fetches disaggregated futures positioning from CFTC public API
// Used by macro context to show institutional positioning

const COT_API = 'https://publicreporting.cftc.gov/api/explore/v2.1/catalog/datasets/fut_disagg_txt_hist_2006_2016/records';

// Map ATLAS symbols to CFTC contract market names
const COT_SYMBOLS = {
  GOLD:   'GOLD - COMMODITY EXCHANGE INC.',
  SILVER: 'SILVER - COMMODITY EXCHANGE INC.',
  OILWTI: 'CRUDE OIL, LIGHT SWEET - NEW YORK MERCANTILE EXCHANGE',
  EURUSD: 'EURO FX - CHICAGO MERCANTILE EXCHANGE',
  GBPUSD: 'BRITISH POUND STERLING - CHICAGO MERCANTILE EXCHANGE',
  USDJPY: 'JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE',
  USDCHF: 'SWISS FRANC - CHICAGO MERCANTILE EXCHANGE',
  USDCAD: 'CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  AUDUSD: 'AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE',
  NZDUSD: 'NEW ZEALAND DOLLAR - CHICAGO MERCANTILE EXCHANGE'
};

// In-memory cache of latest COT data per symbol
const cotCache = {}; // { symbol: { current, previous, summary, ts } }

async function fetchCOTForSymbol(symbol, contractName) {
  const where = `market_and_exchange_names = "${contractName}"`;
  const url = `${COT_API}?where=${encodeURIComponent(where)}&order_by=report_date_as_yyyy_mm_dd DESC&limit=2`;

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

  if (!res.ok) {
    console.error(`[COT] ${symbol} HTTP ${res.status}`);
    return null;
  }

  const data = await res.json();
  const records = data.results || data.records || [];

  if (records.length === 0) {
    console.log(`[COT] ${symbol} — no records found for "${contractName}"`);
    return null;
  }

  function parseRecord(r) {
    // Handle both flat and nested field structures
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

  for (const [symbol, contractName] of Object.entries(COT_SYMBOLS)) {
    try {
      const result = await fetchCOTForSymbol(symbol, contractName);
      if (result) {
        cotCache[symbol] = { ...result, ts: Date.now() };
        fetched++;
        console.log(`[COT] ${symbol} — date:${result.reportDate} netNonComm:${result.netNonComm > 0 ? '+' : ''}${result.netNonComm} change:${result.changeNetNonComm > 0 ? '+' : ''}${result.changeNetNonComm} OI:${result.openInterest}`);

        // Persist to DB if available
        try {
          const { upsertCOTData } = require('./db');
          upsertCOTData(symbol, result);
        } catch(e) {}
      } else {
        console.log(`[COT] ${symbol} — no data returned`);
      }

      // 500ms delay between symbols to be polite to CFTC API
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.error(`[COT] ${symbol} error:`, e.message);
    }
  }

  console.log(`[COT] Fetch complete — ${fetched}/${Object.keys(COT_SYMBOLS).length} symbols updated`);
}

function getLatestCOT(symbol) {
  // Try cache first, then DB
  if (cotCache[symbol]) return cotCache[symbol];
  try {
    const { getCOTData } = require('./db');
    const dbRow = getCOTData(symbol);
    if (dbRow) {
      cotCache[symbol] = {
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
      return cotCache[symbol];
    }
  } catch(e) {}
  return null;
}

function getCOTSummary(symbol) {
  const cot = getLatestCOT(symbol);
  if (!cot) return null;

  const net = cot.netNonComm;
  const change = cot.changeNetNonComm;
  const absNet = Math.abs(net);
  const absChange = Math.abs(change);

  // Format numbers as k (thousands)
  const netStr = `${net > 0 ? '+' : ''}${Math.round(net / 1000)}k`;
  const changeStr = `${change > 0 ? 'up' : 'down'} ${change > 0 ? '+' : ''}${Math.round(change / 1000)}k WoW`;
  const side = net > 0 ? 'NET LONG' : 'NET SHORT';

  // Assess positioning extremity
  let assessment;
  if (absNet > 100000) {
    assessment = net > 0
      ? 'extreme long positioning, crowding/mean-reversion risk'
      : 'extreme short positioning, potential squeeze';
  } else if (absNet > 50000) {
    assessment = net > 0
      ? 'elevated long positioning, crowding risk'
      : 'elevated short positioning, squeeze potential';
  } else {
    assessment = 'moderate positioning';
  }

  // Add momentum note if change is significant
  let momentum = '';
  if (absChange > 10000) {
    momentum = change > 0 ? ' — specs adding longs aggressively' : ' — specs liquidating / adding shorts';
  }

  return `Specs ${side} ${netStr} (${changeStr}) — ${assessment}${momentum}`;
}

function getCOTSymbols() { return COT_SYMBOLS; }

module.exports = { runCOTFetch, getLatestCOT, getCOTSummary, getCOTSymbols };
