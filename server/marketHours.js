// All times in UTC. UAE = UTC+4.
// Sources: CME, ICE, Eurex, SGX, HKEX, OSE, TSE official hours.

const MARKET_HOURS = {
  GOLD: {
    // Capital.com: Sun 22:00 UTC – Fri 21:00 UTC (02:00–01:00 UAE)
    // Daily break 21:00–22:00 UTC (01:00–02:00 UAE)
    type: 'futures_metals',
    timezone: 'UTC',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },  // Sunday 22:00 UTC = 02:00 UAE Monday
    weeklyClose: { day: 5, hour: 21, minute: 0 },  // Friday 21:00 UTC = 01:00 UAE Saturday
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0]
  },
  SILVER: {
    type: 'futures_metals',
    timezone: 'UTC',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0]
  },
  OILWTI: {
    // Capital.com WTI: same as metals
    type: 'futures_energy',
    timezone: 'UTC',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0]
  },
  BTCUSD: {
    // Crypto: true 24/7/365, never closed
    type: 'crypto',
    alwaysOpen: true
  },
  US500: {
    // Capital.com US indices: Sun 22:00 UTC – Fri 21:00 UTC
    type: 'index_us',
    timezone: 'UTC',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0],
    peakWindow:  { start: { hour: 13, minute: 30 }, end: { hour: 20, minute: 0 } }
  },
  US100: {
    type: 'index_us',
    timezone: 'UTC',
    weeklyOpen:  { day: 0, hour: 22, minute: 0 },
    weeklyClose: { day: 5, hour: 21, minute: 0 },
    dailyBreak:  { start: { hour: 21, minute: 0 }, end: { hour: 22, minute: 0 } },
    noDailyBreakDays: [0],
    peakWindow:  { start: { hour: 13, minute: 30 }, end: { hour: 20, minute: 0 } }
  },
  DE40: {
    // Eurex FDAX: Mon–Fri 07:00–21:00 UTC (Xetra cash 07:00–15:30, futures extend)
    type: 'index_eu',
    timezone: 'UTC',
    sessions: [
      { days: [1, 2, 3, 4, 5], start: { hour: 7, minute: 0 }, end: { hour: 21, minute: 0 } }
    ]
  },
  UK100: {
    // ICE FTSE: Mon–Fri 08:00–16:35 UTC cash; futures 01:00–21:00 UTC
    // Capital.com extended: 01:00–21:00 UTC weekdays
    type: 'index_eu',
    timezone: 'UTC',
    sessions: [
      { days: [1, 2, 3, 4, 5], start: { hour: 1, minute: 0 }, end: { hour: 21, minute: 0 } }
    ]
  },
  J225: {
    // OSE Nikkei futures: Mon–Fri 00:00–06:00 + 07:30–21:10 UTC
    // Simplified: two sessions per day
    type: 'index_asia',
    timezone: 'UTC',
    sessions: [
      { days: [1, 2, 3, 4, 5], start: { hour: 0,  minute: 0  }, end: { hour: 6,  minute: 0  } },
      { days: [1, 2, 3, 4, 5], start: { hour: 7,  minute: 30 }, end: { hour: 21, minute: 10 } }
    ]
  },
  HK50: {
    // HKEX: Mon–Fri 01:30–04:00 + 05:00–08:00 + 09:15–12:00 UTC
    // Simplified to main session block
    type: 'index_asia',
    timezone: 'UTC',
    sessions: [
      { days: [1, 2, 3, 4, 5], start: { hour: 1,  minute: 30 }, end: { hour: 4,  minute: 0  } },
      { days: [1, 2, 3, 4, 5], start: { hour: 5,  minute: 0  }, end: { hour: 8,  minute: 0  } },
      { days: [1, 2, 3, 4, 5], start: { hour: 9,  minute: 15 }, end: { hour: 12, minute: 0  } }
    ]
  },
  CN50: {
    // SGX FTSE China A50: Mon–Fri 01:00–05:15 + 06:00–09:00 UTC
    type: 'index_asia',
    timezone: 'UTC',
    sessions: [
      { days: [1, 2, 3, 4, 5], start: { hour: 1,  minute: 0  }, end: { hour: 5,  minute: 15 } },
      { days: [1, 2, 3, 4, 5], start: { hour: 6,  minute: 0  }, end: { hour: 9,  minute: 0  } }
    ]
  }
};

