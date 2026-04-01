// Economic Calendar — HIGH impact events from 4 FairEconomy feeds
// FF (forex/macro), EE (energy), MM (metals), CC (crypto)
// Polled every 5 minutes — deduped by title+date, sources tracked
// Pre-event risk: caps signals to WATCH within 2h
// Post-event suppression: caps score at 65 for 30min after event fires

// ── Feed configuration ──────────────────────────────────────────────────────
const FEEDS = [
  { name: 'FF', url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json', symbols: null },
  { name: 'EE', url: 'https://nfs.faireconomy.media/ee_calendar_thisweek.json', symbols: ['OILWTI', 'USDCAD'] },
  { name: 'MM', url: 'https://nfs.faireconomy.media/mm_calendar_thisweek.json', symbols: ['GOLD', 'SILVER'] },
  { name: 'CC', url: 'https://nfs.faireconomy.media/cc_calendar_thisweek.json', symbols: ['BTCUSD', 'ETHUSD'] },
];
const FF_NEXT = 'https://nfs.faireconomy.media/ff_calendar_nextweek.json';

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
const SUPPRESSION_MS = 30 * 60 * 1000;

// Feed icon mapping
const FEED_ICONS = { FF: '📊', EE: '🛢️', MM: '🥇', CC: '₿' };

// ── Event sentiment calculation ──────────────────────────────────────────────
const BULLISH_HIGHER = ['Non-Farm', 'GDP', 'Retail Sales', 'Manufacturing PMI',
  'Services PMI', 'Employment Change', 'Consumer Confidence', 'Trade Balance',
  'ISM Manufacturing', 'ISM Services', 'ADP Non-Farm'];
const BEARISH_HIGHER = ['Unemployment Rate', 'Unemployment Claims',
  'Initial Jobless Claims'];
const HAWKISH_HIGHER = ['CPI', 'Core CPI', 'PCE', 'Core PCE', 'PPI',
  'Average Hourly Earnings'];

// Energy-specific
const BEARISH_HIGHER_ENERGY = ['Crude Oil Inventories', 'Cushing Crude',
  'Natural Gas Storage', 'Distillate Fuel'];
const BULLISH_HIGHER_ENERGY = ['Rig Count'];

// Metals — strong economy = less safe haven = bearish metals
const BEARISH_METALS_HIGHER = ['Manufacturing PMI', 'ISM Manufacturing', 'Retail Sales'];
const BULLISH_METALS_HIGHER = ['CPI', 'Core CPI', 'Inflation', 'Jobless Claims', 'Unemployment'];

function calculateEventSentiment(event) {
  const actual = parseFloat(event.actual || event.forecast);
  const forecast = parseFloat(event.forecast);
  const previous = parseFloat(event.previous);

  if (isNaN(actual) && isNaN(forecast)) return null;

  if (!isNaN(actual) && !isNaN(forecast) && forecast !== 0) {
    const delta = actual - forecast;
    const pctDelta = Math.round(Math.abs(delta / forecast) * 1000) / 10;

    // Check commodity-specific rules first
    const isBearishEnergy = BEARISH_HIGHER_ENERGY.some(e => event.title.includes(e));
    const isBullishEnergy = BULLISH_HIGHER_ENERGY.some(e => event.title.includes(e));

    const isBullishHigher = BULLISH_HIGHER.some(e => event.title.includes(e))
      || HAWKISH_HIGHER.some(e => event.title.includes(e))
      || isBullishEnergy;
    const isBearishHigher = BEARISH_HIGHER.some(e => event.title.includes(e))
      || isBearishEnergy;

    let beat = 0;
    if (delta > 0) beat = isBullishHigher ? 1 : isBearishHigher ? -1 : 1;
    if (delta < 0) beat = isBullishHigher ? -1 : isBearishHigher ? 1 : -1;

    // Special: crude inventories higher = bearish OIL (supply up)
    if (isBearishEnergy && delta > 0) beat = -1;
    if (isBearishEnergy && delta < 0) beat = 1;

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

// ── Get combined sentiment from recent fired events for a currency ──────────
function getEventSentiment(currency) {
  try {
    const { getRecentFiredEvents } = require('./db');
    const recent = getRecentFiredEvents(4);
    const forCurrency = recent.filter(e => e.currency === currency && e.sentiment !== 0);
    if (forCurrency.length === 0) return null;

    let totalBeat = 0, count = 0, lastSummary = '';
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
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ATLAS-Watchlist/1.0' }
    });
    if (!res.ok) return [];
    return res.json();
  } catch(e) { return []; }
}

// ── Build affected symbols for an event ─────────────────────────────────────
function buildAffectedSymbols(currency, feedSources) {
  const symbols = new Set(EVENT_IMPACT_SYMBOLS[currency] || []);
  // Add feed-specific symbols
  for (const src of feedSources) {
    const feed = FEEDS.find(f => f.name === src);
    if (feed?.symbols) feed.symbols.forEach(s => symbols.add(s));
  }
  return Array.from(symbols);
}

// ── Full fetch — all feeds, dedup, store, detect fired ──────────────────────
async function runCalendarCheck(broadcast) {
  let stored = 0;
  let fired = 0;
  const sourceCounts = {};

  try {
    // Fetch all feeds in parallel
    const feedPromises = FEEDS.map(async f => {
      const events = await fetchCalendarURL(f.url);
      sourceCounts[f.name] = events.length;
      return events.map(e => ({ ...e, _source: f.name }));
    });
    // Also fetch FF next week
    const ffNextPromise = fetchCalendarURL(FF_NEXT).then(events => {
      sourceCounts['FF_NEXT'] = events.length;
      return events.map(e => ({ ...e, _source: 'FF' }));
    });

    const results = await Promise.all([...feedPromises, ffNextPromise]);
    const allRaw = results.flat();

    // Dedup by title+currency+date — merge sources
    const dedupMap = new Map(); // key → { event, sources: Set }
    let dupeCount = 0;
    for (const e of allRaw) {
      if (!e.date || !RELEVANT_CURRENCIES.includes(e.country)) continue;
      const key = `${e.title.toLowerCase().trim()}|${e.country}|${e.date.slice(0, 10)}`;
      if (dedupMap.has(key)) {
        dedupMap.get(key).sources.add(e._source);
        dupeCount++;
      } else {
        dedupMap.set(key, { event: e, sources: new Set([e._source]) });
      }
    }

    const deduped = Array.from(dedupMap.values());
    const highImpact = deduped.filter(d => d.event.impact === 'High');

    const totalFetched = allRaw.length;
    if (totalFetched > 0) {
      const feedSummary = Object.entries(sourceCounts).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`[Calendar] ${totalFetched} raw (${feedSummary}), ${deduped.length} deduped (${dupeCount} dupes), ${highImpact.length} HIGH`);
    }

    const { upsertEconomicEvent, markEventFired } = require('./db');

    for (const { event: e, sources } of highImpact) {
      const eventDate = e.date.slice(0, 10);
      const eventTime = e.date.slice(11, 19) || null;
      const eventId = `${e.country}_${eventDate}_${e.title}`;
      const sourcesArr = Array.from(sources);

      upsertEconomicEvent({
        eventId, title: e.title, currency: e.country,
        eventDate, eventTime, impact: e.impact,
        forecast: e.forecast || null, previous: e.previous || null
      });
      stored++;

      // Detect fired events
      const eventTs = new Date(e.date);
      const minutesSince = (Date.now() - eventTs) / 60000;

      if (minutesSince >= 0 && minutesSince <= 120) {
        const sentiment = calculateEventSentiment({
          title: e.title, currency: e.country,
          actual: e.actual || e.forecast,
          forecast: e.forecast, previous: e.previous
        });

        const wasFired = markEventFired(eventId, sentiment);
        if (wasFired) {
          fired++;
          const affectedSymbols = buildAffectedSymbols(e.country, sourcesArr);

          const suppressUntil = Date.now() + SUPPRESSION_MS;
          for (const sym of affectedSymbols) {
            postEventSuppression[sym] = Math.max(postEventSuppression[sym] || 0, suppressUntil);
          }

          const sentimentLabel = sentiment ? ` | ${sentiment.summary}` : '';
          console.log(`[Calendar] EVENT FIRED: ${e.title} (${e.country}) [${sourcesArr.join('+')}]${sentimentLabel} — suppressing ${affectedSymbols.length} symbols`);

          try {
            const { sendEventFiredAlert } = require('./telegram');
            sendEventFiredAlert({
              title: e.title, currency: e.country,
              actual: e.actual || 'Released',
              forecast: e.forecast, previous: e.previous
            }, sentiment, affectedSymbols).catch(() => {});
          } catch(te) {}

          if (broadcast) {
            broadcast({
              type: 'EVENT_FIRED', event: e.title, currency: e.country,
              sources: sourcesArr, forecast: e.forecast,
              symbols_affected: affectedSymbols, ts: Date.now()
            });
          }
        }
      }
    }
  } catch(e) {
    console.error('[Calendar] Fetch error:', e.message);
  }

  if (stored > 0 || fired > 0) {
    console.log(`[Calendar] Complete — ${stored} stored, ${fired} fired`);
  }

  sourceCounts.deduplicated = Object.values(sourceCounts).reduce((a, b) => a + b, 0) - stored;
  return { stored, fired, sources: sourceCounts };
}

