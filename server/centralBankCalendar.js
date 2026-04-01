// Central Bank Meeting Calendar — event risk gates + forward guidance scoring
// Hardcoded 2026 meeting dates, consensus fetched via Claude web search

const MEETING_CALENDAR = [
  // Fed (FOMC)
  { currency: 'USD', bank: 'Fed', date: '2026-05-01' },
  { currency: 'USD', bank: 'Fed', date: '2026-06-12' },
  { currency: 'USD', bank: 'Fed', date: '2026-07-31' },
  { currency: 'USD', bank: 'Fed', date: '2026-09-18' },
  { currency: 'USD', bank: 'Fed', date: '2026-11-07' },
  { currency: 'USD', bank: 'Fed', date: '2026-12-18' },

  // ECB
  { currency: 'EUR', bank: 'ECB', date: '2026-04-17' },
  { currency: 'EUR', bank: 'ECB', date: '2026-06-05' },
  { currency: 'EUR', bank: 'ECB', date: '2026-07-23' },
  { currency: 'EUR', bank: 'ECB', date: '2026-09-10' },
  { currency: 'EUR', bank: 'ECB', date: '2026-10-29' },
  { currency: 'EUR', bank: 'ECB', date: '2026-12-17' },

  // BOE
  { currency: 'GBP', bank: 'BOE', date: '2026-05-09' },
  { currency: 'GBP', bank: 'BOE', date: '2026-06-20' },
  { currency: 'GBP', bank: 'BOE', date: '2026-08-01' },
  { currency: 'GBP', bank: 'BOE', date: '2026-09-19' },
  { currency: 'GBP', bank: 'BOE', date: '2026-11-07' },
  { currency: 'GBP', bank: 'BOE', date: '2026-12-19' },

  // BOJ
  { currency: 'JPY', bank: 'BOJ', date: '2026-04-30' },
  { currency: 'JPY', bank: 'BOJ', date: '2026-06-16' },
  { currency: 'JPY', bank: 'BOJ', date: '2026-07-28' },
  { currency: 'JPY', bank: 'BOJ', date: '2026-09-18' },
  { currency: 'JPY', bank: 'BOJ', date: '2026-10-28' },
  { currency: 'JPY', bank: 'BOJ', date: '2026-12-18' },

  // RBA
  { currency: 'AUD', bank: 'RBA', date: '2026-04-07' },
  { currency: 'AUD', bank: 'RBA', date: '2026-05-19' },
  { currency: 'AUD', bank: 'RBA', date: '2026-07-07' },
  { currency: 'AUD', bank: 'RBA', date: '2026-08-18' },
  { currency: 'AUD', bank: 'RBA', date: '2026-09-29' },
  { currency: 'AUD', bank: 'RBA', date: '2026-11-03' },
  { currency: 'AUD', bank: 'RBA', date: '2026-12-08' },

  // RBNZ
  { currency: 'NZD', bank: 'RBNZ', date: '2026-04-09' },
  { currency: 'NZD', bank: 'RBNZ', date: '2026-05-27' },
  { currency: 'NZD', bank: 'RBNZ', date: '2026-07-08' },
  { currency: 'NZD', bank: 'RBNZ', date: '2026-08-26' },
  { currency: 'NZD', bank: 'RBNZ', date: '2026-10-07' },
  { currency: 'NZD', bank: 'RBNZ', date: '2026-11-25' },

  // BOC
  { currency: 'CAD', bank: 'BOC', date: '2026-04-16' },
  { currency: 'CAD', bank: 'BOC', date: '2026-06-04' },
  { currency: 'CAD', bank: 'BOC', date: '2026-07-15' },
  { currency: 'CAD', bank: 'BOC', date: '2026-09-09' },
  { currency: 'CAD', bank: 'BOC', date: '2026-10-28' },
  { currency: 'CAD', bank: 'BOC', date: '2026-12-09' },

  // SNB (quarterly)
  { currency: 'CHF', bank: 'SNB', date: '2026-06-18' },
  { currency: 'CHF', bank: 'SNB', date: '2026-09-24' },
  { currency: 'CHF', bank: 'SNB', date: '2026-12-17' },

  // ── Major US economic events ──────────────────────────────────────────────
  // NFP — first Friday of every month
  { currency: 'USD', bank: 'NFP', date: '2026-04-03', isEconomicEvent: true },
  { currency: 'USD', bank: 'NFP', date: '2026-05-01', isEconomicEvent: true },
  { currency: 'USD', bank: 'NFP', date: '2026-06-05', isEconomicEvent: true },
  { currency: 'USD', bank: 'NFP', date: '2026-07-02', isEconomicEvent: true },
  { currency: 'USD', bank: 'NFP', date: '2026-08-07', isEconomicEvent: true },
  { currency: 'USD', bank: 'NFP', date: '2026-09-04', isEconomicEvent: true },
  { currency: 'USD', bank: 'NFP', date: '2026-10-02', isEconomicEvent: true },
  { currency: 'USD', bank: 'NFP', date: '2026-11-06', isEconomicEvent: true },
  { currency: 'USD', bank: 'NFP', date: '2026-12-04', isEconomicEvent: true },

  // CPI — typically mid-month
  { currency: 'USD', bank: 'CPI', date: '2026-04-10', isEconomicEvent: true },
  { currency: 'USD', bank: 'CPI', date: '2026-05-12', isEconomicEvent: true },
  { currency: 'USD', bank: 'CPI', date: '2026-06-10', isEconomicEvent: true },
  { currency: 'USD', bank: 'CPI', date: '2026-07-14', isEconomicEvent: true },
  { currency: 'USD', bank: 'CPI', date: '2026-08-12', isEconomicEvent: true },
  { currency: 'USD', bank: 'CPI', date: '2026-09-11', isEconomicEvent: true },
  { currency: 'USD', bank: 'CPI', date: '2026-10-13', isEconomicEvent: true },
  { currency: 'USD', bank: 'CPI', date: '2026-11-10', isEconomicEvent: true },
  { currency: 'USD', bank: 'CPI', date: '2026-12-10', isEconomicEvent: true },
];

