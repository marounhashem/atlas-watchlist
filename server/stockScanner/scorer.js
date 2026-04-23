// server/stockScanner/scorer.js
//
// Scores each pre-market candidate on a 0–100 scale. The score is a
// weighted combination of the five factors from the user's playbook:
//
//   1. Gap size       — |gap%| calibrated to the 3–20% sweet spot
//   2. Relative volume— 2x+ is the entry point, 5x+ is premium
//   3. Volatility     — ATR% ensures the stock actually moves intraday
//   4. Liquidity      — avg volume + spread + float gate
//   5. Catalyst align — is the gap direction consistent with the news?
//
// Each factor has a hard gate (minimum thresholds) and a soft score
// (0–100 within-factor). Signals that fail any hard gate are rejected
// entirely so they never appear in the watchlist.
//
// Scoring version is bumped when weights change — same pattern as the
// main ATLAS scorer. Keep a changelog in CLAUDE.md.

const STOCK_SCORER_VERSION = '20260421.1';

// --- Hard gates (absolute minimums) ---
const GATES = {
  minGapPctAbs: 3.0,       // Sub-3% gaps don't have enough juice
  maxGapPctAbs: 60.0,      // >60% gaps are almost always halts/biotech traps
  minRvol: 1.8,            // 1.8x pre-market volume vs norm
  minAvgDailyVolume: 500_000, // liquidity floor — under this, spreads kill you
  minPrice: 2.00,          // penny-stock territory = different game
  maxSpreadPct: 0.5,       // bid/ask > 0.5% = scalps eat all profit
};

// --- Weights for soft score (must sum to 1.0) ---
const WEIGHTS = {
  gap: 0.25,
  rvol: 0.30,
  volatility: 0.15,
  liquidity: 0.10,
  catalyst: 0.20,
};

/**
 * Score one enriched candidate.
 * Input shape: market-data fields from dataProvider + sentiment/catalyst
 * fields from sentiment.classify(). Returns { score, breakdown, rejected }.
 */
function scoreCandidate(c) {
  // --- Gate checks ---
  const reasons = [];
  const gapAbs = Math.abs(c.gapPct);
  if (gapAbs < GATES.minGapPctAbs) reasons.push(`gap ${c.gapPct}% < ${GATES.minGapPctAbs}%`);
  if (gapAbs > GATES.maxGapPctAbs) reasons.push(`gap ${c.gapPct}% > ${GATES.maxGapPctAbs}%`);
  if (c.rvol < GATES.minRvol) reasons.push(`rvol ${c.rvol}x < ${GATES.minRvol}x`);
  if (c.avgVolume < GATES.minAvgDailyVolume) reasons.push(`avgVol ${c.avgVolume} < ${GATES.minAvgDailyVolume}`);
  if (c.preMarketPrice < GATES.minPrice) reasons.push(`price $${c.preMarketPrice} < $${GATES.minPrice}`);

  const spreadPct = (c.bid && c.ask && c.ask > 0)
    ? ((c.ask - c.bid) / c.ask) * 100
    : null;
  if (spreadPct !== null && spreadPct > GATES.maxSpreadPct) {
    reasons.push(`spread ${spreadPct.toFixed(2)}% > ${GATES.maxSpreadPct}%`);
  }

  if (reasons.length > 0) {
    return { score: 0, rejected: true, reasons, breakdown: null };
  }

  // --- Soft scoring per factor ---
  const gapScore = gapScoreFn(c.gapPct);
  const rvolScore = rvolScoreFn(c.rvol);
  const volScore = volatilityScoreFn(c.atrPct);
  const liqScore = liquidityScoreFn(c.avgVolume, spreadPct);
  const catScore = catalystScoreFn(c.gapPct, c.catalystBias, c.catalystStrength, c.sentiment);

  const raw =
    gapScore * WEIGHTS.gap +
    rvolScore * WEIGHTS.rvol +
    volScore * WEIGHTS.volatility +
    liqScore * WEIGHTS.liquidity +
    catScore * WEIGHTS.catalyst;

  const finalScore = Math.round(raw);

  return {
    score: finalScore,
    rejected: false,
    reasons: [],
    breakdown: {
      gap: gapScore,
      rvol: rvolScore,
      volatility: volScore,
      liquidity: liqScore,
      catalyst: catScore,
      spreadPct: spreadPct ? round(spreadPct, 3) : null,
    },
    version: STOCK_SCORER_VERSION,
  };
}

// --- Per-factor soft scoring functions ---

