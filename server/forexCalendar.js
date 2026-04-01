// Forex Factory Economic Calendar — HIGH impact events
// Fetches from FairEconomy JSON feed (mirrors Forex Factory data)
// Used for event risk gating and morning brief

const THIS_WEEK_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const NEXT_WEEK_URL = 'https://nfs.faireconomy.media/ff_calendar_nextweek.json';

const RELEVANT_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

async function fetchCalendarURL(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'ATLAS-Watchlist/1.0' }
  });
  if (!res.ok) {
    console.error(`[Calendar] HTTP ${res.status} from ${url}`);
    return [];
  }
  return res.json();
}

async function runCalendarFetch() {
  console.log('[Calendar] Fetching economic calendar...');
  let stored = 0;

  try {
    const [thisWeek, nextWeek] = await Promise.all([
      fetchCalendarURL(THIS_WEEK_URL),
      fetchCalendarURL(NEXT_WEEK_URL)
    ]);

    const allEvents = [...thisWeek, ...nextWeek];
    console.log(`[Calendar] Fetched ${allEvents.length} total events (this week: ${thisWeek.length}, next: ${nextWeek.length})`);

    // Filter: HIGH impact + relevant currencies only
    const highImpact = allEvents.filter(e =>
      e.impact === 'High' && RELEVANT_CURRENCIES.includes(e.country)
    );
    console.log(`[Calendar] ${highImpact.length} HIGH impact events for tracked currencies`);

    // Clear old events and store fresh ones
    try {
      const { upsertEconomicEvent } = require('./db');
      for (const e of highImpact) {
        // Parse ISO date string
        const eventDate = e.date ? e.date.slice(0, 10) : null;
        const eventTime = e.date ? e.date.slice(11, 19) : null;
        if (!eventDate) continue;

        upsertEconomicEvent({
          title: e.title,
          currency: e.country,
          eventDate,
          eventTime,
          impact: e.impact,
          forecast: e.forecast || null,
          previous: e.previous || null
        });
        stored++;
      }
    } catch(e) {
      console.error('[Calendar] DB store error:', e.message);
    }

    console.log(`[Calendar] Stored ${stored} HIGH impact events`);
  } catch(e) {
    console.error('[Calendar] Fetch error:', e.message);
  }

  return { stored };
}

// ── Get upcoming HIGH impact events within N days ───────────────────────────
function getUpcomingHighImpactEvents(days = 7) {
  try {
    const { getUpcomingEvents } = require('./db');
    const rows = getUpcomingEvents(days);
    return rows.map(r => ({
      title: r.title,
      currency: r.currency,
      date: r.event_date,
      time: r.event_time,
      impact: r.impact,
      forecast: r.forecast,
      previous: r.previous,
      actual: r.actual,
      daysUntil: Math.ceil((new Date(r.event_date + 'T12:00:00Z') - new Date()) / (24 * 60 * 60 * 1000))
    }));
  } catch(e) {
    return [];
  }
}

// ── Event risk window — true if HIGH impact event within N hours ────────────
function isCalendarEventRisk(currency, hours = 24) {
  const events = getUpcomingHighImpactEvents(3); // check next 3 days
  const now = new Date();
  for (const e of events) {
    if (e.currency !== currency) continue;
    const eventTs = new Date(e.date + 'T' + (e.time || '12:00:00') + 'Z');
    const hoursUntil = (eventTs - now) / (60 * 60 * 1000);
    if (hoursUntil >= -2 && hoursUntil <= hours) { // include 2h after event
      return { ...e, hoursUntil: Math.round(hoursUntil) };
    }
  }
  return null;
}

module.exports = { runCalendarFetch, getUpcomingHighImpactEvents, isCalendarEventRisk };
