const { getRecentOutcomes, getWeights, updateWeights, insertLearningLog, getAllSignals } = require('./db');
const { SYMBOLS } = require('./config');

// Learning thresholds
const MIN_CLOSED_TRADES_PER_SYMBOL = 10;  // minimum before adjusting weights
const MIN_TOTAL_OUTCOMES = 10;            // minimum total before any learning
const LEARNING_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours between cycles
const NEW_OUTCOMES_THRESHOLD = 10;        // min new closed trades since last cycle

let lastLearningTs = 0;
let lastOutcomeCount = 0;

function shouldRunLearning() {
  const now = Date.now();

  // Never run more than once per 6 hours
  if (now - lastLearningTs < LEARNING_INTERVAL_MS) {
    const hoursLeft = Math.round((LEARNING_INTERVAL_MS - (now - lastLearningTs)) / 3600000);
    console.log(`[Learner] Next cycle in ${hoursLeft}h`);
    return false;
  }

  // Need minimum total outcomes
  const outcomes = getRecentOutcomes(500);
  const closed = outcomes.filter(o => o.outcome !== 'OPEN');
  if (closed.length < MIN_TOTAL_OUTCOMES) {
    console.log(`[Learner] Not enough outcomes yet — need ${MIN_TOTAL_OUTCOMES}, have ${closed.length}`);
    return false;
  }

  // Need enough NEW outcomes since last cycle
  const newOutcomes = closed.length - lastOutcomeCount;
  if (newOutcomes < NEW_OUTCOMES_THRESHOLD && lastLearningTs > 0) {
    console.log(`[Learner] Only ${newOutcomes} new outcomes since last cycle — need ${NEW_OUTCOMES_THRESHOLD}`);
    return false;
  }

  return true;
}

async function runLearningCycle(broadcast, force = false) {
  if (!force && !shouldRunLearning()) return;

  console.log('[Learner] Starting learning cycle...');

  const outcomes = getRecentOutcomes(500);
  const closed = outcomes.filter(o => o.outcome !== 'OPEN');

  // Group by symbol — only process symbols with MIN_CLOSED_TRADES_PER_SYMBOL
  const bySymbol = {};
  for (const o of closed) {
    if (!bySymbol[o.symbol]) bySymbol[o.symbol] = [];
    bySymbol[o.symbol].push(o);
  }

  const symbolStats = {};
  for (const [sym, trades] of Object.entries(bySymbol)) {
    const wins   = trades.filter(t => t.outcome === 'WIN').length;
    const losses = trades.filter(t => t.outcome === 'LOSS').length;
    const total  = wins + losses;

    if (total < MIN_CLOSED_TRADES_PER_SYMBOL) {
      console.log(`[Learner] ${sym}: only ${total} trades, need ${MIN_CLOSED_TRADES_PER_SYMBOL} — skipping`);
      continue;
    }

    symbolStats[sym] = {
      winRate: Math.round((wins / total) * 100),
      wins, losses, total,
      avgScore: Math.round(trades.reduce((s, t) => s + t.score, 0) / trades.length),
      avgRR:    Math.round((trades.reduce((s, t) => s + (t.rr || 0), 0) / trades.length) * 10) / 10,
      winsBySession:  groupBySession(trades.filter(t => t.outcome === 'WIN')),
      lossBySession:  groupBySession(trades.filter(t => t.outcome === 'LOSS')),
      // Score band analysis — which score bands actually win
      winsByScoreBand: groupByScoreBand(trades.filter(t => t.outcome === 'WIN')),
      lossByScoreBand: groupByScoreBand(trades.filter(t => t.outcome === 'LOSS'))
    };
  }

  if (Object.keys(symbolStats).length === 0) {
    console.log('[Learner] No symbols have reached the minimum trade threshold yet');
    lastLearningTs = Date.now();
    lastOutcomeCount = closed.length;
    return;
  }

  // Current weights snapshot
  const currentWeights = {};
  for (const sym of Object.keys(symbolStats)) {
    const w = getWeights(sym);
    if (w) currentWeights[sym] = {
      pine: w.pine || 0.40,
      fxssi: w.fxssi || 0.45,
      session: w.session || 0.15,
      minScoreProceed: w.min_score_proceed
    };
  }

  const prompt = buildLearnerPrompt(symbolStats, currentWeights);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Haiku — batch weight learning doesn't need Sonnet quality
        max_tokens: 1000,
        system: `You are a quantitative trading system optimizer for ATLAS//WATCHLIST.

CRITICAL SYSTEM HISTORY:
First trading session recorded 7% win rate (2W/26L). Root causes identified and fixed in scorer v20260326.1:
1. System was buying into downtrends — EMAs lag, price was falling while EMAs still bullish
2. RSI hard blocks now in place — LONG blocked if RSI < 35, SHORT blocked if RSI > 65
3. EMA trend filter added — LONG blocked if 1h AND 4h EMA both bearish
4. TP capped at 5x ATR — no more R:R of 640:1 from uncapped projections
5. Crowd trap override — 65%+ crowd trapped opposite side now reduces EMA conflict penalty

WEIGHT LEARNING RULES:
- Old trade history (7% WR) is from broken scorer — do NOT punish fxssi weight based on it
- The 2 wins came from OILWTI with Structure 2/5 aligned and RSI confirming direction
- FXSSI crowd trap data was correct — Pine EMA was the problem
- Reward signals with structure alignment and RSI confirmation
- fxssi weight should stay 0.40-0.50 range

Analyze trade outcomes and return ONLY a JSON object with updated weights.
Rules:
- Weights (pine + fxssi + session) must sum to exactly 1.0
- pine = technical analysis weight, fxssi = order book weight, session = fixed at 0.15
- minScoreProceed must be between 62 and 88
- If win rate > 65%: slightly increase weights of strongest factors, lower minScore by 1-2
- If win rate < 45%: increase minScore by 3-5, reduce weights of weakest session
- If win rate 45-65%: minimal changes only
- Never change any single weight by more than 0.03 in one cycle — small adjustments only
Return format: { "SYMBOL": { "pine": 0.xx, "fxssi": 0.xx, "session": 0.15, "minScoreProceed": xx } }
No explanation, no markdown, pure JSON only.`,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    let updatedWeights;
    try {
      updatedWeights = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('[Learner] Failed to parse response:', text);
      return;
    }

    const changes = [];
    for (const [sym, newW] of Object.entries(updatedWeights)) {
      if (!SYMBOLS[sym]) continue;
      const old   = currentWeights[sym];
      const stats = symbolStats[sym];
      if (!stats) continue;

      // Validate weights sum to 1.0
      const sum = (newW.pine || 0) + (newW.fxssi || 0) + (newW.session || 0.15);
      if (sum < 0.97 || sum > 1.03) {
        console.warn(`[Learner] Invalid weights for ${sym} (sum=${sum.toFixed(3)}), skipping`);
        continue;
      }

      updateWeights(sym, { pine: newW.pine, fxssi: newW.fxssi, session: newW.session || 0.15, minScoreProceed: newW.minScoreProceed }, stats.winRate, stats.total);

      if (old) {
        const diffs = [];
        if (Math.abs((newW.pine||0)  - (old.pine||0))  > 0.005) diffs.push(`pine ${(old.pine||0).toFixed(2)}→${(newW.pine||0).toFixed(2)}`);
        if (Math.abs((newW.fxssi||0) - (old.fxssi||0)) > 0.005) diffs.push(`fxssi ${(old.fxssi||0).toFixed(2)}→${(newW.fxssi||0).toFixed(2)}`);
        if (Math.abs(newW.minScoreProceed - old.minScoreProceed)  > 0.5)   diffs.push(`minScore ${old.minScoreProceed}→${newW.minScoreProceed}`);
        if (diffs.length > 0) changes.push({ symbol: sym, winRate: stats.winRate, total: stats.total, diffs });
      }
    }

    lastLearningTs   = Date.now();
    lastOutcomeCount = closed.length;

    const logEntry = {
      symbolsAnalysed: Object.keys(symbolStats).join(','),
      outcomesUsed:    closed.length,
      changes,
      reasoning: `Symbols qualifying (${MIN_CLOSED_TRADES_PER_SYMBOL}+ trades): ${Object.entries(symbolStats).map(([s, st]) => `${s}:${st.winRate}%WR/${st.total}trades`).join(', ')}`
    };
    insertLearningLog(logEntry);

    console.log(`[Learner] Cycle complete. ${Object.keys(symbolStats).length} symbols analysed. Changes: ${changes.length}`);

    if (broadcast && changes.length > 0) {
      broadcast({ type: 'LEARNING_UPDATE', changes, ts: Date.now() });
    }

  } catch (e) {
    console.error('[Learner] API error:', e.message);
  }
}

