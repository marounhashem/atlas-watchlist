// Forex Factory Economic Calendar — HIGH impact events
// Fetches from FairEconomy JSON feed every 5 minutes
// Pre-event risk: caps signals to WATCH within 2h
// Post-event suppression: blocks signals for 30min after event fires

const THIS_WEEK_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const NEXT_WEEK_URL = 'https://nfs.faireconomy.media/ff_calendar_nextweek.json';

const RELEVANT_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];

// Currency → affected ATLAS symbols
const EVENT_IMPACT_SYMBOLS = {
  USD: ['GOLD','SILVER','OILWTI','BTCUSD','US30','US100',
        'EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD',
        'EURJPY','GBPJPY','AUDJPY','EURAUD','EURGBP','EURCHF','GBPCHF'],
  EUR: ['EURUSD','EURGBP','EURJPY','EURAUD','EURCHF','GOLD'],
  GBP: ['GBPUSD','EURGBP','GBPJPY','GBPCHF'],
  JPY: ['USDJPY','EURJPY','GBPJPY','AUDJPY'],
  AUD: ['AUDUSD','EURAUD','AUDJPY','NZDUSD'],
  NZD: ['NZDUSD'],
  CAD: ['USDCAD'],
  CHF: ['USDCHF','EURCHF','GBPCHF'],
};

// Post-event suppression: { symbol: suppressUntilTs }
const postEventSuppression = {};
const SUPPRESSION_MS = 30 * 60 * 1000; // 30 minutes

// ── Event sentiment calculation ──────────────────────────────────────────────
const BULLISH_HIGHER = ['Non-Farm', 'GDP', 'Retail Sales', 'Manufacturing PMI',
  'Services PMI', 'Employment Change', 'Consumer Confidence', 'Trade Balance',
  'ISM Manufacturing', 'ISM Services', 'ADP Non-Farm'];
const BEARISH_HIGHER = ['Unemployment Rate', 'Unemployment Claims',
  'Initial Jobless Claims'];
const HAWKISH_HIGHER = ['CPI', 'Core CPI', 'PCE', 'Core PCE', 'PPI',
  'Average Hourly Earnings'];

function calculateEventSentiment(event) {
  const actual = parseFloat(event.actual || event.forecast); // FF may not have actual separately
  const forecast = parseFloat(event.forecast);
  const previous = parseFloat(event.previous);

  if (isNaN(actual) && isNaN(forecast)) return null;

  // If we have forecast, compare actual vs forecast
  if (!isNaN(actual) && !isNaN(forecast) && forecast !== 0) {
    const delta = actual - forecast;
    const pctDelta = Math.round(Math.abs(delta / forecast) * 1000) / 10;

    const isBullishHigher = BULLISH_HIGHER.some(e => event.title.includes(e))
      || HAWKISH_HIGHER.some(e => event.title.includes(e));
    const isBearishHigher = BEARISH_HIGHER.some(e => event.title.includes(e));

    let beat = 0;
    if (delta > 0) beat = isBullishHigher ? 1 : isBearishHigher ? -1 : 1;
    if (delta < 0) beat = isBullishHigher ? -1 : isBearishHigher ? 1 : -1;

    const magnitude = pctDelta < 0.5 ? 'SMALL' : pctDelta < 2.0 ? 'MEDIUM' : 'LARGE';
    const beatLabel = beat > 0 ? 'beat' : 'missed';

    return {
      beat, magnitude, pctDelta,
      actual: event.actual || String(actual),
      forecast: event.forecast,
      previous: event.previous,
      summary: `${event.title} ${beatLabel} (${event.actual || actual} vs ${event.forecast}) — ${event.currency} ${beat > 0 ? 'bullish' : 'bearish'}`
    };
  }

  // No forecast — compare to previous
  if (!isNaN(actual) && !isNaN(previous) && previous !== 0) {
    const beat = actual > previous ? 1 : -1;
    return {
      beat, magnitude: 'SMALL', pctDelta: 0,
      actual: event.actual || String(actual),
      previous: event.previous,
      summary: `${event.title}: ${event.actual || actual} vs prev ${event.previous}`
    };
  }

  return null;
}

