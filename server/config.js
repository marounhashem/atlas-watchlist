const SYMBOLS = {
  GOLD: {
    label: 'Gold',
    capitalTicker: 'GOLD',
    pineTicker: 'XAUUSD',
    assetClass: 'commodity',
    sessions: { london: true, newYork: true, asia: false },
    peakSession: 'london',
    scoringWeights: { pineBias: 0.30, fxssiSentiment: 0.35, orderBook: 0.20, sessionQuality: 0.15 },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'DXY'],
    minScoreProceed: 72
  },
  SILVER: {
    label: 'Silver',
    capitalTicker: 'SILVER',
    pineTicker: 'XAGUSD',
    assetClass: 'commodity',
    sessions: { london: true, newYork: true, asia: false },
    peakSession: 'london',
    scoringWeights: { pineBias: 0.28, fxssiSentiment: 0.37, orderBook: 0.20, sessionQuality: 0.15 },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'DXY'],
    minScoreProceed: 72
  },
  OILWTI: {
    label: 'Oil WTI',
    capitalTicker: 'OIL_CRUDE',
    pineTicker: 'USOIL',
    assetClass: 'commodity',
    sessions: { london: true, newYork: true, asia: false },
    peakSession: 'newYork',
    scoringWeights: { pineBias: 0.32, fxssiSentiment: 0.28, orderBook: 0.25, sessionQuality: 0.15 },
    macroEvents: ['EIA_CRUDE', 'OPEC', 'API_REPORT'],
    minScoreProceed: 70
  },
  BTCUSD: {
    label: 'Bitcoin',
    capitalTicker: 'BTCUSD',
    pineTicker: 'BTCUSD',
    assetClass: 'crypto',
    sessions: { london: true, newYork: true, asia: true },
    peakSession: 'newYork',
    scoringWeights: { pineBias: 0.35, fxssiSentiment: 0.25, orderBook: 0.25, sessionQuality: 0.15 },
    macroEvents: ['FOMC'],
    minScoreProceed: 68
  },
  US30: {
    label: 'Dow Jones',
    capitalTicker: 'US30',
    pineTicker: 'US30USD',
    assetClass: 'index',
    sessions: { london: false, newYork: true, asia: false },
    peakSession: 'newYork',
    scoringWeights: { pineBias: 0.35, fxssiSentiment: 0.25, orderBook: 0.15, sessionQuality: 0.25 },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'EARNINGS'],
    minScoreProceed: 70
  },
  US100: {
    label: 'Nasdaq 100',
    capitalTicker: 'US100',
    pineTicker: 'NAS100USD',
    assetClass: 'index',
    sessions: { london: false, newYork: true, asia: false },
    peakSession: 'newYork',
    scoringWeights: { pineBias: 0.35, fxssiSentiment: 0.25, orderBook: 0.15, sessionQuality: 0.25 },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'EARNINGS'],
    minScoreProceed: 70
  }
};

function getSessionNow() {
  const uaeHour = new Date(Date.now() + 4 * 3600000).getUTCHours();
  if (uaeHour >= 2 && uaeHour < 10) return 'asia';
  if (uaeHour >= 11 && uaeHour < 19) return 'london';
  if (uaeHour >= 17 && uaeHour < 25) return 'newYork';
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