function groupBySession(trades) {
  const g = { asia: 0, london: 0, newYork: 0, offHours: 0 };
  for (const t of trades) g[t.session] = (g[t.session] || 0) + 1;
  return g;
}

function groupByScoreBand(trades) {
  const g = { '60-69': 0, '70-79': 0, '80-89': 0, '90+': 0 };
  for (const t of trades) {
    const s = t.score || 0;
    if (s >= 90) g['90+']++;
    else if (s >= 80) g['80-89']++;
    else if (s >= 70) g['70-79']++;
    else g['60-69']++;
  }
  return g;
}

function buildLearnerPrompt(symbolStats, currentWeights) {
  const lines = [
    `Learning cycle analysis — ${new Date().toUTCString()}`,
    `Minimum threshold: ${MIN_CLOSED_TRADES_PER_SYMBOL} closed trades per symbol`,
    ''
  ];
  for (const [sym, stats] of Object.entries(symbolStats)) {
    lines.push(`${sym}: ${stats.winRate}% win rate (${stats.wins}W/${stats.losses}L of ${stats.total} trades), avgScore=${stats.avgScore}, avgRR=1:${stats.avgRR}`);
    lines.push(`  Wins by session:    ${JSON.stringify(stats.winsBySession)}`);
    lines.push(`  Losses by session:  ${JSON.stringify(stats.lossBySession)}`);
    lines.push(`  Wins by score band: ${JSON.stringify(stats.winsByScoreBand)}`);
    lines.push(`  Losses by score band: ${JSON.stringify(stats.lossByScoreBand)}`);
    if (currentWeights[sym]) {
      const w = currentWeights[sym];
      lines.push(`  Current weights: pine=${w.pine||0.40}, fxssi=${w.fxssi||0.45}, session=${w.session||0.15}, minScore=${w.minScoreProceed}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { runLearningCycle, shouldRunLearning };