// Map ATLAS pair symbols → affected currencies
const PAIR_CURRENCIES = {
  EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'], USDJPY: ['USD', 'JPY'],
  USDCHF: ['USD', 'CHF'], USDCAD: ['USD', 'CAD'], AUDUSD: ['AUD', 'USD'],
  NZDUSD: ['NZD', 'USD'], EURGBP: ['EUR', 'GBP'], EURJPY: ['EUR', 'JPY'],
  EURAUD: ['EUR', 'AUD'], EURCHF: ['EUR', 'CHF'], GBPJPY: ['GBP', 'JPY'],
  GBPCHF: ['GBP', 'CHF'], AUDJPY: ['AUD', 'JPY'],
  GOLD: ['USD'], SILVER: ['USD'], OILWTI: ['USD'],
  BTCUSD: ['USD'], ETHUSD: ['USD'], US30: ['USD'], US100: ['USD']
};

// Which direction benefits from a currency strengthening?
// LONG EURUSD benefits from EUR strengthening; SHORT EURUSD benefits from EUR weakening
// For USD-quote pairs: HIKE USD → bearish for XXX/USD (favours SHORT)
const CURRENCY_DIRECTION = {
  EURUSD: { EUR: 'LONG',  USD: 'SHORT' },
  GBPUSD: { GBP: 'LONG',  USD: 'SHORT' },
  USDJPY: { USD: 'LONG',  JPY: 'SHORT' },
  USDCHF: { USD: 'LONG',  CHF: 'SHORT' },
  USDCAD: { USD: 'LONG',  CAD: 'SHORT' },
  AUDUSD: { AUD: 'LONG',  USD: 'SHORT' },
  NZDUSD: { NZD: 'LONG',  USD: 'SHORT' },
  EURGBP: { EUR: 'LONG',  GBP: 'SHORT' },
  EURJPY: { EUR: 'LONG',  JPY: 'SHORT' },
  EURAUD: { EUR: 'LONG',  AUD: 'SHORT' },
  EURCHF: { EUR: 'LONG',  CHF: 'SHORT' },
  GBPJPY: { GBP: 'LONG',  JPY: 'SHORT' },
  GBPCHF: { GBP: 'LONG',  CHF: 'SHORT' },
  AUDJPY: { AUD: 'LONG',  JPY: 'SHORT' }
};

function parseDate(dateStr) {
  return new Date(dateStr + 'T12:00:00Z'); // noon UTC to avoid timezone edge cases
}

function daysUntil(dateStr) {
  const now = new Date();
  const meeting = parseDate(dateStr);
  return Math.ceil((meeting - now) / (24 * 60 * 60 * 1000));
}

