const MARKET_HOURS = {
  GOLD: {
    type: 'futures_metals',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0]
  },
  SILVER: {
    type: 'futures_metals',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0]
  },
  OILWTI: {
    type: 'futures_energy',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0]
  },
  BTCUSD: {
    type: 'crypto',
    alwaysOpen: true
  },
  US30: {
    type: 'index_us',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0],
    peakWindow: { start: { hour: 13, minute: 30 }, end: { hour: 20, minute: 0 } }
  },
  // Forex pairs — 24h Mon-Fri (same structure as metals)
  EURUSD: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  GBPUSD: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  USDJPY: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  USDCHF: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  USDCAD: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  AUDUSD: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  NZDUSD: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  EURJPY: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  EURGBP: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  EURAUD: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  EURCHF: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  GBPJPY: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  GBPCHF: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  AUDJPY: { type:'forex', weeklyOpen:{day:0,hour:22,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:22,minute:0}}, noDailyBreakDays:[0] },
  ETHUSD: { type:'crypto', alwaysOpen: true },
  US100: {
    type: 'index_us',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0],
    peakWindow: { start: { hour: 13, minute: 30 }, end: { hour: 20, minute: 0 } }
  },
  // ── Global indices ────────────────────────────────────────────────────────
  US500: { type:'index_us', weeklyOpen:{day:1,hour:13,minute:30}, weeklyClose:{day:5,hour:20,minute:0}, peakWindow:{start:{hour:13,minute:30},end:{hour:20,minute:0}} },
  DE40:  { type:'index_eu', weeklyOpen:{day:1,hour:7,minute:0},   weeklyClose:{day:5,hour:15,minute:30}, peakWindow:{start:{hour:7,minute:0},end:{hour:15,minute:30}} },
  UK100: { type:'index_eu', weeklyOpen:{day:1,hour:8,minute:0},   weeklyClose:{day:5,hour:16,minute:30}, peakWindow:{start:{hour:8,minute:0},end:{hour:16,minute:30}} },
  J225:  { type:'index_asia', weeklyOpen:{day:1,hour:0,minute:0}, weeklyClose:{day:5,hour:6,minute:30},  peakWindow:{start:{hour:0,minute:0},end:{hour:6,minute:30}} },
  HK50:  { type:'index_asia', weeklyOpen:{day:1,hour:1,minute:30},weeklyClose:{day:5,hour:8,minute:0},   peakWindow:{start:{hour:1,minute:30},end:{hour:8,minute:0}} },
  CN50:  { type:'index_asia', weeklyOpen:{day:1,hour:1,minute:30},weeklyClose:{day:5,hour:7,minute:0},   peakWindow:{start:{hour:1,minute:30},end:{hour:7,minute:0}} },
  COPPER:   { type:'commodity_lme', weeklyOpen:{day:1,hour:8,minute:0}, weeklyClose:{day:5,hour:17,minute:0}, peakWindow:{start:{hour:8,minute:0},end:{hour:17,minute:0}} },
  PLATINUM: { type:'commodity_lme', weeklyOpen:{day:1,hour:8,minute:0}, weeklyClose:{day:5,hour:17,minute:0}, peakWindow:{start:{hour:8,minute:0},end:{hour:17,minute:0}} }
};

// ── Bank holidays — thin liquidity or closed markets ────────────────────────
// Affects scoring (session penalty) and morning brief warnings
const BANK_HOLIDAYS = {
  '2026-04-03': ['UK100','DE40','GBPUSD','GBPJPY','GBPCHF','EURGBP','EURUSD','EURJPY','EURCHF','EURAUD','COPPER','PLATINUM'], // Good Friday
  '2026-04-06': ['UK100','DE40','GBPUSD','GBPJPY','GBPCHF','EURGBP','EURUSD','EURJPY','EURCHF','EURAUD','COPPER','PLATINUM'], // Easter Monday
  '2026-05-01': ['DE40','EURUSD','EURJPY','EURGBP','EURCHF','EURAUD'], // Labour Day EU
  '2026-05-25': ['UK100','GBPUSD','GBPJPY','GBPCHF','EURGBP'], // Spring Bank Holiday UK
  '2026-07-04': ['US30','US100','US500'], // Independence Day US
  '2026-08-31': ['UK100','GBPUSD','GBPJPY','GBPCHF','EURGBP'], // Summer Bank Holiday UK
  '2026-11-26': ['US30','US100','US500'], // Thanksgiving US
  '2026-12-25': ['UK100','DE40','US30','US100','US500','COPPER','PLATINUM'], // Christmas
  '2026-12-26': ['UK100','DE40','COPPER','PLATINUM'], // Boxing Day
  '2026-12-28': ['UK100','DE40'], // Boxing Day observed
  '2027-01-01': ['UK100','DE40','US30','US100','US500','J225','COPPER','PLATINUM'], // New Year
};

