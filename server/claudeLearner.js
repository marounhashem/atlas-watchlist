// ATLAS//WATCHLIST — Claude Learning Engine
// Three layers: post-trade analysis, session patterns, market regime detection
// Fires: after every WIN/LOSS + daily at 17:00 UTC (end London) + every 10 outcomes

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// ── State ─────────────────────────────────────────────────────────────────────
let outcomesSinceLastRegime = 0;
let lastDailySummaryDate   = null;
let regimeCache            = null; // current market regime
let sessionPatterns        = {};   // { 'GOLD_london': { wins, losses, patterns[] } }
let postTradeInsights      = [];   // last 50 insights

// ── Main entry point ─────────────────────────────────────────────────────────
async function onOutcome(signal, outcome, broadcast) {
  if (outcome !== 'WIN' && outcome !== 'LOSS') return;

  outcomesSinceLastRegime++;

  // Layer 1 — Post-trade analysis after every WIN/LOSS
  const insight = await analysePostTrade(signal, outcome);
  if (insight) {
    postTradeInsights.unshift(insight);
    if (postTradeInsights.length > 50) postTradeInsights.pop();
    if (broadcast) broadcast({ type: 'CLAUDE_INSIGHT', insight, ts: Date.now() });
    console.log(`[Claude] Post-trade: ${signal.symbol} ${outcome} — ${insight.summary}`);
  }

  // Layer 2 — Session pattern update
  updateSessionPattern(signal, outcome, insight);

  // Layer 3 — Regime check every 10 outcomes
  if (outcomesSinceLastRegime >= 10) {
    outcomesSinceLastRegime = 0;
    const regime = await detectRegime();
    if (regime) {
      regimeCache = regime;
      if (broadcast) broadcast({ type: 'REGIME_UPDATE', regime, ts: Date.now() });
      console.log(`[Claude] Regime: ${regime.regime} — ${regime.summary}`);
    }
  }
}

