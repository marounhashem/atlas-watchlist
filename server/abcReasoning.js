'use strict';

// ── Score calculation — replaces hardcoded 88/75/62 ─────────────────────────
// Score reflects actual conditions met, not just class label
function buildAbcScore(pineClass, conditions, crowdGate, dailyAligned) {
  let score = 0;

  // Base — mandatory for all ABC signals (BOS + rejection = minimum)
  score += 15;  // BOS confirmed
  score += 8;   // Rejection candle present

  // Daily bias alignment (from atlas_daily_bias.pine)
  if (dailyAligned) score += 10;

  // Confluence filters (from Pine boolean flags)
  if (conditions.cloudPass)    score += 12;
  if (conditions.obPresent)    score += 10;
  if (conditions.pullbackIn)   score += 8;

  // Bonus
  if (conditions.rsiDiv)       score += 8;
  if (conditions.volConfirmed) score += 5;
  if (conditions.rejStrong)    score += 4;

  // Crowd sentiment
  if (crowdGate === 'ALIGNED')  score += 17;
  if (crowdGate === 'NO_TRAP')  score += 5;
  // MISALIGNED and NO_DATA: 0

  return Math.min(Math.round(score), 95);
}

// ── Breakdown object — stored in DB, shown on card ───────────────────────────
function buildAbcBreakdown(conditions, crowdGate, dailyAligned) {
  const structureScore = 23 + (dailyAligned ? 10 : 0);
  const confluenceScore = (conditions.cloudPass ? 12 : 0)
                        + (conditions.obPresent  ? 10 : 0)
                        + (conditions.pullbackIn ? 8  : 0);
  const momentumScore   = (conditions.rsiDiv       ? 8 : 0)
                        + (conditions.volConfirmed  ? 5 : 0)
                        + (conditions.rejStrong     ? 4 : 0);
  const crowdScore      = crowdGate === 'ALIGNED'  ? 17
                        : crowdGate === 'NO_TRAP'  ? 5 : 0;

  return {
    structure:  { score: structureScore,  max: 33, label: 'Structure',
                  note: 'BOS' + (dailyAligned ? ' \u00b7 Daily confirmed' : ' \u00b7 Daily unconfirmed')
                              + ' \u00b7 Rejection candle' },
    confluence: { score: confluenceScore, max: 30, label: 'Confluence',
                  note: [conditions.cloudPass  ? 'Cloud \u2713'    : 'Cloud \u2717',
                         conditions.obPresent  ? 'OB \u2713'       : 'OB \u2717',
                         conditions.pullbackIn ? 'Pullback \u2713' : 'Pullback \u2717'].join(' \u00b7 ') },
    momentum:   { score: momentumScore,   max: 17, label: 'Momentum',
                  note: [conditions.rsiDiv       ? 'RSI div \u2713'    : 'RSI div \u2717',
                         conditions.volConfirmed ? 'Volume \u2713'     : 'Volume \u2717',
                         conditions.rejStrong    ? 'Strong rej \u2713' : ''].filter(Boolean).join(' \u00b7 ') },
    crowd:      { score: crowdScore,      max: 17, label: 'Crowd Sentiment',
                  note: crowdGate === 'ALIGNED'    ? 'Contrarian pressure confirmed'
                      : crowdGate === 'NO_TRAP'    ? 'Crowd split \u2014 weak contrarian edge'
                      : crowdGate === 'MISALIGNED' ? 'Crowd with direction \u2014 no edge'
                      : 'No crowd sentiment data available' }
  };
}

// ── Human-readable trade thesis ──────────────────────────────────────────────
function buildAbcReasoning(pineClass, direction, symbol, crowdGate,
                           conditions, dailyDirection, fxssiData, score) {
  const dir   = direction === 'LONG' ? 'long' : 'short';
  const opp   = direction === 'LONG' ? 'short' : 'long';
  const DIR   = direction;

  // Crowd sentence
  const longPct  = fxssiData?.fxssi_long_pct;
  const shortPct = fxssiData?.fxssi_short_pct;
  const hasPct   = longPct != null && shortPct != null;
  const crowdPct = direction === 'LONG' ? shortPct : longPct;

  let crowdLine = '';
  if (crowdGate === 'ALIGNED' && hasPct) {
    crowdLine = Math.round(crowdPct) + '% of crowd positioned ' + opp + ' \u2014 contrarian ' + dir + ' squeeze setup.';
  } else if (crowdGate === 'ALIGNED') {
    crowdLine = 'Crowd majority positioned ' + opp + ' \u2014 contrarian ' + dir + ' squeeze setup.';
  } else if (crowdGate === 'NO_TRAP' && hasPct) {
    crowdLine = 'Crowd split (' + Math.round(longPct) + '% long / ' + Math.round(shortPct) + '% short) \u2014 no dominant contrarian edge.';
  } else if (crowdGate === 'NO_TRAP') {
    crowdLine = 'Crowd split \u2014 no dominant contrarian edge.';
  } else if (crowdGate === 'MISALIGNED') {
    crowdLine = 'Crowd positioned with direction \u2014 no contrarian squeeze fuel.';
  } else {
    crowdLine = 'No crowd sentiment data available for this symbol.';
  }

  // Confluence sentence
  const confParts = [];
  if (conditions.cloudPass)  confParts.push('cloud');
  if (conditions.obPresent)  confParts.push('order block');
  if (conditions.pullbackIn) confParts.push('pullback confirmed');
  const confLine = confParts.length
    ? 'Confluence: ' + confParts.join(', ') + '.' : '';

  // Momentum sentence
  const momParts = [];
  if (conditions.rsiDiv)       momParts.push('RSI divergence');
  if (conditions.volConfirmed) momParts.push('volume confirmed');
  const momLine = momParts.length
    ? momParts.join(' \u00b7 ') + ' building momentum.' : '';

  // Daily bias
  const dailyLine = dailyDirection === 'BULL' && direction === 'LONG'  ? 'Daily bias bullish.'
                  : dailyDirection === 'BEAR' && direction === 'SHORT' ? 'Daily bias bearish.'
                  : dailyDirection === 'MIXED' ? 'Daily bias mixed.' : 'Daily bias unconfirmed.';

  // Class-specific opening
  let opening = '';
  if (pineClass === 'A') {
    opening = DIR + ' structure break with full confluence.';
  } else if (pineClass === 'B') {
    opening = DIR + ' structure break with ' + (confParts.slice(0,2).join(' and ') || 'partial confluence') + '.';
  }

  // Assemble
  const parts = [opening, dailyLine, confLine, crowdLine, momLine]
    .filter(Boolean).join(' ');

  return parts + ' Score: ' + score + '/95';
}

module.exports = { buildAbcScore, buildAbcBreakdown, buildAbcReasoning };