function isBankHoliday(symbol) {
  const today = new Date().toISOString().slice(0, 10);
  const affected = BANK_HOLIDAYS[today] || [];
  return affected.includes(symbol);
}

function getBankHolidayName() {
  const today = new Date().toISOString().slice(0, 10);
  const names = {
    '2026-04-03': 'Good Friday', '2026-04-06': 'Easter Monday',
    '2026-05-01': 'Labour Day', '2026-05-25': 'Spring Bank Holiday',
    '2026-07-04': 'Independence Day', '2026-08-31': 'Summer Bank Holiday',
    '2026-11-26': 'Thanksgiving', '2026-12-25': 'Christmas Day',
    '2026-12-26': 'Boxing Day', '2026-12-28': 'Boxing Day (observed)',
    '2027-01-01': 'New Year\'s Day',
  };
  return names[today] || null;
}

function isMarketOpen(symbol) {
  const cfg = MARKET_HOURS[symbol];
  if (!cfg) return true;
  if (cfg.alwaysOpen) return true;

  const now = new Date();
  const utcDay  = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcMins = utcHour * 60 + utcMin;

  if (cfg.weeklyOpen && cfg.weeklyClose) {
    if (utcDay === 6) return false;
    if (utcDay === 0 && utcHour < cfg.weeklyOpen.hour) return false;
    if (utcDay === 5) {
      const closeMins = cfg.weeklyClose.hour * 60 + cfg.weeklyClose.minute;
      if (utcMins >= closeMins) return false;
    }
    if (cfg.dailyBreak && !cfg.noDailyBreakDays?.includes(utcDay)) {
      const breakStart = cfg.dailyBreak.start.hour * 60 + cfg.dailyBreak.start.minute;
      const breakEnd   = cfg.dailyBreak.end.hour   * 60 + cfg.dailyBreak.end.minute;
      if (utcMins >= breakStart && utcMins < breakEnd) return false;
    }
    return true;
  }
  return true;
}

function getMarketStatus() {
  const status = {};
  for (const symbol of Object.keys(MARKET_HOURS)) {
    const open = isMarketOpen(symbol);
    status[symbol] = { open, reason: open ? 'Market open' : getClosedReason(symbol) };
  }
  return status;
}

function getClosedReason(symbol) {
  const now = new Date();
  const utcDay = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return 'Weekend';
  return 'Outside market hours';
}

function minutesUntilOpen(symbol) {
  if (isMarketOpen(symbol)) return 0;
  const probe = new Date();
  for (let i = 1; i <= 72 * 60; i++) {
    probe.setTime(Date.now() + i * 60000);
    const d = probe.getUTCDay();
    const h = probe.getUTCHours();
    const m = probe.getUTCMinutes();
    if (_isOpenAt(symbol, d, h * 60 + m)) return i;
  }
  return null;
}

function _isOpenAt(symbol, utcDay, utcMins) {
  const cfg = MARKET_HOURS[symbol];
  if (!cfg || cfg.alwaysOpen) return true;
  if (cfg.weeklyOpen && cfg.weeklyClose) {
    if (utcDay === 6) return false;
    if (utcDay === 0 && Math.floor(utcMins/60) < cfg.weeklyOpen.hour) return false;
    if (utcDay === 5) {
      const closeMins = cfg.weeklyClose.hour * 60 + cfg.weeklyClose.minute;
      if (utcMins >= closeMins) return false;
    }
    if (cfg.dailyBreak && !cfg.noDailyBreakDays?.includes(utcDay)) {
      const breakStart = cfg.dailyBreak.start.hour * 60 + cfg.dailyBreak.start.minute;
      const breakEnd   = cfg.dailyBreak.end.hour   * 60 + cfg.dailyBreak.end.minute;
      if (utcMins >= breakStart && utcMins < breakEnd) return false;
    }
    return true;
  }
  return true;
}

module.exports = { isMarketOpen, getMarketStatus, minutesUntilOpen, isBankHoliday, getBankHolidayName, MARKET_HOURS };
