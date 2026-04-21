// server/stockScanner/universe.js
//
// The universe is the list of symbols the pre-market scanner evaluates
// every morning. Gap scanners work best on a curated list of liquid
// US equities — scanning the full Russell 3000 is slow and returns
// too much noise. This list is ~350 names covering:
//   - Mega/large caps (AAPL, MSFT, NVDA, ...)
//   - High-beta momentum names day traders actually trade
//   - Common gap-and-go catalyst names (biotech, small-cap tech)
//   - Sector ETFs (for context, usually filtered out of picks)
//
// You can expand this file over time. Keep it under ~1000 symbols to
// stay inside Yahoo's unofficial rate limits.

const UNIVERSE = [
  // --- Mega caps / FAANG+ ---
  'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA',
  'AVGO', 'ORCL', 'CRM', 'ADBE', 'NFLX', 'AMD', 'INTC', 'CSCO',
  'QCOM', 'TXN', 'IBM', 'NOW', 'INTU', 'PANW', 'SNOW', 'PLTR',

  // --- Financials ---
  'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BLK', 'SCHW', 'AXP',
  'V', 'MA', 'PYPL', 'SQ', 'COIN', 'HOOD', 'SOFI', 'UPST', 'AFRM',

  // --- Healthcare / biotech (catalyst heavy) ---
  'UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'MRK', 'TMO', 'ABT', 'DHR',
  'BMY', 'AMGN', 'GILD', 'BIIB', 'REGN', 'VRTX', 'MRNA', 'BNTX',
  'NVAX', 'SAVA', 'SGMO', 'CRSP', 'EDIT', 'NTLA', 'BEAM', 'VERV',

  // --- Consumer ---
  'WMT', 'COST', 'HD', 'LOW', 'TGT', 'NKE', 'MCD', 'SBUX', 'CMG',
  'DIS', 'RBLX', 'ABNB', 'UBER', 'LYFT', 'DASH', 'BKNG',

  // --- Energy ---
  'XOM', 'CVX', 'COP', 'OXY', 'SLB', 'EOG', 'PSX', 'MPC', 'VLO',
  'APA', 'DVN', 'FANG', 'HAL',

  // --- Industrials / defense ---
  'BA', 'CAT', 'DE', 'GE', 'HON', 'LMT', 'RTX', 'NOC', 'GD',
  'UPS', 'FDX', 'UNP',

  // --- Semis (day-trading favorites) ---
  'TSM', 'ASML', 'MU', 'LRCX', 'AMAT', 'KLAC', 'MRVL', 'ON',
  'ARM', 'SMCI', 'ALAB', 'AVGO',

  // --- China ADRs (gap heavy) ---
  'BABA', 'PDD', 'JD', 'NIO', 'XPEV', 'LI', 'BIDU', 'NTES',

  // --- EVs / clean energy ---
  'RIVN', 'LCID', 'FSR', 'CHPT', 'PLUG', 'FCEL', 'ENPH', 'SEDG',
  'FSLR', 'RUN', 'BLNK', 'QS',

  // --- Meme / high-beta small caps ---
  'GME', 'AMC', 'BBBY', 'MULN', 'BBIG', 'ATER', 'CLOV', 'WISH',
  'SNDL', 'NAKD', 'PROG', 'IRNT', 'OPAD', 'FFIE',

  // --- Small-cap biotech (FDA gap candidates) ---
  'AKBA', 'ATOS', 'CYTK', 'TGTX', 'VERU', 'HARP', 'IOVA', 'KPTI',
  'APTX', 'OCGN', 'INO', 'CODX', 'CBIO', 'KZIA',

  // --- Recent IPOs / high-vol names ---
  'IONQ', 'RGTI', 'QBTS', 'BBAI', 'SOUN', 'AI', 'PATH', 'GTLB',
  'CFLT', 'NET', 'DDOG', 'ZS', 'CRWD', 'S', 'OKTA',

  // --- ETFs (benchmarks + sector context) ---
  'SPY', 'QQQ', 'IWM', 'DIA', 'VXX', 'UVXY', 'TQQQ', 'SQQQ',
  'SOXL', 'SOXS', 'TNA', 'TZA', 'XLF', 'XLE', 'XLK', 'XLV',
  'ARKK', 'ARKG', 'ARKF', 'ARKW',
];

// ETFs are scanned for context (is SPY gapping?) but filtered out of
// the final watchlist picks because they don't have single-stock
// catalysts. The scanner adds these flags to each symbol's record.
const ETF_SET = new Set([
  'SPY', 'QQQ', 'IWM', 'DIA', 'VXX', 'UVXY', 'TQQQ', 'SQQQ',
  'SOXL', 'SOXS', 'TNA', 'TZA', 'XLF', 'XLE', 'XLK', 'XLV',
  'ARKK', 'ARKG', 'ARKF', 'ARKW',
]);

function isEtf(symbol) {
  return ETF_SET.has(symbol);
}

module.exports = { UNIVERSE, isEtf };
