const { getRecentOutcomes, getWeights, updateWeights, insertLearningLog } = require('./db');
const { SYMBOLS } = require('./config');

async function runLearningCycle(broadcast) {
  console.log('[Learner] Starting 30m learning cycle...');

  const outcomes = getRecentOutcomes(80);
  if (outcomes.length < 10) {
    console.log('[Learner] Not enough outcomes yet — need 10+, have', outcomes.length);
    return;
  }

  // Group outcomes by symbol
  const bySymbol = {};
  for (const o of outcomes) {
    if (!bySymbol[o.symbol]) bySymbol[o.symbol] = [];
    bySymbol[o.symbol].push(o);
  }

  const symbolStats = {};
  for (const [sym, trades] of Object.entries(bySymbol)) {
    const wins = trades.filter(t => t.outcome === 'WIN').length;
    const losses = trades.filter(t => t.outcome === 'LOSS').length;
    const total = wins + losses;
    if (total < 3) continue;
    symbolStats[sym] = {
      winRate: Math.round((wins / total) * 100),
      wins, losses, total,
      avgScore: Math.round(trades.reduce((s, t) => s + t.score, 0) / trades.length),
      winsBySession: groupBySession(trades.filter(t => t.outcome === 'WIN')),
      lossBySession: groupBySession(trades.filter(t => t.outcome === 'LOSS'))
    };
  }

  if (Object.keys(symbolStats).length === 0) {
    console.log('[Learner] No symbols with enough outcomes yet');
    return;
  }

  // Current weights snapshot
  const currentWeights = {};
  for (const sym of Object.keys(symbolStats)) {
    const w = getWeights(sym);
    if (w) currentWeights[sym] = {
      pineBias: w.pine_bias,
      fxssiSentiment: w.fxssi_sentiment,
      orderBook: w.order_book,
      sessionQuality: w.session_quality,
      minScoreProceed: w.min_score_proceed
    };
  }

  const prompt = buildLearnerPrompt(symbolStats, currentWeights);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are a quantitative trading system optimizer. 
Analyze trade outcomes and return ONLY a JSON object with updated weights.
Weights must sum to 1.0 per symbol. minScoreProceed between 60-85.
Return format: { "SYMBOL": { "pineBias": 0.x, "fxssiSentiment": 0.x, "orderBook": 0.x, "sessionQuality": 0.x, "minScoreProceed": xx }, ... }
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
      console.error('[Learner] Failed to parse Claude response:', text);
      return;
    }

    const changes = [];
    for (const [sym, newW] of Object.entries(updatedWeights)) {
      if (!SYMBOLS[sym]) continue;
      const old = currentWeights[sym];
      const stats = symbolStats[sym];
      if (!stats) continue;

      // Validate weights sum to ~1.0
      const sum = newW.pineBias + newW.fxssiSentiment + newW.orderBook + newW.sessionQuality;
      if (sum < 0.95 || sum > 1.05) {
        console.warn(`[Learner] Invalid weights for ${sym}, sum=${sum}, skipping`);
        continue;
      }

      updateWeights(sym, newW, stats.winRate, stats.total);

      if (old) {
        const diffs = [];
        if (Math.abs(newW.pineBias - old.pineBias) > 0.01) diffs.push(`pineBias ${old.pineBias.toFixed(2)}→${newW.pineBias.toFixed(2)}`);
        if (Math.abs(newW.fxssiSentiment - old.fxssiSentiment) > 0.01) diffs.push(`fxssi ${old.fxssiSentiment.toFixed(2)}→${newW.fxssiSentiment.toFixed(2)}`);
        if (Math.abs(newW.orderBook - old.orderBook) > 0.01) diffs.push(`orderBook ${old.orderBook.toFixed(2)}→${newW.orderBook.toFixed(2)}`);
        if (Math.abs(newW.minScoreProceed - old.minScoreProceed) > 0.5) diffs.push(`minScore ${old.minScoreProceed}→${newW.minScoreProceed}`);
        if (diffs.length > 0) changes.push({ symbol: sym, winRate: stats.winRate, diffs });
      }
    }

    const logEntry = {
      symbolsAnalysed: Object.keys(symbolStats).join(','),
      outcomesUsed: outcomes.length,
      changes,
      reasoning: `Win rates: ${Object.entries(symbolStats).map(([s, st]) => `${s}:${st.winRate}%`).join(', ')}`
    };
    insertLearningLog(logEntry);

    console.log('[Learner] Cycle complete. Changes:', changes.length > 0 ? JSON.stringify(changes) : 'none');

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

function buildLearnerPrompt(symbolStats, currentWeights) {
  const lines = ['Analyze these trading outcomes and return optimized weights:\n'];
  for (const [sym, stats] of Object.entries(symbolStats)) {
    lines.push(`${sym}: ${stats.winRate}% win rate (${stats.wins}W/${stats.losses}L), avgScore=${stats.avgScore}`);
    lines.push(`  Wins by session: ${JSON.stringify(stats.winsBySession)}`);
    lines.push(`  Losses by session: ${JSON.stringify(stats.lossBySession)}`);
    if (currentWeights[sym]) {
      const w = currentWeights[sym];
      lines.push(`  Current weights: pineBias=${w.pineBias}, fxssi=${w.fxssiSentiment}, orderBook=${w.orderBook}, session=${w.sessionQuality}, minScore=${w.minScoreProceed}`);
    }
    lines.push('');
  }
  lines.push('Adjust weights to improve win rates. Increase weights for factors that correlate with wins. Decrease for losses.');
  return lines.join('\n');
}

module.exports = { runLearningCycle };
