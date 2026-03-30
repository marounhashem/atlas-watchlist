const SYMBOLS = {
  GOLD: {
    label: 'Gold',
    capitalTicker: 'GOLD',
    pineTicker: 'XAUUSD',
    assetClass: 'commodity',
    sessions: { london: true, newYork: true, asia: false },
    peakSession: 'london',
    scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'DXY'],
    minScoreProceed: 78
  },
  SILVER: {
    label: 'Silver',
    capitalTicker: 'SILVER',
    pineTicker: 'XAGUSD',
    assetClass: 'commodity',
    sessions: { london: true, newYork: true, asia: false },
    peakSession: 'london',
    scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'DXY'],
    minScoreProceed: 78
  },
  OILWTI: {
    label: 'Oil WTI',
    capitalTicker: 'OIL_CRUDE',
    pineTicker: 'USOIL',
    assetClass: 'commodity',
    sessions: { london: true, newYork: true, asia: false },
    peakSession: 'newYork',
    scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['EIA_CRUDE', 'OPEC', 'API_REPORT'],
    minScoreProceed: 78
  },
  BTCUSD: {
    label: 'Bitcoin',
    capitalTicker: 'BTCUSD',
    pineTicker: 'BTCUSD',
    assetClass: 'crypto',
    sessions: { london: true, newYork: true, asia: true },
    peakSession: 'newYork',
    scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC'],
    minScoreProceed: 78
  },
  US30: {
    label: 'Dow Jones',
    capitalTicker: 'US30',
    pineTicker: 'US30USD',
    assetClass: 'index',
    sessions: { london: false, newYork: true, asia: false },
    peakSession: 'newYork',
    scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'EARNINGS'],
    minScoreProceed: 78
  },
  US100: {
    label: 'Nasdaq 100',
    capitalTicker: 'US100',
    pineTicker: 'NAS100USD',
    assetClass: 'index',
    sessions: { london: false, newYork: true, asia: false },
    peakSession: 'newYork',
    scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'EARNINGS'],
    minScoreProceed: 78
  },
  // ── Forex pairs ─────────────────────────────────────────────────────────────
  EURUSD: {
    label: 'EUR/USD', capitalTicker: 'EURUSD', pineTicker: 'EURUSD',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'london', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC','ECB','CPI','NFP'], minScoreProceed: 78
  },
  GBPUSD: {
    label: 'GBP/USD', capitalTicker: 'GBPUSD', pineTicker: 'GBPUSD',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'london', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC','BOE','CPI','NFP'], minScoreProceed: 78
  },
  USDJPY: {
    label: 'USD/JPY', capitalTicker: 'USDJPY', pineTicker: 'USDJPY',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'asia', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC','BOJ','CPI','NFP'], minScoreProceed: 78
  },
  USDCHF: {
    label: 'USD/CHF', capitalTicker: 'USDCHF', pineTicker: 'USDCHF',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: false },
    peakSession: 'london', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC','SNB','CPI','NFP'], minScoreProceed: 78
  },
  USDCAD: {
    label: 'USD/CAD', capitalTicker: 'USDCAD', pineTicker: 'USDCAD',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: false },
    peakSession: 'newYork', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC','BOC','OIL','NFP'], minScoreProceed: 78
  },
  AUDUSD: {
    label: 'AUD/USD', capitalTicker: 'AUDUSD', pineTicker: 'AUDUSD',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'asia', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC','RBA','CPI','CHINA'], minScoreProceed: 78
  },
  NZDUSD: {
    label: 'NZD/USD', capitalTicker: 'NZDUSD', pineTicker: 'NZDUSD',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'asia', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC','RBNZ','CPI'], minScoreProceed: 78
  },
  EURJPY: {
    label: 'EUR/JPY', capitalTicker: 'EURJPY', pineTicker: 'EURJPY',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'london', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['ECB','BOJ','CPI'], minScoreProceed: 78
  },
  EURGBP: {
    label: 'EUR/GBP', capitalTicker: 'EURGBP', pineTicker: 'EURGBP',
    assetClass: 'forex', sessions: { london: true, newYork: false, asia: false },
    peakSession: 'london', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['ECB','BOE','CPI'], minScoreProceed: 78
  },
  EURAUD: {
    label: 'EUR/AUD', capitalTicker: 'EURAUD', pineTicker: 'EURAUD',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'london', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['ECB','RBA','CPI'], minScoreProceed: 78
  },
  EURCHF: {
    label: 'EUR/CHF', capitalTicker: 'EURCHF', pineTicker: 'EURCHF',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: false },
    peakSession: 'london', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['ECB','SNB'], minScoreProceed: 78
  },
  GBPJPY: {
    label: 'GBP/JPY', capitalTicker: 'GBPJPY', pineTicker: 'GBPJPY',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'london', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['BOE','BOJ','CPI'], minScoreProceed: 78
  },
  GBPCHF: {
    label: 'GBP/CHF', capitalTicker: 'GBPCHF', pineTicker: 'GBPCHF',
    assetClass: 'forex', sessions: { london: true, newYork: false, asia: false },
    peakSession: 'london', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['BOE','SNB'], minScoreProceed: 78
  },
  AUDJPY: {
    label: 'AUD/JPY', capitalTicker: 'AUDJPY', pineTicker: 'AUDJPY',
    assetClass: 'forex', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'asia', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['RBA','BOJ'], minScoreProceed: 78
  },
  ETHUSD: {
    label: 'ETH/USD', capitalTicker: 'ETHUSD', pineTicker: 'ETHUSD',
    assetClass: 'crypto', sessions: { london: true, newYork: true, asia: true },
    peakSession: 'newYork', scoringWeights: { pine: 0.40, fxssi: 0.45, session: 0.15 },
    macroEvents: ['FOMC'], minScoreProceed: 78
  },
};

function getSessionNow() {
  const uaeHour = new Date(Date.now() + 4 * 3600000).getUTCHours();
  // NewYork checked first — takes priority during 17-19 UAE overlap with London
  if (uaeHour >= 17 && uaeHour < 25) return 'newYork';
  if (uaeHour >= 11 && uaeHour < 19) return 'london';
  if (uaeHour >= 2  && uaeHour < 10) return 'asia';
  return 'offHours';
}

function sessionMultiplier(symbol) {
  const session = getSessionNow();
  const cfg = SYMBOLS[symbol];
  if (!cfg) return 0.5;
  if (session === 'offHours') return 0.4;
  if (session === cfg.peakSession) return 1.0;
  if (cfg.sessions[session]) return 0.75;
  return 0.35;
}

module.exports = { SYMBOLS, getSessionNow, sessionMultiplier };