function hoursUntil(dateStr) {
  const now = new Date();
  const meeting = parseDate(dateStr);
  return Math.ceil((meeting - now) / (60 * 60 * 1000));
}

// ── Next meeting for a single currency ──────────────────────────────────────
function getNextMeeting(currency) {
  const now = new Date();
  const upcoming = MEETING_CALENDAR
    .filter(m => m.currency === currency && parseDate(m.date) > now)
    .sort((a, b) => parseDate(a.date) - parseDate(b.date));

  if (upcoming.length === 0) return null;
  const m = upcoming[0];
  return { currency: m.currency, bank: m.bank, date: m.date, daysUntil: daysUntil(m.date) };
}

// ── All upcoming meetings within N days ─────────────────────────────────────
function getUpcomingMeetings(days = 14) {
  const now = new Date();
  return MEETING_CALENDAR
    .filter(m => {
      const d = daysUntil(m.date);
      return d >= 0 && d <= days;
    })
    .map(m => ({ ...m, daysUntil: daysUntil(m.date) }))
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

// ── Event risk window check ─────────────────────────────────────────────────
// Returns true if any meeting for this currency is within N hours
function isEventRiskWindow(currency, hours = 48) {
  const now = new Date();
  return MEETING_CALENDAR.some(m => {
    if (m.currency !== currency) return false;
    const h = hoursUntil(m.date);
    return h >= -6 && h <= hours; // include 6h after meeting (reaction volatility)
  });
}

// ── Event risk for a pair (checks both currencies) ──────────────────────────
function isPairEventRisk(symbol, hours = 48) {
  const currencies = PAIR_CURRENCIES[symbol];
  if (!currencies) return null;
  for (const cur of currencies) {
    if (isEventRiskWindow(cur, hours)) {
      const meeting = getNextMeeting(cur);
      if (meeting) return meeting;
    }
  }
  return null;
}

// ── Meeting context summary ─────────────────────────────────────────────────
function getMeetingContext(currency) {
  const next = getNextMeeting(currency);
  if (!next) return null;

  // Try to get consensus from DB
  let consensusText = '';
  try {
    const { getConsensus } = require('./db');
    const cons = getConsensus(currency);
    if (cons && cons.meeting_date === next.date) {
      consensusText = ` — ${cons.expected_decision} ${cons.expected_bps ? cons.expected_bps + 'bps' : ''} (${cons.confidence} confidence)`;
    }
  } catch(e) {}

  const dateStr = new Date(next.date + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
  return `${next.bank} meeting in ${next.daysUntil} days (${dateStr})${consensusText}`;
}

// ── Forward guidance: does consensus help or hurt a signal direction? ────────
function getConsensusImpact(symbol, direction) {
  const currencies = PAIR_CURRENCIES[symbol];
  const dirMap = CURRENCY_DIRECTION[symbol];
  if (!currencies || !dirMap) return null;

  try {
    const { getConsensus } = require('./db');
    for (const cur of currencies) {
      const next = getNextMeeting(cur);
      if (!next || next.daysUntil > 21) continue;

      const cons = getConsensus(cur);
      if (!cons || cons.meeting_date !== next.date) continue;
      if (!cons.expected_decision || cons.expected_decision === 'HOLD') continue;

      // HIKE strengthens currency, CUT weakens it
      const currencyStrengthens = cons.expected_decision === 'HIKE';
      // Which direction benefits from this currency strengthening?
      const benefitDir = dirMap[cur];
      if (!benefitDir) continue;

      const signalBenefits = (currencyStrengthens && direction === benefitDir) ||
                             (!currencyStrengthens && direction !== benefitDir);
      const signalHurt = (currencyStrengthens && direction !== benefitDir) ||
                         (!currencyStrengthens && direction === benefitDir);

      if (signalBenefits || signalHurt) {
        return {
          currency: cur,
          bank: next.bank,
          date: next.date,
          daysUntil: next.daysUntil,
          decision: cons.expected_decision,
          bps: cons.expected_bps,
          confidence: cons.confidence,
          impact: signalBenefits ? 'CONFIRMS' : 'CONTRADICTS',
          summary: cons.summary
        };
      }
    }
  } catch(e) {}

  return null;
}

module.exports = {
  getNextMeeting, getUpcomingMeetings, isEventRiskWindow, isPairEventRisk,
  getMeetingContext, getConsensusImpact, MEETING_CALENDAR, PAIR_CURRENCIES
};