function gapScoreFn(gapPct) {
  // Bell curve peaking at ±10%. Below 3% scores 0 (gated), above 30%
  // starts decaying (too volatile / likely halt). We score the absolute
  // gap — direction is handled in the catalyst alignment score.
  const abs = Math.abs(gapPct);
  if (abs < 3) return 0;
  if (abs <= 10) return (abs / 10) * 100;          // 3% -> 30, 10% -> 100
  if (abs <= 20) return 100 - ((abs - 10) / 10) * 20; // 10% -> 100, 20% -> 80
  if (abs <= 40) return 80 - ((abs - 20) / 20) * 40;  // 20% -> 80,  40% -> 40
  return Math.max(0, 40 - (abs - 40));             // 40%+ decays to 0
}

function rvolScoreFn(rvol) {
  // Linear-ish from 1.8 -> 10. 5x is the real "institutional interest"
  // threshold, 10x is "something is happening". Cap at 100.
  if (rvol < 1.8) return 0;
  if (rvol <= 5) return 40 + ((rvol - 1.8) / 3.2) * 40;   // 1.8 -> 40, 5 -> 80
  if (rvol <= 10) return 80 + ((rvol - 5) / 5) * 20;      // 5 -> 80, 10 -> 100
  return 100;
}

function volatilityScoreFn(atrPct) {
  // Day traders want 3–8% ATR% — enough range to profit, not so much
  // that stops get run on noise. Below 2% = too slow, above 15% = chaos.
  if (!Number.isFinite(atrPct) || atrPct < 1) return 0;
  if (atrPct < 2) return 20;
  if (atrPct <= 5) return 60 + ((atrPct - 2) / 3) * 40;   // 2 -> 60, 5 -> 100
  if (atrPct <= 10) return 100 - ((atrPct - 5) / 5) * 30; // 5 -> 100, 10 -> 70
  if (atrPct <= 15) return 70 - ((atrPct - 10) / 5) * 40; // 10 -> 70, 15 -> 30
  return 30;
}

function liquidityScoreFn(avgVolume, spreadPct) {
  // Two components: average daily dollar volume (proxy = shares) and
  // spread tightness. Both must be good to score well.
  let volScore;
  if (avgVolume < 500_000) volScore = 0;
  else if (avgVolume < 2_000_000) volScore = 40;
  else if (avgVolume < 10_000_000) volScore = 70;
  else if (avgVolume < 50_000_000) volScore = 90;
  else volScore = 100;

  let spreadScore;
  if (spreadPct === null) spreadScore = 70; // unknown = neutral
  else if (spreadPct < 0.05) spreadScore = 100;
  else if (spreadPct < 0.15) spreadScore = 85;
  else if (spreadPct < 0.30) spreadScore = 65;
  else if (spreadPct < 0.50) spreadScore = 40;
  else spreadScore = 0;

  return (volScore * 0.7) + (spreadScore * 0.3);
}

function catalystScoreFn(gapPct, catalystBias, catalystStrength, sentiment) {
  // Three signals going the same direction = max score:
  //   1. gap direction (sign of gapPct)
  //   2. catalyst bias (+1 bullish, -1 bearish, 0 neutral)
  //   3. VADER sentiment across headlines
  //
  // If catalyst disagrees with gap (e.g. stock gapping UP on dilution),
  // we penalise heavily — these gaps tend to fade.
  const gapDir = Math.sign(gapPct); // -1, 0, +1

  if (catalystStrength === 0 && Math.abs(sentiment) < 0.1) {
    // No news, no sentiment signal. Unexplained gap = risky.
    return 30;
  }

  const catalystAligned = catalystBias === 0
    ? 0.5 // neutral catalyst (e.g. rumor) = half credit
    : (Math.sign(catalystBias) === gapDir ? 1 : -1);

  const sentAligned = Math.abs(sentiment) < 0.1
    ? 0
    : (Math.sign(sentiment) === gapDir ? 1 : -1);

  // Base 50 (has some news). Strong alignment pushes to 100.
  // Strong misalignment pushes toward 0.
  const alignmentBoost =
    (catalystAligned * catalystStrength * 35) +
    (sentAligned * Math.min(1, Math.abs(sentiment)) * 15);

  return clamp(50 + alignmentBoost, 0, 100);
}

// --- helpers ---

function round(n, d) { const m = 10 ** d; return Math.round(n * m) / m; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

module.exports = { scoreCandidate, STOCK_SCORER_VERSION, GATES, WEIGHTS };
