// server/stockScanner/sentiment.js
//
// This is the local "AI" layer. Two jobs:
//
//  1. Classify news into catalyst categories (earnings, FDA, M&A,
//     offering, guidance, partnership, legal, analyst). Day traders
//     treat these categories very differently — an FDA approval is
//     buyable, a dilutive offering is shortable. Category matters
//     more than raw sentiment.
//
//  2. Score sentiment using VADER (local, no API, no LLM cost). VADER
//     is the standard rule-based sentiment model for financial
//     headlines and handles negation/amplifiers reasonably well.
//
// We intentionally avoid LLM sentiment here: deterministic output,
// zero cost, fast enough to run on the whole universe.

const vader = require('vader-sentiment');

// Each catalyst category has a list of trigger phrases and a
// directional bias that the scorer uses to reconcile gap direction
// with catalyst flavour. A stock gapping UP on a DILUTION headline
// is a red flag — the gap will likely fade.
const CATALYSTS = [
  {
    id: 'earnings_beat',
    patterns: [/beats.*(estimates|expectations)/i, /tops.*(estimates|consensus)/i,
               /raises.*guidance/i, /guidance.*raised/i, /record.*(revenue|earnings)/i,
               /q[1-4].*beat/i, /earnings.*beat/i],
    bias: +1,
    weight: 0.9,
  },
  {
    id: 'earnings_miss',
    patterns: [/misses.*(estimates|expectations)/i, /falls short/i,
               /cuts.*guidance/i, /guidance.*cut/i, /lowers.*guidance/i,
               /earnings.*miss/i, /disappointing.*(results|quarter)/i],
    bias: -1,
    weight: 0.9,
  },
  {
    id: 'fda_approval',
    patterns: [/fda.*(approve|approval|approved|clearance|cleared)/i,
               /breakthrough therapy/i, /orphan drug/i,
               /phase [23].*(success|positive|meet)/i],
    bias: +1,
    weight: 1.0,
  },
  {
    id: 'fda_rejection',
    patterns: [/fda.*(reject|refuses|crl|complete response letter)/i,
               /trial.*(fail|halt|suspended)/i, /phase [23].*(fail|miss)/i],
    bias: -1,
    weight: 1.0,
  },
  {
    id: 'ma_acquirer_rumor',
    patterns: [/in talks to acquire/i, /rumored.*acquisition/i, /considering.*bid/i,
               /exploring.*(acquisition|merger)/i],
    bias: 0, // context dependent
    weight: 0.7,
  },
  {
    id: 'ma_target',
    patterns: [/to be acquired/i, /acquisition of.*(for|at)/i, /agreed to acquire/i,
               /takeover bid/i, /buyout offer/i],
    bias: +1,
    weight: 1.0,
  },
  {
    id: 'dilutive_offering',
    patterns: [/secondary offering/i, /public offering/i, /priced at/i,
               /share issuance/i, /registered direct/i, /atm offering/i,
               /prices.*million shares/i],
    bias: -1,
    weight: 0.95,
  },
  {
    id: 'buyback',
    patterns: [/buyback/i, /repurchase program/i, /share repurchase/i,
               /authorized.*repurchase/i],
    bias: +1,
    weight: 0.6,
  },
  {
    id: 'analyst_upgrade',
    patterns: [/upgraded? (to|by)/i, /raises price target/i, /initiated.*(buy|overweight|outperform)/i,
               /target.*raised/i],
    bias: +1,
    weight: 0.5,
  },
  {
    id: 'analyst_downgrade',
    patterns: [/downgraded? (to|by)/i, /cuts price target/i, /initiated.*(sell|underweight|underperform)/i,
               /target.*cut/i],
    bias: -1,
    weight: 0.5,
  },
  {
    id: 'partnership',
    patterns: [/partnership with/i, /strategic.*(agreement|partnership|collaboration)/i,
               /licensing agreement/i, /signs.*deal/i],
    bias: +1,
    weight: 0.6,
  },
  {
    id: 'legal_negative',
    patterns: [/sec.*investigat/i, /class action/i, /lawsuit/i, /doj.*(probe|investigation)/i,
               /sanctions/i, /fraud/i, /subpoena/i],
    bias: -1,
    weight: 0.8,
  },
  {
    id: 'ceo_departure',
    patterns: [/ceo.*(resign|steps down|fired|out)/i, /chief executive.*resigns/i],
    bias: -1,
    weight: 0.6,
  },
  {
    id: 'reverse_split',
    patterns: [/reverse.*split/i, /[1-9]-for-[1-9].*reverse/i],
    bias: -1,
    weight: 0.7,
  },
];

/**
 * Classify a list of headlines into the best-matching catalyst
 * category and compute an aggregate sentiment score.
 */
function classify(headlines) {
  if (!headlines?.length) {
    return {
      topCatalyst: null,
      catalystBias: 0,
      catalystStrength: 0,
      sentiment: 0,
      matched: [],
    };
  }

  // Collect all matches across all headlines. Each headline can trigger
  // multiple catalysts (e.g. "beats estimates AND raises guidance").
  const matches = [];
  for (const h of headlines) {
    const text = `${h.headline} ${h.summary || ''}`;
    for (const cat of CATALYSTS) {
      if (cat.patterns.some(p => p.test(text))) {
        matches.push({ ...cat, headline: h.headline, url: h.url });
      }
    }
  }

  // Rank catalysts by total weight. The "top" catalyst is the one
  // with the highest cumulative weight across all headlines.
  const byCatalyst = new Map();
  for (const m of matches) {
    const acc = byCatalyst.get(m.id) || { ...m, count: 0, totalWeight: 0 };
    acc.count += 1;
    acc.totalWeight += m.weight;
    byCatalyst.set(m.id, acc);
  }

  const ranked = [...byCatalyst.values()].sort((a, b) => b.totalWeight - a.totalWeight);
  const top = ranked[0] || null;

  // Sentiment across all headlines. VADER returns compound in [-1, 1].
  const sentScores = headlines.map(h =>
    vader.SentimentIntensityAnalyzer.polarity_scores(h.headline).compound
  );
  const sentiment = sentScores.length
    ? sentScores.reduce((a, b) => a + b, 0) / sentScores.length
    : 0;

  return {
    topCatalyst: top?.id || null,
    catalystBias: top?.bias ?? 0,
    catalystStrength: top ? Math.min(1, top.totalWeight) : 0,
    sentiment: Math.round(sentiment * 100) / 100,
    matched: ranked.map(r => ({ id: r.id, count: r.count, weight: r.totalWeight })),
  };
}

module.exports = { classify, CATALYSTS };