async function runCalendarFetch() { return runCalendarCheck(null); }

// ── Pre-event risk check ────────────────────────────────────────────────────
function isPreEventRisk(symbol, hours = 2) {
  try {
    const { getUpcomingEvents } = require('./db');
    const rows = getUpcomingEvents(3);
    const now = new Date();

    for (const r of rows) {
      const affected = EVENT_IMPACT_SYMBOLS[r.currency] || [];
      // Also check feed-specific symbols from any feed that tracks this currency
      const allAffected = new Set(affected);
      for (const f of FEEDS) {
        if (f.symbols) f.symbols.forEach(s => allAffected.add(s));
      }
      if (!allAffected.has(symbol)) continue;

      const eventTs = new Date(r.event_date + 'T' + (r.event_time || '12:00:00') + 'Z');
      const minutesUntil = Math.round((eventTs - now) / 60000);

      if (minutesUntil >= -5 && minutesUntil <= hours * 60) {
        return { title: r.title, currency: r.currency, date: r.event_date,
                 time: r.event_time, minutesUntil, hoursUntil: Math.round(minutesUntil / 60) };
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
  delete postEventSuppression[symbol];
  return false;
}

// ── Get upcoming HIGH impact events ─────────────────────────────────────────
function getUpcomingHighImpactEvents(days = 7) {
  try {
    const { getUpcomingEvents } = require('./db');
    const rows = getUpcomingEvents(days);
    return rows.map(r => ({
      title: r.title, currency: r.currency,
      date: r.event_date, time: r.event_time,
      impact: r.impact, forecast: r.forecast,
      previous: r.previous, actual: r.actual,
      fired: r.fired === 1, isEconomicEvent: true,
      daysUntil: Math.ceil((new Date(r.event_date + 'T12:00:00Z') - new Date()) / (24 * 60 * 60 * 1000))
    }));
  } catch(e) { return []; }
}

module.exports = {
  runCalendarCheck, runCalendarFetch,
  isPreEventRisk, isPostEventSuppressed,
  getUpcomingHighImpactEvents, getEventSentiment,
  calculateEventSentiment, buildAffectedSymbols,
  EVENT_IMPACT_SYMBOLS, FEED_ICONS
};