// ── Layer 1: Post-trade analysis ──────────────────────────────────────────────
async function analysePostTrade(signal, outcome) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const db = require('./db');
    // Get the market data snapshot at signal time
    const marketData = db.getLatestMarketData(signal.symbol);
    let fxssi = null;
    try {
      if (marketData?.fxssi_analysis) fxssi = JSON.parse(marketData.fxssi_analysis);
    } catch(e) {}

    const prompt = `You are a trading analyst reviewing a completed trade for the ATLAS system.

TRADE RESULT: ${outcome}
Symbol: ${signal.symbol} | Direction: ${signal.direction} | Score: ${signal.score}%
Entry: ${signal.entry} | SL: ${signal.sl} | TP: ${signal.tp} | R:R: ${signal.rr}
Session: ${signal.session} | PnL: ${signal.pnl_pct != null ? signal.pnl_pct + '%' : 'unknown'}
Signal reasoning: ${signal.reasoning}

MARKET CONDITIONS AT ENTRY:
Pine bias score: ${marketData?.bias || 'N/A'} | RSI: ${marketData?.rsi || 'N/A'} | Structure: ${marketData?.structure || 'N/A'}
FXSSI: longPct=${fxssi?.longPct || 'N/A'}% shortPct=${fxssi?.shortPct || 'N/A'}% trapped=${fxssi?.trapped || 'none'}
inProfitPct: ${fxssi?.inProfitPct || 'N/A'}% | signalBias: ${fxssi?.signals?.bias || 'N/A'}
gravity: ${fxssi?.gravity?.price || 'N/A'} | nearestSLAbove: ${fxssi?.nearestSLAbove?.price || 'N/A'} | nearestSLBelow: ${fxssi?.nearestSLBelow?.price || 'N/A'}
losingClusters: ${fxssi?.losingClusters?.length || 0} | winningClusters: ${fxssi?.winningClusters?.length || 0}
middleOfVolume: ${fxssi?.middleOfVolume || 'N/A'}

Analyse this trade and return ONLY this JSON (no markdown):
{
  "outcome": "${outcome}",
  "symbol": "${signal.symbol}",
  "summary": "<one sentence max 15 words>",
  "what_worked": ["<factor that contributed to outcome>"],
  "what_failed": ["<factor that hurt outcome>"],
  "key_pattern": "<most important pattern to remember for this symbol/session>",
  "score_adjustment": {
    "pine_bias_weight": <-0.1 to +0.1, how much to adjust this weight>,
    "fxssi_weight": <-0.1 to +0.1>,
    "ob_weight": <-0.1 to +0.1>,
    "min_score_threshold": <-5 to +5, points to adjust>
  },
  "avoid_next_time": "<condition to avoid for next ${signal.symbol} ${signal.direction} signal>"
}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const insight = JSON.parse(clean);

    // Apply score adjustments to DB weights
    if (insight.score_adjustment) {
      applyWeightAdjustment(signal.symbol, insight.score_adjustment);
    }

    // Store in learning log
    db.insertLearningLog({
      symbolsAnalysed: signal.symbol,
      outcomesUsed: 1,
      changes: JSON.stringify([insight]),
      reasoning: insight.key_pattern
    });

    return insight;
  } catch(e) {
    console.error('[Claude] Post-trade analysis error:', e.message);
    return null;
  }
}

// ── Layer 2: Session pattern tracking ────────────────────────────────────────
function updateSessionPattern(signal, outcome, insight) {
  const key = `${signal.symbol}_${signal.session}`;
  if (!sessionPatterns[key]) sessionPatterns[key] = { wins: 0, losses: 0, patterns: [] };

  if (outcome === 'WIN') sessionPatterns[key].wins++;
  else sessionPatterns[key].losses++;

  if (insight?.key_pattern) {
    sessionPatterns[key].patterns.push({
      outcome,
      pattern: insight.key_pattern,
      ts: Date.now()
    });
    if (sessionPatterns[key].patterns.length > 20) sessionPatterns[key].patterns.shift();
  }
}

// ── Layer 3: Market regime detection ─────────────────────────────────────────
async function detectRegime() {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const db = require('./db');
    const recentSignals = db.getAllSignals(20).filter(s =>
      s.outcome === 'WIN' || s.outcome === 'LOSS'
    );

    if (recentSignals.length < 5) return null;

    const winRate = recentSignals.filter(s => s.outcome === 'WIN').length / recentSignals.length;
    const symbols = [...new Set(recentSignals.map(s => s.symbol))];
    const sessions = [...new Set(recentSignals.map(s => s.session))];
    const avgScore = recentSignals.reduce((s, r) => s + (r.score || 0), 0) / recentSignals.length;

    const recentInsights = postTradeInsights.slice(0, 10).map(i =>
      `${i.symbol} ${i.outcome}: ${i.key_pattern}`
    ).join('\n');

    const prompt = `You are a market regime analyst for the ATLAS trading system.

RECENT PERFORMANCE (last ${recentSignals.length} closed trades):
Win rate: ${Math.round(winRate * 100)}%
Average signal score: ${Math.round(avgScore)}%
Active symbols: ${symbols.join(', ')}
Active sessions: ${sessions.join(', ')}

Recent trade insights:
${recentInsights || 'No insights yet'}

Signal breakdown:
${recentSignals.slice(0, 10).map(s => `${s.symbol} ${s.direction} ${s.score}% → ${s.outcome}`).join('\n')}

Classify the current market regime and return ONLY this JSON (no markdown):
{
  "regime": "TRENDING|RANGING|HIGH_VOLATILITY|NEWS_DRIVEN|LOW_CONVICTION",
  "summary": "<one sentence describing current conditions>",
  "best_symbols": ["<symbols with highest edge right now>"],
  "avoid_symbols": ["<symbols to avoid>"],
  "best_sessions": ["<sessions performing well>"],
  "threshold_adjustment": <-10 to +10, adjust min score threshold globally>,
  "fxssi_weight_adjustment": <-0.05 to +0.05, adjust FXSSI weight globally>,
  "key_observation": "<most important pattern across all recent trades>",
  "confidence": <0-100>
}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    console.error('[Claude] Regime detection error:', e.message);
    return null;
  }
}