// ── Get combined sentiment from all events fired in last N hours for a currency
function getEventSentiment(currency) {
  try {
    const { getRecentFiredEvents } = require('./db');
    const recent = getRecentFiredEvents(4);
    const forCurrency = recent.filter(e => e.currency === currency && e.sentiment !== 0);
    if (forCurrency.length === 0) return null;

    // Combine: weight by magnitude
    let totalBeat = 0;
    let count = 0;
    let lastSummary = '';
    for (const e of forCurrency) {
      const weight = e.sentiment_magnitude === 'LARGE' ? 3 : e.sentiment_magnitude === 'MEDIUM' ? 2 : 1;
      totalBeat += e.sentiment * weight;
      count += weight;
      if (!lastSummary) lastSummary = e.sentiment_summary || '';
    }

    const avgBeat = count > 0 ? totalBeat / count : 0;
    return {
      beat: avgBeat > 0.3 ? 1 : avgBeat < -0.3 ? -1 : 0,
      magnitude: Math.abs(avgBeat) > 0.7 ? 'LARGE' : Math.abs(avgBeat) > 0.3 ? 'MEDIUM' : 'SMALL',
      summary: lastSummary,
      eventCount: forCurrency.length
    };
  } catch(e) { return null; }
}

// ── Fetch helpers ───────────────────────────────────────────────────────────
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

// ── Full fetch — stores events, detects newly fired ─────────────────────────
async function runCalendarCheck(broadcast) {
  let stored = 0;
  let fired = 0;

  try {
    const [thisWeek, nextWeek] = await Promise.all([
      fetchCalendarURL(THIS_WEEK_URL),
      fetchCalendarURL(NEXT_WEEK_URL)
    ]);

    const allEvents = [...thisWeek, ...nextWeek];
    const highImpact = allEvents.filter(e =>
      e.impact === 'High' && RELEVANT_CURRENCIES.includes(e.country)
    );

    const { upsertEconomicEvent, markEventFired } = require('./db');

    for (const e of highImpact) {
      const eventDate = e.date ? e.date.slice(0, 10) : null;
      const eventTime = e.date ? e.date.slice(11, 19) : null;
      if (!eventDate) continue;

      const eventId = `${e.country}_${eventDate}_${e.title}`;
      const hadActual = e.forecast !== '' && e.forecast != null;
      const hasActual = e.previous !== undefined; // FF puts actual in different ways

      upsertEconomicEvent({
        eventId,
        title: e.title,
        currency: e.country,
        eventDate,
        eventTime,
        impact: e.impact,
        forecast: e.forecast || null,
        previous: e.previous || null,
        actual: null // actual populated via separate check below
      });
      stored++;
    }

    // Detect fired events — events where we now have data that we didn't before
    // FF updates the "actual" field once the event fires
    // Re-fetch to check actuals (the same data, just parse differently)
    for (const e of highImpact) {
      if (!e.forecast && !e.previous) continue; // skip events with no expected data
      const eventDate = e.date ? e.date.slice(0, 10) : null;
      const eventId = `${e.country}_${eventDate}_${e.title}`;

      // Check if this event has an actual value in the raw feed
      // FF feed doesn't have an "actual" field directly — actuals appear
      // when the event date has passed and data is published
      // For now, detect by: event time has passed AND forecast exists
      const eventTs = new Date(e.date);
      const now = new Date();
      const minutesSince = (now - eventTs) / 60000;

      // Event fired = event time passed (0-120 min ago) and not yet marked
      if (minutesSince >= 0 && minutesSince <= 120) {
        try {
          // Calculate sentiment from actual vs forecast
          const sentiment = calculateEventSentiment({
            title: e.title, currency: e.country,
            actual: e.actual || e.forecast, // FF may not separate actual
            forecast: e.forecast, previous: e.previous
          });

          const wasFired = markEventFired(eventId, sentiment);
          if (wasFired) {
            fired++;
            const affectedSymbols = EVENT_IMPACT_SYMBOLS[e.country] || [];

            // Set suppression on all affected symbols
            const suppressUntil = Date.now() + SUPPRESSION_MS;
            for (const sym of affectedSymbols) {
              postEventSuppression[sym] = Math.max(postEventSuppression[sym] || 0, suppressUntil);
            }

            const sentimentLabel = sentiment ? ` | ${sentiment.summary}` : '';
            console.log(`[Calendar] EVENT FIRED: ${e.title} (${e.country})${sentimentLabel} — suppressing ${affectedSymbols.length} symbols for 30min`);

            // Telegram alert with sentiment
            try {
              const { sendEventFiredAlert } = require('./telegram');
              sendEventFiredAlert({
                title: e.title,
                currency: e.country,
                actual: e.actual || 'Released',
                forecast: e.forecast,
                previous: e.previous
              }, sentiment, affectedSymbols).catch(err => console.error('[Calendar] Telegram error:', err.message));
            } catch(te) {}

            // WebSocket broadcast
            if (broadcast) {
              broadcast({
                type: 'EVENT_FIRED',
                event: e.title,
                currency: e.country,
                forecast: e.forecast,
                symbols_affected: affectedSymbols,
                ts: Date.now()
              });
            }
          }
        } catch(fe) {}
      }
    }
  } catch(e) {
    console.error('[Calendar] Fetch error:', e.message);
  }

  if (stored > 0 || fired > 0) {
    console.log(`[Calendar] Check complete — ${stored} events stored, ${fired} newly fired`);
  }
  return { stored, fired };
}

