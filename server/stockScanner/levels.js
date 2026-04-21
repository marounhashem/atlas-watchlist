// server/stockScanner/levels.js
//
// Produces the entry / stop / target levels for each watchlist pick.
// Rules follow standard day-trading math around ATR and the opening
// range — the user reviews these before the open and plans their
// actual entries around them.
//
// Direction is inferred from the gap:
//   gap UP   -> long bias (breakout over pre-market high)
//   gap DOWN -> short bias (breakdown under pre-market low)
//
// We compute two setups per symbol: a "primary" (breakout/breakdown)
// and an "alternative" (pullback) so the trader has options if the
// first setup doesn't trigger cleanly.

/**
 * Produce levels for a single candidate.
 *
 * This needs pre-market high/low in a perfect world, but yahoo-finance2
 * doesn't expose those directly. We approximate with pre-market price +
 * ATR bands, clearly flagging that the trader should refine levels at
 * the open.
 */
function buildLevels(c) {
  const { gapPct, preMarketPrice: pmp, atr14, prevClose } = c;
  const direction = gapPct >= 0 ? 'LONG' : 'SHORT';
  const atrBuffer = Math.max(atr14 * 0.25, pmp * 0.003); // min 30bps buffer

  if (direction === 'LONG') {
    // Primary: breakout over pre-market high (approximated as pmp + small buffer)
    const primaryEntry = round(pmp + atrBuffer, 2);
    const primaryStop = round(pmp - atr14 * 0.75, 2);           // 0.75 ATR below pmp
    const primaryT1 = round(primaryEntry + atr14 * 1.0, 2);     // 1R-ish
    const primaryT2 = round(primaryEntry + atr14 * 2.0, 2);     // 2R

    // Alternative: pullback to prev close (VWAP proxy), trail with ATR
    const altEntry = round(prevClose + atrBuffer * 0.5, 2);
    const altStop = round(prevClose - atr14 * 0.5, 2);
    const altTarget = round(altEntry + atr14 * 1.5, 2);

    return {
      direction,
      primary: {
        name: 'Breakout',
        trigger: `Break above $${primaryEntry} with volume`,
        entry: primaryEntry,
        stop: primaryStop,
        target1: primaryT1,
        target2: primaryT2,
        riskPerShare: round(primaryEntry - primaryStop, 2),
        rMultiple1: round((primaryT1 - primaryEntry) / (primaryEntry - primaryStop), 2),
        rMultiple2: round((primaryT2 - primaryEntry) / (primaryEntry - primaryStop), 2),
      },
      alternative: {
        name: 'Pullback to prev close',
        trigger: `Dip to ~$${altEntry} holds support`,
        entry: altEntry,
        stop: altStop,
        target: altTarget,
        riskPerShare: round(altEntry - altStop, 2),
        rMultiple: round((altTarget - altEntry) / (altEntry - altStop), 2),
      },
    };
  }

  // SHORT path (gap down, looking for breakdown continuation)
  const primaryEntry = round(pmp - atrBuffer, 2);
  const primaryStop = round(pmp + atr14 * 0.75, 2);
  const primaryT1 = round(primaryEntry - atr14 * 1.0, 2);
  const primaryT2 = round(primaryEntry - atr14 * 2.0, 2);

  const altEntry = round(prevClose - atrBuffer * 0.5, 2);
  const altStop = round(prevClose + atr14 * 0.5, 2);
  const altTarget = round(altEntry - atr14 * 1.5, 2);

  return {
    direction,
    primary: {
      name: 'Breakdown',
      trigger: `Break below $${primaryEntry} with volume`,
      entry: primaryEntry,
      stop: primaryStop,
      target1: primaryT1,
      target2: primaryT2,
      riskPerShare: round(primaryStop - primaryEntry, 2),
      rMultiple1: round((primaryEntry - primaryT1) / (primaryStop - primaryEntry), 2),
      rMultiple2: round((primaryEntry - primaryT2) / (primaryStop - primaryEntry), 2),
    },
    alternative: {
      name: 'Rally to prev close',
      trigger: `Rally to ~$${altEntry} fails`,
      entry: altEntry,
      stop: altStop,
      target: altTarget,
      riskPerShare: round(altStop - altEntry, 2),
      rMultiple: round((altEntry - altTarget) / (altStop - altEntry), 2),
    },
  };
}

function round(n, d) {
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** d;
  return Math.round(n * m) / m;
}

module.exports = { buildLevels };