// ── Daily session summary ─────────────────────────────────────────────────────
async function dailySessionSummary(broadcast) {
  const today = new Date().toDateString();
  if (lastDailySummaryDate === today) return; // already ran today
  lastDailySummaryDate = today;

  if (!ANTHROPIC_API_KEY) return;

  try {
    const db = require('./db');
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const todaySignals = db.getAllSignals(50).filter(s =>
      s.ts > todayStart.getTime() && (s.outcome === 'WIN' || s.outcome === 'LOSS')
    );

    if (todaySignals.length === 0) return;

    const wins   = todaySignals.filter(s => s.outcome === 'WIN').length;
    const losses = todaySignals.filter(s => s.outcome === 'LOSS').length;
    const winRate = Math.round(wins / todaySignals.length * 100);

    const prompt = `You are analysing today's trading session for the ATLAS system.

TODAY'S RESULTS: ${wins}W / ${losses}L (${winRate}% win rate)
Signals: ${todaySignals.map(s => `${s.symbol} ${s.direction} ${s.score}% → ${s.outcome}`).join(', ')}

Session patterns today:
${Object.entries(sessionPatterns)
  .filter(([, v]) => v.wins + v.losses > 0)
  .map(([k, v]) => `${k}: ${v.wins}W/${v.losses}L`)
  .join('\n') || 'No patterns yet'}

Return ONLY this JSON (no markdown):
{
  "summary": "<2-3 sentence daily summary>",
  "top_setup": "<best performing setup today>",
  "worst_setup": "<worst performing setup today>",
  "tomorrow_focus": "<what to watch tomorrow>",
  "weight_updates": [
    {"symbol": "<sym>", "adjustment": "<what to change and why>"}
  ]
}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const summary = JSON.parse(clean);

    console.log(`[Claude] Daily summary: ${summary.summary}`);
    if (broadcast) broadcast({ type: 'DAILY_SUMMARY', summary, ts: Date.now() });

    const db2 = require('./db');
    db2.insertLearningLog({
      symbolsAnalysed: 'ALL',
      outcomesUsed: todaySignals.length,
      changes: JSON.stringify(summary.weight_updates || []),
      reasoning: summary.summary
    });

  } catch(e) {
    console.error('[Claude] Daily summary error:', e.message);
  }
}

// ── Weight adjustment helper ──────────────────────────────────────────────────
function applyWeightAdjustment(symbol, adj) {
  try {
    const db = require('./db');
    const w = db.getWeights(symbol);
    if (!w) return;

    const { SYMBOLS } = require('./config');
    const cfg = SYMBOLS[symbol];
    if (!cfg) return;

    // Apply adjustments with bounds
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const newPine  = clamp((w.pine_bias      || 0.35) + (adj.pine_bias_weight || 0), 0.15, 0.60);
    const newFxssi = clamp((w.fxssi_sentiment|| 0.25) + (adj.fxssi_weight    || 0), 0.10, 0.50);
    const newOB    = clamp((w.order_book     || 0.25) + (adj.ob_weight        || 0), 0.10, 0.40);
    const newMin   = clamp((w.min_score_proceed || cfg.minScoreProceed) + (adj.min_score_threshold || 0), 55, 90);

    // Normalise Pine + FXSSI + OB to leave room for session
    const total = newPine + newFxssi + newOB;
    const scale = 0.85 / total; // session gets 0.15

    db.updateWeights(symbol, {
      pine_bias:         Math.round(newPine  * scale * 100) / 100,
      fxssi_sentiment:   Math.round(newFxssi * scale * 100) / 100,
      order_book:        Math.round(newOB    * scale * 100) / 100,
      session_quality:   0.15,
      min_score_proceed: Math.round(newMin)
    });

    console.log(`[Claude] Weights updated for ${symbol}: pine=${(newPine*scale).toFixed(2)} fxssi=${(newFxssi*scale).toFixed(2)} ob=${(newOB*scale).toFixed(2)} minScore=${Math.round(newMin)}`);
  } catch(e) {
    console.error('[Claude] Weight adjustment error:', e.message);
  }
}

// ── Getters for dashboard ─────────────────────────────────────────────────────
function getRegime()          { return regimeCache; }
function getSessionPatterns() { return sessionPatterns; }
function getInsights()        { return postTradeInsights.slice(0, 20); }

module.exports = {
  onOutcome,
  dailySessionSummary,
  detectRegime,
  getRegime,
  getSessionPatterns,
  getInsights
};
