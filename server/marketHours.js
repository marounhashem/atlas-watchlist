const MARKET_HOURS = {
  GOLD: {
    type: 'futures_metals',
    weeklyOpen:  { day: 0, hour: 23, minute: 0 },  // Sunday 23:00 UTC = Monday 03:00 UAE
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 23, minute: 0 } },
    noDailyBreakDays: [0]
  },
  SILVER: {
    type: 'futures_metals',
    weeklyOpen:  { day: 0, hour: 23, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 23, minute: 0 } },
    noDailyBreakDays: [0]
  },
  OILWTI: {
    type: 'futures_energy',
    weeklyOpen:  { day: 0, hour: 23, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 23, minute: 0 } },
    noDailyBreakDays: [0]
  },
  BTCUSD: {
    type: 'crypto',
    alwaysOpen: true
  },
  US30: {
    type: 'index_us',
    weeklyOpen:  { day: 0, hour: 23, minute: 0 },  // Sunday 23:00 UTC
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 23, minute: 0 } },
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
    weeklyOpen:  { day: 0, hour: 23, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 23, minute: 0 } },
    noDailyBreakDays: [0],
    peakWindow: { start: { hour: 13, minute: 30 }, end: { hour: 20, minute: 0 } }
  },
  // ── Global indices ────────────────────────────────────────────────────────
  US500: { type:'index_us', weeklyOpen:{day:0,hour:23,minute:0}, weeklyClose:{day:5,hour:21,minute:0}, dailyBreak:{start:{hour:21,minute:0},end:{hour:23,minute:0}}, noDailyBreakDays:[0], peakWindow:{start:{hour:13,minute:30},end:{hour:20,minute:0}} },
  DE40:  { type:'index_eu', weeklyOpen:{day:1,hour:7,minute:0},   weeklyClose:{day:5,hour:15,minute:30}, peakWindow:{start:{hour:7,minute:0},end:{hour:15,minute:30}} },
  UK100: { type:'index_eu', weeklyOpen:{day:1,hour:8,minute:0},   weeklyClose:{day:5,hour:16,minute:30}, peakWindow:{start:{hour:8,minute:0},end:{hour:16,minute:30}} },
  J225:  { type:'index_asia', weeklyOpen:{day:1,hour:0,minute:0}, weeklyClose:{day:5,hour:6,minute:30},  peakWindow:{start:{hour:0,minute:0},end:{hour:6,minute:30}} },
  HK50:  { type:'index_asia', weeklyOpen:{day:1,hour:1,minute:30},weeklyClose:{day:5,hour:8,minute:0},   peakWindow:{start:{hour:1,minute:30},end:{hour:8,minute:0}} },
  CN50:  { type:'index_asia', weeklyOpen:{day:1,hour:1,minute:30},weeklyClose:{day:5,hour:7,minute:0},   peakWindow:{start:{hour:1,minute:30},end:{hour:7,minute:0}} },
  COPPER:   { type:'commodity_lme', weeklyOpen:{day:1,hour:1,minute:0}, weeklyClose:{day:5,hour:16,minute:0}, peakWindow:{start:{hour:8,minute:0},end:{hour:16,minute:0}} },
  PLATINUM: { type:'commodity_lme', weeklyOpen:{day:1,hour:1,minute:0}, weeklyClose:{day:5,hour:16,minute:0}, peakWindow:{start:{hour:8,minute:0},end:{hour:16,minute:0}} }
};

// ── Bank holidays — thin liquidity or closed markets ────────────────────────
// Affects scoring (session penalty) and morning brief warnings
// Market holidays — commodities (GOLD/SILVER/OIL) also close on major holidays
// Forex pairs with affected currencies may have thin liquidity on Easter Monday
const BANK_HOLIDAYS = {
  '2026-04-03': ['GOLD','SILVER','OILWTI','COPPER','PLATINUM','UK100','DE40'], // Good Friday
  // Easter Monday 2026-04-06 — all symbols trading, removed entirely
  '2026-05-01': ['DE40'], // Labour Day EU
  '2026-05-25': ['UK100'], // Spring Bank Holiday UK
  '2026-07-04': ['US30','US100','US500'], // Independence Day US
  '2026-08-31': ['UK100'], // Summer Bank Holiday UK
  '2026-11-26': ['US30','US100','US500'], // Thanksgiving US
  '2026-12-25': ['GOLD','SILVER','OILWTI','COPPER','PLATINUM','UK100','DE40','US30','US100','US500'], // Christmas
  '2026-12-26': ['UK100','DE40','COPPER','PLATINUM'], // Boxing Day
  '2026-12-28': ['UK100','DE40'], // Boxing Day observed
  '2027-01-01': ['GOLD','SILVER','OILWTI','COPPER','PLATINUM','UK100','DE40','US30','US100','US500','J225'], // New Year
};

