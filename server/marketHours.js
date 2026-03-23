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
  US100: {
    type: 'index_us',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0],
    peakWindow: { start: { hour: 13, minute: 30 }, end: { hour: 20, minute: 0 } }
  }
};

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

module.exports = { isMarketOpen, getMarketStatus, minutesUntilOpen, MARKET_HOURS };