// Backward-compat alias
async function runCalendarFetch() { return runCalendarCheck(null); }

// ── Pre-event risk check ────────────────────────────────────────────────────
// Returns event info if any HIGH impact event fires within N hours for a symbol
function isPreEventRisk(symbol, hours = 2) {
  try {
    const { getUpcomingEvents } = require('./db');
    const rows = getUpcomingEvents(3);
    const now = new Date();

    for (const r of rows) {
      // Check if this event's currency affects this symbol
      const affected = EVENT_IMPACT_SYMBOLS[r.currency] || [];
      if (!affected.includes(symbol)) continue;

      const eventTs = new Date(r.event_date + 'T' + (r.event_time || '12:00:00') + 'Z');
      const msUntil = eventTs - now;
      const minutesUntil = Math.round(msUntil / 60000);

      if (minutesUntil >= -5 && minutesUntil <= hours * 60) {
        return {
          title: r.title,
          currency: r.currency,
          date: r.event_date,
          time: r.event_time,
          minutesUntil,
          hoursUntil: Math.round(minutesUntil / 60)
        };
      }
    }
  } catch(e) {}
  return null;
}

// ── Post-event suppression check ────────────────────────────────────────────
function isPostEventSuppressed(symbol) {
  const until = postEventSuppression[symbol];
  if (!until) return false;
  if (Date.now() < until) return true;
  delete postEventSuppression[symbol]; // expired
  return false;
}

// ── Get upcoming HIGH impact events ─────────────────────────────────────────
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
      fired: r.fired === 1,
      isEconomicEvent: true,
      daysUntil: Math.ceil((new Date(r.event_date + 'T12:00:00Z') - new Date()) / (24 * 60 * 60 * 1000))
    }));
  } catch(e) {
    return [];
  }
}

module.exports = {
  runCalendarCheck, runCalendarFetch,
  isPreEventRisk, isPostEventSuppressed,
  getUpcomingHighImpactEvents, getEventSentiment,
  calculateEventSentiment, EVENT_IMPACT_SYMBOLS
};
