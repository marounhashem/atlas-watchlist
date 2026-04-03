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

// Currency → affected ATLAS symbols (forex pairs always affected by their currency)
// Indices and commodities use selective routing via isEventRelevant()
const EVENT_IMPACT_SYMBOLS = {
  USD: ['OILWTI','BTCUSD',
        'EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD',
        'EURJPY','GBPJPY','AUDJPY','EURAUD','EURGBP','EURCHF','GBPCHF'],
  EUR: ['EURUSD','EURGBP','EURJPY','EURAUD','EURCHF','DE40'],
  GBP: ['GBPUSD','EURGBP','GBPJPY','GBPCHF','UK100'],
  JPY: ['USDJPY','EURJPY','GBPJPY','AUDJPY','J225'],
  AUD: ['AUDUSD','EURAUD','AUDJPY','NZDUSD'],
  NZD: ['NZDUSD'],
  CAD: ['USDCAD'],
  CHF: ['USDCHF','EURCHF','GBPCHF'],
  CNY: ['CN50','HK50','COPPER'],
};

// Events that actually move indices (macro, political, monetary)
const INDEX_MOVING_KEYWORDS = [
  'Non-Farm', 'NFP', 'FOMC', 'Fed Chair', 'Federal Reserve', 'Powell',
  'CPI', 'GDP', 'Retail Sales', 'ISM Manufacturing', 'ISM Services',
  'Trump', 'President', 'Tariff', 'PCE', 'Consumer Confidence'
];

// Events that move precious metals (monetary, political, safe-haven)
const METALS_MOVING_KEYWORDS = [
  'Non-Farm', 'NFP', 'FOMC', 'Fed Chair', 'Powell', 'CPI', 'GDP',
  'Trump', 'President', 'Tariff', 'PCE', 'Rate Decision'
];

const INDEX_SYMBOLS = ['US30','US100','US500','DE40','UK100','J225','HK50','CN50'];
const METALS_SYMBOLS = ['GOLD','SILVER','PLATINUM','COPPER'];

// Check if an event is relevant to a specific symbol
function isEventRelevant(eventTitle, symbol) {
  const title = eventTitle.toLowerCase();
  if (INDEX_SYMBOLS.includes(symbol)) {
    return INDEX_MOVING_KEYWORDS.some(k => title.includes(k.toLowerCase()));
  }
  if (METALS_SYMBOLS.includes(symbol)) {
    return METALS_MOVING_KEYWORDS.some(k => title.includes(k.toLowerCase()));
  }
  return true; // forex pairs + OILWTI + crypto: always relevant
}

// ── Eastern → UTC conversion ────────────────────────────────────────────────
// FairEconomy FF calendar publishes times in US Eastern (EDT/EST)
// EDT (Mar–Nov) = UTC-4, EST (Nov–Mar) = UTC-5
// We must convert to UTC before storing so all system comparisons work
function easternToUTC(dateStr, timeStr) {
  if (!timeStr) return '00:00:00';
  const [h, m, s] = timeStr.split(':').map(Number);
  // Determine DST: approximate — EDT from second Sunday of March to first Sunday of November
  const month = dateStr ? new Date(dateStr + 'T12:00:00Z').getMonth() + 1 : 1;
  const offset = (month >= 3 && month <= 10) ? 4 : 5; // EDT=4, EST=5
  const utcH = h + offset;
  // Handle day rollover — date stays the same for simplicity (events rarely cross midnight)
  const finalH = utcH % 24;
  return String(finalH).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s || 0).padStart(2, '0');
}

