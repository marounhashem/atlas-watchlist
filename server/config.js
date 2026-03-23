const SYMBOLS = {
  GOLD: {
    label: 'Gold',
    capitalTicker: 'GOLD',
    pineTicker: 'XAUUSD',
    assetClass: 'commodity',
    sessions: { london: true, newYork: true, asia: false },
    peakSession: 'london',
    scoringWeights: {
      pineBias: 0.30,
      fxssiSentiment: 0.30,
      orderBook: 0.25,
      sessionQuality: 0.15
    },
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
    scoringWeights: {
      pineBias: 0.28,
      fxssiSentiment: 0.32,
      orderBook: 0.25,
      sessionQuality: 0.15
    },
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
    scoringWeights: {
      pineBias: 0.32,
      fxssiSentiment: 0.20,
      orderBook: 0.28,
      sessionQuality: 0.20
    },
    macroEvents: ['EIA_CRUDE', 'OPEC', 'API_REPORT'],
    macroBlockWindow: 60,
    minScoreProceed: 70
  },
  BTCUSD: {
    label: 'Bitcoin',
    capitalTicker: 'BTCUSD',
    pineTicker: 'BTCUSD',
    assetClass: 'crypto',
    sessions: { london: true, newYork: true, asia: true },
    peakSession: 'newYork',
    scoringWeights: {
      pineBias: 0.40,
      fxssiSentiment: 0.15,
      orderBook: 0.30,
      sessionQuality: 0.15
    },
    macroEvents: ['FOMC'],
    minScoreProceed: 68
  },
  US500: {
    label: 'S&P 500',
    capitalTicker: 'US500',
    pineTicker: 'SPX500USD',
    assetClass: 'index',
    sessions: { london: false, newYork: true, asia: false },
    peakSession: 'newYork',
    scoringWeights: {
      pineBias: 0.35,
      fxssiSentiment: 0.15,
      orderBook: 0.20,
      sessionQuality: 0.30
    },
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
    scoringWeights: {
      pineBias: 0.35,
      fxssiSentiment: 0.15,
      orderBook: 0.20,
      sessionQuality: 0.30
    },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'EARNINGS'],
    minScoreProceed: 70
  },
  US30: {
    label: 'Dow Jones',
    capitalTicker: 'US30',
    pineTicker: 'US30USD',
    assetClass: 'index',
    sessions: { london: false, newYork: true, asia: false },
    peakSession: 'newYork',
    scoringWeights: {
      pineBias: 0.35,
      fxssiSentiment: 0.15,
      orderBook: 0.20,
      sessionQuality: 0.30
    },
    macroEvents: ['FOMC', 'CPI', 'NFP', 'EARNINGS'],
    minScoreProceed: 70
  },
  DE40: {
    label: 'DAX 40',
    capitalTicker: 'DE40',
    pineTicker: 'DE30EUR',
    assetClass: 'index',
    sessions: { london: true, newYork: false, asia: false },
    peakSession: 'london',
    scoringWeights: {
      pineBias: 0.38,
      fxssiSentiment: 0.12,
      orderBook: 0.20,
      sessionQuality: 0.30
    },
    macroEvents: ['ECB', 'CPI_EU', 'PMI_EU'],
    minScoreProceed: 70
  },
  UK100: {
    label: 'FTSE 100',
    capitalTicker: 'UK100',
    pineTicker: 'UK100GBP',
    assetClass: 'index',
    sessions: { london: true, newYork: false, asia: false },
    peakSession: 'london',
    scoringWeights: {
      pineBias: 0.38,
      fxssiSentiment: 0.12,
      orderBook: 0.20,
      sessionQuality: 0.30
    },
    macroEvents: ['BOE', 'CPI_UK', 'PMI_UK'],
    minScoreProceed: 70
  },
  J225: {
    label: 'Nikkei 225',
    capitalTicker: 'J225',
    pineTicker: 'JP225USD',
    assetClass: 'index',
    sessions: { london: false, newYork: false, asia: true },
    peakSession: 'asia',
    scoringWeights: {
      pineBias: 0.40,
      fxssiSentiment: 0.10,
      orderBook: 0.20,
      sessionQuality: 0.30
    },
    macroEvents: ['BOJ', 'TANKAN', 'CPI_JP'],
    minScoreProceed: 68
  },
  HK50: {
    label: 'Hang Seng',
    capitalTicker: 'HK50',
    pineTicker: 'HK50USD',
    assetClass: 'index',
    sessions: { london: false, newYork: false, asia: true },
    peakSession: 'asia',
    scoringWeights: {
      pineBias: 0.40,
      fxssiSentiment: 0.10,
      orderBook: 0.20,
      sessionQuality: 0.30
    },
    macroEvents: ['PBOC', 'CPI_CN', 'PMI_CN'],
    minScoreProceed: 68
  },
  CN50: {
    label: 'China A50',
    capitalTicker: 'CN50',
    pineTicker: 'CN50USD',
    assetClass: 'index',
    sessions: { london: false, newYork: false, asia: true },
    peakSession: 'asia',
    scoringWeights: {
      pineBias: 0.40,
      fxssiSentiment: 0.10,
      orderBook: 0.20,
      sessionQuality: 0.30
    },
    macroEvents: ['PBOC', 'CPI_CN', 'PMI_CN'],
    minScoreProceed: 68
  }
};

// UAE = UTC+4
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