function isBankHoliday(symbol) {
  const today = new Date().toISOString().slice(0, 10);
  const affected = BANK_HOLIDAYS[today] || [];
  const hit = affected.includes(symbol);
  if (hit) console.log(`[Holiday] ${symbol} flagged as bank holiday — ${today} (${getBankHolidayName() || 'unnamed'})`);
  return hit;
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

// `at` is optional — if provided, evaluates whether the market would have been
// open at that timestamp instead of right now. Used by the health check to
// distinguish "market was closed during the staleness window" from "market is
// open now and Pine genuinely silent". isBankHoliday is still evaluated for
// today only — fine in practice because the staleness window is hours, not
// days.
function isMarketOpen(symbol, at) {
  if (isBankHoliday(symbol)) return false;
  const cfg = MARKET_HOURS[symbol];
  if (!cfg) return true;
  if (cfg.alwaysOpen) return true;

  const now = at instanceof Date ? at : new Date();
  const utcDay  = now.getUTCDay();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcMins = utcHour * 60 + utcMin;

  if (cfg.weeklyOpen && cfg.weeklyClose) {
    // Saturday: always closed
    if (utcDay === 6) return false;

    // Sunday logic depends on weekly open day
    if (utcDay === 0) {
      if (cfg.weeklyOpen.day === 1) return false; // Opens Monday — entire Sunday closed
      if (cfg.weeklyOpen.day === 0 && utcHour < cfg.weeklyOpen.hour) return false; // Opens Sunday evening
      if (cfg.weeklyOpen.day === 0 && utcHour >= cfg.weeklyOpen.hour) {
        // Sunday after open — check daily break
      } else {
        return false; // Safety: if day > 1, closed Sunday
      }
    }

    // Monday: symbols that open Monday need hour check
    if (utcDay === 1 && cfg.weeklyOpen.day === 1) {
      const openMins = cfg.weeklyOpen.hour * 60 + cfg.weeklyOpen.minute;
      if (utcMins < openMins) return false; // Before Monday open
    }

    // Friday: check close time
    if (utcDay === 5) {
      const closeMins = cfg.weeklyClose.hour * 60 + cfg.weeklyClose.minute;
      if (utcMins >= closeMins) return false;
    }

    // Daily break check (e.g. futures 21:00-22:00 UTC)
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
  const utcHour = now.getUTCHours();
  if (isBankHoliday(symbol)) return 'Bank holiday';
  if (utcDay === 6) return 'Weekend';
  if (utcDay === 0) {
    const cfg = MARKET_HOURS[symbol];
    if (!cfg || cfg.alwaysOpen) return 'Weekend';
    // Check against this symbol's actual weekly open time
    if (cfg.weeklyOpen?.day === 0 && utcHour >= cfg.weeklyOpen.hour) return 'Daily break';
    if (cfg.weeklyOpen?.day === 0 && utcHour < cfg.weeklyOpen.hour) return 'Weekend';
    if (cfg.weeklyOpen?.day === 1) return utcHour >= 22 ? 'Before weekly open' : 'Weekend';
    return 'Weekend';
  }
  if (utcDay === 1) {
    const cfg = MARKET_HOURS[symbol];
    if (cfg?.weeklyOpen?.day === 1) {
      const openMins = cfg.weeklyOpen.hour * 60 + (cfg.weeklyOpen.minute || 0);
      if (utcHour * 60 + now.getUTCMinutes() < openMins) return 'Before weekly open';
    }
  }
  return 'Outside market hours';
}

function minutesUntilOpen(symbol) {
  if (isMarketOpen(symbol)) return 0;
  const cfg = MARKET_HOURS[symbol];
  if (!cfg) return null;
  if (cfg.alwaysOpen) return 0;

  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Calculate directly from weeklyOpen config instead of brute-force probing
  if (cfg.weeklyOpen) {
    const openDay = cfg.weeklyOpen.day;
    const openMins = cfg.weeklyOpen.hour * 60 + (cfg.weeklyOpen.minute || 0);

    // Days until open day (wrapping around week)
    let daysUntil = (openDay - utcDay + 7) % 7;

    // Same day: check if we're before open or in a daily break
    if (daysUntil === 0) {
      if (utcMins < openMins) return openMins - utcMins;
      // In daily break — find break end
      if (cfg.dailyBreak) {
        const breakEnd = cfg.dailyBreak.end.hour * 60 + cfg.dailyBreak.end.minute;
        if (utcMins < breakEnd) return breakEnd - utcMins;
      }
      // Past close on Friday — next week
      daysUntil = 7;
    }

    // Weekend: jump to open day
    if (utcDay === 6 || utcDay === 0) {
      if (utcDay === 6) daysUntil = (openDay === 0) ? 1 : (openDay + 1); // Sat → Sun or Mon+
      if (utcDay === 0) {
        if (openDay === 0 && utcMins < openMins) return openMins - utcMins;
        if (openDay === 0 && utcMins >= openMins) {
          // Sunday after open but in daily break
          if (cfg.dailyBreak) {
            const breakEnd = cfg.dailyBreak.end.hour * 60 + cfg.dailyBreak.end.minute;
            if (utcMins < breakEnd) return breakEnd - utcMins;
          }
          return null;
        }
        daysUntil = 1; // Monday
      }
    }

    return daysUntil * 1440 + (openMins - utcMins);
  }
  return null;
}

function _isOpenAt(symbol, utcDay, utcMins) {
  const cfg = MARKET_HOURS[symbol];
  if (!cfg || cfg.alwaysOpen) return true;
  if (cfg.weeklyOpen && cfg.weeklyClose) {
    if (utcDay === 6) return false;
    if (utcDay === 0) {
      if (cfg.weeklyOpen.day === 1) return false; // Opens Monday — entire Sunday closed
      if (cfg.weeklyOpen.day === 0 && Math.floor(utcMins/60) < cfg.weeklyOpen.hour) return false;
    }
    if (utcDay === 1 && cfg.weeklyOpen.day === 1) {
      const openMins = cfg.weeklyOpen.hour * 60 + cfg.weeklyOpen.minute;
      if (utcMins < openMins) return false;
    }
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