/**
 * Returns true if the given symbol's market is currently open.
 * Uses UTC time internally.
 */
function isMarketOpen(symbol) {
  const cfg = MARKET_HOURS[symbol];
  if (!cfg) return true; // unknown = assume open

  if (cfg.alwaysOpen) return true;

  const now = new Date();
  const utcDay  = now.getUTCDay();    // 0=Sun … 6=Sat
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcMins = utcHour * 60 + utcMin; // minutes since midnight UTC

  // ── Session-based markets (EU + Asia indices) ────────────────────────────
  if (cfg.sessions) {
    for (const s of cfg.sessions) {
      if (!s.days.includes(utcDay)) continue;
      const startMins = s.start.hour * 60 + s.start.minute;
      const endMins   = s.end.hour   * 60 + s.end.minute;
      if (utcMins >= startMins && utcMins < endMins) return true;
    }
    return false;
  }

  // ── Weekly-open futures (metals, energy, US indices) ────────────────────
  if (cfg.weeklyOpen && cfg.weeklyClose) {
    // Weekend closed
    if (utcDay === 6) return false; // Saturday always closed
    if (utcDay === 0 && utcHour < cfg.weeklyOpen.hour) return false; // Sunday pre-open

    // Friday close
    if (utcDay === 5) {
      const closeMins = cfg.weeklyClose.hour * 60 + cfg.weeklyClose.minute;
      if (utcMins >= closeMins) return false;
    }

    // Daily break (skip on noDailyBreakDays)
    if (cfg.dailyBreak && !cfg.noDailyBreakDays?.includes(utcDay)) {
      const breakStart = cfg.dailyBreak.start.hour * 60 + cfg.dailyBreak.start.minute;
      const breakEnd   = cfg.dailyBreak.end.hour   * 60 + cfg.dailyBreak.end.minute;
      if (utcMins >= breakStart && utcMins < breakEnd) return false;
    }

    return true;
  }

  return true;
}

/**
 * Returns open status + reason string for all 11 symbols.
 */
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

/**
 * Returns minutes until next open for a symbol.
 */
function minutesUntilOpen(symbol) {
  if (isMarketOpen(symbol)) return 0;
  // Probe forward up to 72h in 1m steps
  const probe = new Date();
  for (let i = 1; i <= 72 * 60; i++) {
    probe.setTime(Date.now() + i * 60000);
    const d = probe.getUTCDay();
    const h = probe.getUTCHours();
    const m = probe.getUTCMinutes();
    // Temporary override for check
    const orig = Date;
    if (_isOpenAt(symbol, d, h * 60 + m)) return i;
  }
  return null;
}

function _isOpenAt(symbol, utcDay, utcMins) {
  const cfg = MARKET_HOURS[symbol];
  if (!cfg || cfg.alwaysOpen) return true;
  if (cfg.sessions) {
    for (const s of cfg.sessions) {
      if (!s.days.includes(utcDay)) continue;
      const startMins = s.start.hour * 60 + s.start.minute;
      const endMins   = s.end.hour   * 60 + s.end.minute;
      if (utcMins >= startMins && utcMins < endMins) return true;
    }
    return false;
  }
  if (cfg.weeklyOpen && cfg.weeklyClose) {
    if (utcDay === 6) return false;
    if (utcDay === 0 && Math.floor(utcMins / 60) < cfg.weeklyOpen.hour) return false;
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
