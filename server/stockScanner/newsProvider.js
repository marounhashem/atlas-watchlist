// server/stockScanner/newsProvider.js
//
// A gap without a news catalyst is dangerous — it's often a halt, a
// short squeeze, or an algo overshooting. This module fetches recent
// headlines from two free sources:
//
//   1. Finnhub /company-news  — free tier, needs FINNHUB_API_KEY.
//      60 req/min is plenty for a watchlist of 20-30 pre-market gappers.
//   2. Yahoo Finance news via yahoo-finance2 — free, no key,
//      decent recency but sometimes misses obscure tickers.
//
// We merge, dedupe on URL, and only keep headlines from the last 36h.
// That window is deliberately generous: earnings released the previous
// evening frequently drive pre-market gaps the next morning.

const yahooFinance = require('yahoo-finance2').default;

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const LOOKBACK_HOURS = 36;

async function fetchNews(symbol) {
  const [finnhub, yahoo] = await Promise.all([
    fetchFinnhub(symbol).catch(() => []),
    fetchYahooNews(symbol).catch(() => []),
  ]);

  const combined = [...finnhub, ...yahoo];
  const byUrl = new Map();
  for (const item of combined) {
    if (!item.url || !item.headline) continue;
    if (byUrl.has(item.url)) continue;
    byUrl.set(item.url, item);
  }

  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  return [...byUrl.values()]
    .filter(it => it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 10);
}

async function fetchFinnhub(symbol) {
  if (!FINNHUB_KEY) return [];
  const from = isoDate(daysAgo(3));
  const to = isoDate(new Date());
  const url = `https://finnhub.io/api/v1/company-news` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&from=${from}&to=${to}` +
    `&token=${FINNHUB_KEY}`;

  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data.map(n => ({
    headline: n.headline,
    summary: n.summary || '',
    source: n.source || 'finnhub',
    url: n.url,
    publishedAt: (n.datetime || 0) * 1000, // Finnhub returns unix seconds
  }));
}

async function fetchYahooNews(symbol) {
  // yahoo-finance2's `search` call returns news alongside quote matches.
  // It's a less predictable shape, hence all the optional chains.
  const res = await yahooFinance.search(symbol, {
    newsCount: 10,
    quotesCount: 0,
  }).catch(() => null);

  if (!res?.news) return [];

  return res.news.map(n => ({
    headline: n.title,
    summary: '',
    source: n.publisher || 'yahoo',
    url: n.link,
    publishedAt: new Date(n.providerPublishTime * 1000).getTime(),
  })).filter(n => Number.isFinite(n.publishedAt));
}

// ----- helpers -----

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

module.exports = { fetchNews };