// Post-event state: { symbol: { firedAt, title, actual, forecast, sentiment } }
const postEventState = {};
const VOLATILITY_MS = 5 * 60 * 1000;   // 5min hard block
const OPPORTUNITY_MS = 120 * 60 * 1000; // 2h enhanced scoring

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

  // ── Stage 2 — actual vs forecast (immediate reaction) ────────────────────
  let beat = 0;
  let magnitude = 'SMALL';
  let pctDelta = 0;

  if (!isNaN(actual) && !isNaN(forecast) && forecast !== 0) {
    const delta = actual - forecast;
    pctDelta = Math.round(Math.abs(delta / forecast) * 1000) / 10;

    const isBearishEnergy = BEARISH_HIGHER_ENERGY.some(e => event.title.includes(e));
    const isBullishEnergy = BULLISH_HIGHER_ENERGY.some(e => event.title.includes(e));
    const isBullishHigher = BULLISH_HIGHER.some(e => event.title.includes(e))
      || HAWKISH_HIGHER.some(e => event.title.includes(e))
      || isBullishEnergy;
    const isBearishHigher = BEARISH_HIGHER.some(e => event.title.includes(e))
      || isBearishEnergy;

    if (delta > 0) beat = isBullishHigher ? 1 : isBearishHigher ? -1 : 1;
    if (delta < 0) beat = isBullishHigher ? -1 : isBearishHigher ? 1 : -1;
    if (isBearishEnergy && delta > 0) beat = -1;
    if (isBearishEnergy && delta < 0) beat = 1;

    magnitude = pctDelta < 0.5 ? 'SMALL' : pctDelta < 2.0 ? 'MEDIUM' : 'LARGE';
  } else if (!isNaN(actual) && !isNaN(previous) && previous !== 0) {
    // No forecast — fall back to actual vs previous only
    beat = actual > previous ? 1 : actual < previous ? -1 : 0;
  }

  if (beat === 0 && isNaN(forecast)) return null;

  // ── Stage 3 — actual vs previous (trend context) ─────────────────────────
  let trend = 0;
  let trendMagnitude = 'SMALL';
  let trendSummary = '';

  if (!isNaN(actual) && !isNaN(previous) && previous !== 0) {
    const vsPrevious = actual - previous;
    const prevThreshold = Math.abs(previous * 0.1) || 0.1;

    if (Math.abs(vsPrevious) > prevThreshold * 3) trendMagnitude = 'LARGE';
    else if (Math.abs(vsPrevious) > prevThreshold) trendMagnitude = 'MEDIUM';

    trend = vsPrevious > 0 ? 1 : vsPrevious < 0 ? -1 : 0;

    const title = event.title.toLowerCase();
    if (title.includes('non-farm') || title.includes('nfp')) {
      if (trend === 1 && trendMagnitude === 'LARGE')
        trendSummary = `NFP ${actual}K — massive recovery from ${previous}K — trend turning`;
      else if (trend === 1)
        trendSummary = `NFP ${actual}K improving from ${previous}K — trend recovering`;
      else if (trend === -1)
        trendSummary = `NFP ${actual}K deteriorating from ${previous}K — trend weakening`;
    } else if (title.includes('cpi') || title.includes('inflation')) {
      if (trend === 1) trendSummary = `CPI ${event.actual} rising from ${event.previous} — inflation accelerating`;
      else if (trend === -1) trendSummary = `CPI ${event.actual} falling from ${event.previous} — inflation cooling`;
    } else if (title.includes('unemployment')) {
      if (trend === -1) trendSummary = `Unemployment ${event.actual} improving from ${event.previous} — labour market strengthening`;
      else if (trend === 1) trendSummary = `Unemployment ${event.actual} rising from ${event.previous} — labour market deteriorating`;
    } else if (title.includes('gdp')) {
      if (trend === 1) trendSummary = `GDP ${event.actual} accelerating from ${event.previous}`;
      else if (trend === -1) trendSummary = `GDP ${event.actual} slowing from ${event.previous}`;
    } else if (title.includes('hourly earnings')) {
      if (trend === 1) trendSummary = `Earnings ${event.actual} rising from ${event.previous} — wage inflation building`;
      else if (trend === -1) trendSummary = `Earnings ${event.actual} cooling from ${event.previous} — wage pressure easing`;
    }
  }

  // ── Combined signal strength ─────────────────────────────────────────────
  // Beat + positive trend = strongest signal
  // Beat + negative trend = mixed (downgrade)
  let combinedStrength = magnitude;
  if (beat === trend && beat !== 0) {
    combinedStrength = (trendMagnitude === 'LARGE' || magnitude === 'LARGE') ? 'LARGE' : 'MEDIUM';
  } else if (beat !== 0 && trend !== 0 && beat !== trend) {
    combinedStrength = 'SMALL';
    if (trendSummary) trendSummary += ' · conflicting with trend';
  }

  const beatLabel = beat > 0 ? 'beat' : beat < 0 ? 'missed' : 'in-line';
  const summary = [
    `${event.title} ${beatLabel} (${event.actual || actual} vs ${event.forecast || '—'} forecast)`,
    trendSummary
  ].filter(Boolean).join(' · ');

  return {
    beat,
    trend,
    magnitude: combinedStrength,
    pctDelta,
    trendSummary,
    actual: event.actual || String(actual),
    forecast: event.forecast,
    previous: event.previous,
    summary,
    raw: {
      actual, forecast, previous,
      vsForecast: !isNaN(forecast) ? actual - forecast : null,
      vsPrevious: !isNaN(previous) ? actual - previous : null
    }
  };
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
function buildAffectedSymbols(currency, feedSources, eventTitle) {
  const symbols = new Set(EVENT_IMPACT_SYMBOLS[currency] || []);
  for (const src of feedSources) {
    const feed = FEEDS.find(f => f.name === src);
    if (feed?.symbols) feed.symbols.forEach(s => symbols.add(s));
  }
  // Political/Fed speeches route to all precious metals + indices
  const title = (eventTitle || '').toLowerCase();
  if (title.includes('trump') || title.includes('president') || title.includes('fed chair') || title.includes('powell')) {
    METALS_SYMBOLS.forEach(s => symbols.add(s));
    INDEX_SYMBOLS.forEach(s => symbols.add(s));
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
    console.log(`[Calendar] Processing ${highImpact.length} HIGH impact events for storage...`);

    for (const { event: e, sources } of highImpact) {
      // FF dates are in US Eastern time — convert to UTC for storage
      const eventDate = e.date ? e.date.slice(0, 10) : null;
      const rawTime = e.date ? e.date.slice(11, 19) || null : null;
      if (!eventDate) continue;
      const eventTime = easternToUTC(eventDate, rawTime);
      const eventId = `${e.country}_${eventDate}_${e.title}`;
      const sourcesArr = Array.from(sources);

      // Check if forecast just appeared (new event or forecast was null before)
      let forecastJustAppeared = false;
      try {
        const dbMod = require('./db');
        // Use getAllEconomicEvents to find existing record
        const allEvts = dbMod.getAllEconomicEvents ? dbMod.getAllEconomicEvents() : [];
        const existing = allEvts.find(ev => ev.event_id === eventId);
        if (e.forecast && (!existing || !existing.forecast)) forecastJustAppeared = true;
      } catch(fe) {}

      try {
        upsertEconomicEvent({
          eventId, title: e.title, currency: e.country,
          eventDate, eventTime, impact: e.impact,
          forecast: e.forecast || null, previous: e.previous || null
        });
        stored++;
      } catch(ue) {
        console.error(`[Calendar] upsert error for ${e.title}:`, ue.message);
      }

      // Send forecast alert when forecast first appears on an upcoming event
      if (forecastJustAppeared && e.forecast) {
        const eventTsF = new Date(e.date).getTime();
        if (eventTsF > Date.now()) {
          try {
            sendForecastAlert({
              title: e.title, currency: e.country,
              forecast: e.forecast, previous: e.previous,
              event_date: eventDate, event_time: eventTime
            });
          } catch(fa) { console.error('[Calendar] Forecast alert error:', fa.message); }
        }
      }

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
          const affectedSymbols = buildAffectedSymbols(e.country, sourcesArr, e.title);

          // Set post-event state for all affected symbols
          for (const sym of affectedSymbols) {
            postEventState[sym] = {
              firedAt: Date.now(),
              title: e.title,
              actual: e.actual || 'Released',
              forecast: e.forecast,
              sentiment
            };
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
function isPreEventRisk(symbol, hours = 10/60) { // 10 minutes default
  try {
    const { getUpcomingEvents } = require('./db');
    const rows = getUpcomingEvents(3);
    const now = new Date();

    for (const r of rows) {
      // Build affected symbols list from currency + feed-specific
      const affected = new Set(EVENT_IMPACT_SYMBOLS[r.currency] || []);
      for (const f of FEEDS) {
        if (f.symbols) f.symbols.forEach(s => affected.add(s));
      }
      // Political/Fed speeches also affect precious metals
      const title = (r.title || '').toLowerCase();
      if (title.includes('trump') || title.includes('president') || title.includes('fed chair') || title.includes('powell')) {
        METALS_SYMBOLS.forEach(s => affected.add(s));
        INDEX_SYMBOLS.forEach(s => affected.add(s));
      }
      if (!affected.has(symbol)) continue;

      // Selective: indices and metals only penalised for relevant events
      if (!isEventRelevant(r.title, symbol)) continue;

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

// ── Post-event state (3 phases: VOLATILITY → OPPORTUNITY → NORMAL) ──────────
function getPostEventState(symbol) {
  const state = postEventState[symbol];
  if (!state) return { phase: 'NORMAL' };

  const elapsed = Date.now() - state.firedAt;

  if (elapsed < VOLATILITY_MS) {
    return {
      phase: 'VOLATILITY',
      minutesAgo: Math.round(elapsed / 60000),
      event: state.title,
      tag: `VOLATILITY — ${state.title} fired ${Math.round(elapsed / 60000)}min ago`
    };
  }

  if (elapsed < OPPORTUNITY_MS) {
    return {
      phase: 'OPPORTUNITY',
      minutesAgo: Math.round(elapsed / 60000),
      event: state.title,
      sentiment: state.sentiment,
      actual: state.actual,
      forecast: state.forecast
    };
  }

  // Expired — clean up
  delete postEventState[symbol];
  return { phase: 'NORMAL' };
}

// Backward compat
function isPostEventSuppressed(symbol) {
  return getPostEventState(symbol).phase === 'VOLATILITY';
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

// ── Forecast-based pre-release bias ────────────────────────────────────────
// Uses forecast vs previous to generate directional bias BEFORE event fires.
// Only applies when event is >10min away (inside 10min = pre-event suppression).

function getForecastBias(symbol) {
  const db = require('./db');
  const now = Date.now();
  const currencies = EVENT_IMPACT_SYMBOLS;

  // Which currencies affect this symbol?
  const symCurrencies = [];
  for (const [ccy, syms] of Object.entries(currencies)) {
    if (syms.includes(symbol)) symCurrencies.push(ccy);
  }
  if (symCurrencies.length === 0) return null;

  try {
    const nowISO = new Date(now).toISOString().slice(0, 19) + 'Z';
    const futISO = new Date(now + 24 * 3600000).toISOString().slice(0, 19) + 'Z';
    const upcoming = db.all(
      `SELECT * FROM economic_events
       WHERE fired = 0 AND impact = 'High'
       AND forecast IS NOT NULL AND forecast != ''
       AND previous IS NOT NULL AND previous != ''
       ORDER BY event_date, event_time`, []);

    for (const event of upcoming) {
      if (!symCurrencies.includes(event.currency)) continue;
      if (!isEventRelevant(event.title, symbol)) continue;

      // Parse event time
      let eventMs;
      try {
        const timeStr = event.event_time || '00:00:00';
        eventMs = new Date(event.event_date + 'T' + timeStr.slice(0, 8) + 'Z').getTime();
      } catch(e) { continue; }

      if (isNaN(eventMs) || eventMs < now || eventMs > now + 24 * 3600000) continue;

      const bias = calculateForecastBias(event);
      if (!bias) continue;

      const firesInMin = Math.round((eventMs - now) / 60000);
      return {
        event: event.title,
        currency: event.currency,
        forecast: event.forecast,
        previous: event.previous,
        bias: bias.direction,
        strength: bias.strength,
        firesInMin,
        firesIn: firesInMin > 60 ? Math.round(firesInMin / 60) + 'h' : firesInMin + 'min',
        summary: bias.summary
      };
    }
  } catch(e) {
    console.error('[Calendar] getForecastBias error:', e.message);
  }
  return null;
}

function calculateForecastBias(event) {
  const title = event.title.toLowerCase();
  const forecast = parseFloat(String(event.forecast).replace(/[%,K]/gi, ''));
  const previous = parseFloat(String(event.previous).replace(/[%,K]/gi, ''));

  if (isNaN(forecast) || isNaN(previous)) return null;

  const change = forecast - previous;
  const changePct = previous !== 0 ? Math.abs(change / previous * 100) : 0;

  // NFP / Non-Farm Employment
  if (title.includes('non-farm') || title.includes('nfp')) {
    if (forecast > previous * 1.5)
      return { direction: 1, strength: 3, summary: `NFP forecast ${event.forecast} vs prev ${event.previous} — strong USD expected` };
    if (forecast > previous)
      return { direction: 1, strength: 2, summary: `NFP forecast ${event.forecast} vs prev ${event.previous} — mild USD bullish` };
    if (forecast < previous * 0.5)
      return { direction: -1, strength: 3, summary: `NFP forecast ${event.forecast} vs prev ${event.previous} — weak USD expected` };
    if (forecast < previous)
      return { direction: -1, strength: 2, summary: `NFP forecast ${event.forecast} vs prev ${event.previous} — mild USD bearish` };
    return { direction: 0, strength: 1, summary: `NFP in line with previous — muted reaction expected` };
  }

  // CPI / Inflation
  if (title.includes('cpi') || title.includes('inflation')) {
    if (changePct > 0.2 && change > 0)
      return { direction: 1, strength: 2, summary: `CPI forecast ${event.forecast} vs prev ${event.previous} — hawkish signal` };
    if (changePct > 0.2 && change < 0)
      return { direction: -1, strength: 2, summary: `CPI forecast cooling — dovish signal` };
  }

  // Unemployment Rate
  if (title.includes('unemployment rate')) {
    if (forecast < previous)
      return { direction: 1, strength: 1, summary: `Unemployment forecast lower — mild positive` };
    if (forecast > previous)
      return { direction: -1, strength: 1, summary: `Unemployment forecast higher — mild negative` };
  }

  // Average Hourly Earnings
  if (title.includes('hourly earnings')) {
    if (forecast > previous)
      return { direction: 1, strength: 2, summary: `Earnings forecast ${event.forecast} vs prev ${event.previous} — wage inflation signal` };
    if (forecast < previous)
      return { direction: -1, strength: 1, summary: `Earnings forecast softer — mild dovish signal` };
  }

  // GDP
  if (title.includes('gdp')) {
    if (change > 0)
      return { direction: 1, strength: 2, summary: `GDP forecast improving — growth signal` };
    if (change < 0)
      return { direction: -1, strength: 2, summary: `GDP forecast deteriorating — weakness signal` };
  }

  // ISM / PMI
  if (title.includes('ism') || title.includes('pmi')) {
    const isExpansion = forecast > 50;
    const wasExpansion = previous > 50;
    if (isExpansion && !wasExpansion)
      return { direction: 1, strength: 2, summary: `${event.title} crossing into expansion — bullish` };
    if (!isExpansion && wasExpansion)
      return { direction: -1, strength: 2, summary: `${event.title} falling into contraction — bearish` };
    if (change > 2)
      return { direction: 1, strength: 1, summary: `${event.title} improving — mild bullish` };
    if (change < -2)
      return { direction: -1, strength: 1, summary: `${event.title} deteriorating — mild bearish` };
  }

  // Retail Sales
  if (title.includes('retail sales')) {
    if (change > 0)
      return { direction: 1, strength: 1, summary: `Retail Sales forecast higher — consumer strength` };
    if (change < 0)
      return { direction: -1, strength: 1, summary: `Retail Sales forecast lower — consumer weakness` };
  }

  // Rate Decision
  if (title.includes('rate decision') || title.includes('interest rate')) {
    if (change > 0)
      return { direction: 1, strength: 3, summary: `Rate hike expected (${event.forecast} vs ${event.previous}) — hawkish` };
    if (change < 0)
      return { direction: -1, strength: 3, summary: `Rate cut expected (${event.forecast} vs ${event.previous}) — dovish` };
  }

  return null;
}

// ── Event arrow formatting for Telegram ────────────────────────────────────
// Groups affected pairs by direction into single-line green/red rows
function getEventArrows(currency, bias) {
  // Map: which direction does each pair move when this currency strengthens?
  const CURRENCY_LONG = {
    USD: { long: ['USDJPY','USDCHF','USDCAD'], short: ['EURUSD','GBPUSD','AUDUSD','NZDUSD'] },
    EUR: { long: ['EURUSD','EURJPY','EURGBP','EURAUD','EURCHF'], short: [] },
    GBP: { long: ['GBPUSD','GBPJPY','GBPCHF'], short: ['EURGBP'] },
    JPY: { long: [], short: ['USDJPY','EURJPY','GBPJPY','AUDJPY'] },
    AUD: { long: ['AUDUSD','AUDJPY'], short: ['EURAUD'] },
    NZD: { long: ['NZDUSD'], short: [] },
    CAD: { long: [], short: ['USDCAD'] },
    CHF: { long: [], short: ['USDCHF','EURCHF','GBPCHF'] },
  };

  const map = CURRENCY_LONG[currency];
  if (!map) return '';

  let goLong, goShort;
  if (bias > 0) {
    // Currency strengthening
    goLong = map.long;
    goShort = map.short;
  } else {
    // Currency weakening
    goLong = map.short;
    goShort = map.long;
  }

  const lines = [];
  if (goLong.length) lines.push('🟢 ' + goLong.map(s => s + ' ↑').join('  '));
  if (goShort.length) lines.push('🔴 ' + goShort.map(s => s + ' ↓').join('  '));
  return lines.join('\n');
}

function getSpecialCaseNote(currency, bias) {
  if (currency !== 'USD') return '';
  const notes = [];
  if (bias > 0) {
    notes.push('📉 GOLD → likely down (USD strong)');
    notes.push('📉 US30/US100 → mixed (strong data vs rate fears)');
  } else if (bias < 0) {
    notes.push('📈 GOLD → likely up (USD weak)');
    notes.push('📈 US30/US100 → likely up (Fed dovish signal)');
  }
  return notes.join('\n');
}

// ── Forecast appears alert ─────────────────────────────────────────────────
function sendForecastAlert(event) {
  try {
    const fb = calculateForecastBias(event);
    const bias = fb ? fb.direction : 0;
    const biasSummary = fb ? fb.summary : '';

    const eventTs = new Date(
      event.event_date + 'T' + (event.event_time || '00:00:00') + 'Z'
    ).getTime();
    const minsUntil = Math.round((eventTs - Date.now()) / 60000);
    const timeLabel = minsUntil > 60
      ? Math.floor(minsUntil / 60) + 'h ' + (minsUntil % 60) + 'min'
      : minsUntil + 'min';

    const biasLine = bias > 0
      ? `📈 Forecast bullish for ${event.currency}`
      : bias < 0
      ? `📉 Forecast bearish for ${event.currency}`
      : '';

    const arrows = bias !== 0 ? getEventArrows(event.currency, bias) : '';
    const special = bias !== 0 ? getSpecialCaseNote(event.currency, bias) : '';

    const text = [
      `📅 <b>${event.title}</b>`,
      `Forecast: <b>${event.forecast}</b> | Previous: ${event.previous || '—'} | Fires in: ${timeLabel}`,
      biasLine,
      biasSummary ? `Pre-release bias: ${biasSummary}` : '',
      arrows,
      special,
      `⏳ Waiting for actual — pre-positioning window`,
    ].filter(Boolean).join('\n');

    const { sendMessage } = require('./telegram');
    sendMessage(text).catch(() => {});
    console.log(`[Calendar] Forecast alert sent: ${event.title} (${event.currency}) forecast=${event.forecast}`);
  } catch(e) {
    console.error('[Calendar] sendForecastAlert error:', e.message);
  }
}

module.exports = {
  runCalendarCheck, runCalendarFetch,
  isPreEventRisk, isPostEventSuppressed, getPostEventState,
  getUpcomingHighImpactEvents, getEventSentiment,
  calculateEventSentiment, buildAffectedSymbols,
  getForecastBias, getEventArrows, getSpecialCaseNote,
  EVENT_IMPACT_SYMBOLS, FEED_ICONS
};
