// ATLAS//WATCHLIST — Claude Learning Engine
// Three layers: post-trade analysis, session patterns, market regime detection
// Fires: after every WIN/LOSS + daily at 17:00 UTC (end London) + every 10 outcomes

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL_SONNET = 'claude-sonnet-4-20250514'; // exact levels only
const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';  // all other tasks — 20x cheaper
const MODEL = MODEL_HAIKU; // default

// ── State ─────────────────────────────────────────────────────────────────────
let outcomesSinceLastRegime = 0;
let lastDailySummaryDate   = null;
let regimeCache            = null; // current market regime
let sessionPatterns        = {};   // { 'GOLD_london': { wins, losses, patterns[] } }
let postTradeInsights      = [];   // last 50 insights

// Rate limiting — max 1 post-trade analysis per symbol per 30 minutes
// Prevents API burn when multiple trades close in quick succession
const lastAnalysisTs = {}; // { symbol: timestamp }
const ANALYSIS_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// ── Main entry point ─────────────────────────────────────────────────────────
async function onOutcome(signal, outcome, broadcast) {
  if (outcome !== 'WIN' && outcome !== 'LOSS') return;

  outcomesSinceLastRegime++;

  // Rate limit post-trade analysis — skip if same symbol analysed recently
  const now = Date.now();
  const lastTs = lastAnalysisTs[signal.symbol] || 0;
  if (now - lastTs < ANALYSIS_COOLDOWN_MS) {
    const minsLeft = Math.round((ANALYSIS_COOLDOWN_MS - (now - lastTs)) / 60000);
    console.log(`[Claude] ${signal.symbol} ${outcome} — post-trade skipped (cooldown ${minsLeft}m remaining)`);
    updateSessionPattern(signal, outcome, null);
    return;
  }
  lastAnalysisTs[signal.symbol] = now;

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

    // Build recommendation summary for prompt
  let recSummary = 'None issued';
  try {
    const { getRecommendations } = require('./db');
    const recs = getRecommendations(signal.id);
    if (recs.length > 0) {
      recSummary = recs.map(r => {
        const age = Math.round((signal.outcome_ts - r.ts) / 60000);
        const followed = r.followed ? 'FOLLOWED' : 'IGNORED';
        return `${new Date(r.ts).toUTCString().slice(17,25)} — ${r.type} (${r.urgency}): ${r.reason} [${followed}, ${age}min before close]`;
      }).join('\n  ');
    }
  } catch(e) {}

  const prompt = `You are a trading analyst reviewing a completed trade for the ATLAS system.

TRADE RESULT: ${outcome}
Symbol: ${signal.symbol} | Direction: ${signal.direction} | Score: ${signal.score}%
Entry: ${signal.entry} | SL: ${signal.sl} | TP: ${signal.tp} | R:R: ${signal.rr}
Session: ${signal.session} | PnL: ${signal.pnl_pct != null ? signal.pnl_pct + '%' : 'unknown'}
Max Favorable Excursion: ${signal.mfe != null ? signal.mfe_pct + '% toward TP' : 'unknown'}
Signal reasoning: ${signal.reasoning}

TRADE MONITOR RECOMMENDATIONS ISSUED:
  ${recSummary}
Note: Were CLOSE/MOVE_SL recommendations issued before the trade closed? If so, were they correct?
Did ignoring them contribute to the outcome? Factor this into score_adjustment.

${signal.mfe != null ? `MFE CONTEXT: Price moved ${signal.mfe_pct}% in the right direction before ${outcome === 'LOSS' ? 'reversing to hit SL' : 'hitting TP'}. ${outcome === 'LOSS' && signal.mfe_pct > 0.3 ? 'This suggests the direction was correct but SL was too tight.' : outcome === 'LOSS' && (signal.mfe_pct || 0) < 0.1 ? 'Price barely moved favorably — likely a wrong call entirely.' : ''}` : ''}

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
    "pine_weight": <-0.1 to +0.1, adjust pine scoring weight>,
    "fxssi_weight": <-0.1 to +0.1, adjust combined FXSSI+OB weight>,
    "min_score_threshold": <-5 to +5, points to adjust>,
    "sl_too_tight": <true if MFE > 0.3% but still lost>,
    "entry_fxssi_shift": <-0.1 to +0.1, shift entry toward FXSSI(+) or Pine(-)>,
    "tp_fxssi_shift": <-0.1 to +0.1, shift TP toward FXSSI(+) or Pine(-)>
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

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    // New 3-weight schema: pine, fxssi (OB+sentiment combined), session fixed at 0.15
    const newPine  = clamp((w.pine  || 0.40) + (adj.pine_weight  || 0), 0.15, 0.65);
    const newFxssi = clamp((w.fxssi || 0.45) + (adj.fxssi_weight || 0), 0.20, 0.70);
    const newMin   = clamp((w.min_score_proceed || cfg.minScoreProceed) + (adj.min_score_threshold || 0), 55, 90);

    // Normalise pine + fxssi to leave 0.15 for session
    const total = newPine + newFxssi;
    if (total <= 0) return;
    const scale = 0.85 / total;

    // Level blend weights — how much FXSSI vs Pine for entry/SL/TP
    // sl_too_tight = true means SL was wrong (Pine or FXSSI placement issue)
    // Claude learns to shift weight toward whichever source gave better levels
    const curEntryW = w.entry_fxssi_weight ?? 0.50;
    const curSlW    = w.sl_fxssi_weight    ?? 0.50;
    const curTpW    = w.tp_fxssi_weight    ?? 0.50;

    let newEntryW = curEntryW;
    let newSlW    = curSlW;
    let newTpW    = curTpW;

    if (adj.sl_too_tight === true) {
      // SL was too tight — shift SL weight away from whichever source was tighter
      // Can't know which without more data, so widen both slightly toward FXSSI clusters
      newSlW = clamp(curSlW + 0.05, 0.20, 0.80);
    }
    if (adj.entry_fxssi_shift) newEntryW = clamp(curEntryW + adj.entry_fxssi_shift, 0.20, 0.80);
    if (adj.tp_fxssi_shift)    newTpW    = clamp(curTpW    + adj.tp_fxssi_shift,    0.20, 0.80);

    db.updateWeights(symbol, {
      pine:              Math.round(newPine  * scale * 100) / 100,
      fxssi:             Math.round(newFxssi * scale * 100) / 100,
      session:           0.15,
      minScoreProceed:   Math.round(newMin),
      entryFxssiWeight:  Math.round(newEntryW * 100) / 100,
      slFxssiWeight:     Math.round(newSlW    * 100) / 100,
      tpFxssiWeight:     Math.round(newTpW    * 100) / 100
    });

    console.log(`[Claude] Weights updated for ${symbol}: pine=${(newPine*scale).toFixed(2)} fxssi=${(newFxssi*scale).toFixed(2)} minScore=${Math.round(newMin)} entry=${newEntryW.toFixed(2)} sl=${newSlW.toFixed(2)} tp=${newTpW.toFixed(2)}`);
  } catch(e) {
    console.error('[Claude] Weight adjustment error:', e.message);
  }
}

// ── Layer 4: Exact level calculation ─────────────────────────────────────────
// Claude calculates exact entry, SL and TP prices based on:
// - Current order book structure (gravity, SL clusters, limit walls, losing clusters)
// - Historical win/loss at specific price levels for this symbol
// - FVG zones, swing structure, VWAP bands from Pine
// - What has worked before vs what has failed

let entryOptimisation = {}; // { GOLD: { slMultiplier, tpMultiplier, confidence, ... } }

// Calculate exact levels for a live signal
async function calculateExactLevels(symbol, direction, currentData, fxssi) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const db = require('./db');
    const cp = currentData.close;

    // Get historical closed trades for this symbol+direction
    const history = db.getAllSignals(100).filter(s =>
      s.symbol === symbol &&
      s.direction === direction &&
      (s.outcome === 'WIN' || s.outcome === 'LOSS') &&
      s.entry && s.sl && s.tp
    );

    // Build level context from order book
    const slClusters   = fxssi?.slClusters?.slice(0,5)   || [];
    const limitWalls   = fxssi?.limitWalls?.slice(0,5)   || [];
    const losingClusters = fxssi?.losingClusters?.slice(0,5) || [];
    const gravity      = fxssi?.gravity;
    const midVol       = fxssi?.middleOfVolume;

    // Parse raw payload for FVG and swing levels
    let fvg = null, swings = null, vwap = null, atr = null;
    try {
      const raw = JSON.parse(currentData.raw_payload || '{}');
      fvg    = raw.fvg;
      swings = raw.structure;
      vwap   = raw.vwap;
      atr    = raw.atr;
    } catch(e) {}

    const prompt = `You are calculating exact entry, SL and TP price levels for an ${direction} trade on ${symbol}.

CURRENT PRICE: ${cp}
DIRECTION: ${direction}

ORDER BOOK STRUCTURE:
SL clusters (price hunts these — use as TP targets):
${slClusters.map(c => '  ' + c.price + ' (volume: ' + (c.os?.toFixed(3) || 'N/A') + ')').join('\n') || '  None detected'}

Limit walls (real S/R — orange orders slow price):
${limitWalls.map(c => '  ' + c.price + ' (volume: ' + (c.ol?.toFixed(3) || 'N/A') + ')').join('\n') || '  None detected'}

Losing position clusters (trapped traders = fuel):
${losingClusters.map(c => '  ' + c.price + ' (ps: ' + (c.ps?.toFixed(3) || 0) + ' pl: ' + (c.pl?.toFixed(3) || 0) + ')').join('\n') || '  None detected'}

Gravity (strongest SL cluster): ${gravity?.price || 'N/A'} (vol: ${gravity?.volume || 'N/A'})
Middle of volume: ${midVol || 'N/A'}

TECHNICAL LEVELS:
${fvg?.bearActive ? `Bear FVG: ${fvg.bearBot} - ${fvg.bearTop} (mid: ${fvg.bearMid})` : ''}
${fvg?.bullActive ? `Bull FVG: ${fvg.bullBot} - ${fvg.bullTop} (mid: ${fvg.bullMid})` : ''}
Swing H1: ${swings?.swingH1 || 'N/A'} | H2: ${swings?.swingH2 || 'N/A'}
Swing L1: ${swings?.swingL1 || 'N/A'} | L2: ${swings?.swingL2 || 'N/A'}
VWAP: ${vwap?.mid || 'N/A'} | Upper2: ${vwap?.upper2 || 'N/A'} | Lower2: ${vwap?.lower2 || 'N/A'}
ATR 1h: ${atr?.['1h'] || 'N/A'}

HISTORICAL PERFORMANCE (${history.length} closed ${direction} trades):
${history.slice(0, 10).map(t =>
  t.direction + ' entry=' + t.entry + ' sl=' + t.sl + ' tp=' + t.tp + ' -> ' + t.outcome
).join('\n') || 'No history yet — use order book logic only'}

${history.length > 0 ? `Win rate: ${Math.round(history.filter(t => t.outcome === 'WIN').length / history.length * 100)}%` : ''}

RULES:
- Entry: for ${direction === 'SHORT' ? 'SHORT — entry should be at or just below resistance (limit wall above, FVG bear mid, or swing high)' : 'LONG — entry should be at or just above support (limit wall below, FVG bull mid, or swing low)'}
- SL: place BEYOND a losing cluster or limit wall — if it breaks, the trade is wrong anyway
- TP: target the nearest SL cluster in trade direction — price hunts these
- R:R must be between 1.5 and 4.0
- If no clear level exists for any component, use null and explain why

Return ONLY this JSON (no markdown):
{
  "entry": <exact price>,
  "sl": <exact price>,
  "tp": <exact price>,
  "entry_reason": "<why this entry level>",
  "sl_reason": "<why this SL level>",
  "tp_reason": "<why this TP level>",
  "rr": <calculated R:R>,
  "confidence": <0-100>,
  "key_levels_used": ["<level type used>"]
}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL_SONNET, // Sonnet for exact levels — quality matters here
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const levels = JSON.parse(text.replace(/```json|```/g, '').trim());

    console.log(`[Claude] Exact levels for ${symbol} ${direction}: entry=${levels.entry} sl=${levels.sl} tp=${levels.tp} R:R=${levels.rr} (${levels.confidence}% confidence)`);
    return levels;

  } catch(e) {
    console.error('[Claude] Level calculation error:', e.message);
    return null;
  }
}

async function optimiseEntryLevels(symbol) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const db = require('./db');
    const closed = db.getAllSignals(100).filter(s =>
      s.symbol === symbol &&
      (s.outcome === 'WIN' || s.outcome === 'LOSS') &&
      s.entry && s.sl && s.tp
    );

    if (closed.length < 5) return null; // need minimum history

    const wins  = closed.filter(s => s.outcome === 'WIN');
    const losses = closed.filter(s => s.outcome === 'LOSS');

    // Calculate average distances for wins vs losses
    const avgWinSlDist  = wins.length  ? wins.reduce((s,t)  => s + Math.abs(t.sl - t.entry), 0) / wins.length  : null;
    const avgLossSlDist = losses.length ? losses.reduce((s,t) => s + Math.abs(t.sl - t.entry), 0) / losses.length : null;
    const avgWinTpDist  = wins.length  ? wins.reduce((s,t)  => s + Math.abs(t.tp - t.entry), 0) / wins.length  : null;
    const avgWinRR      = wins.length  ? wins.reduce((s,t)  => s + (t.rr || 0), 0) / wins.length  : null;
    const avgLossRR     = losses.length ? losses.reduce((s,t) => s + (t.rr || 0), 0) / losses.length : null;

    const prompt = `You are optimising entry, SL and TP placement for ${symbol} trades in the ATLAS system.

HISTORICAL DATA (${closed.length} closed trades):
Win rate: ${Math.round(wins.length / closed.length * 100)}% (${wins.length}W / ${losses.length}L)

Winning trades avg:
- SL distance from entry: ${avgWinSlDist?.toFixed(4) || 'N/A'}
- TP distance from entry: ${avgWinTpDist?.toFixed(4) || 'N/A'}
- R:R: ${avgWinRR?.toFixed(2) || 'N/A'}

Losing trades avg:
- SL distance from entry: ${avgLossSlDist?.toFixed(4) || 'N/A'}
- R:R: ${avgLossRR?.toFixed(2) || 'N/A'}

${closed.slice(0, 15).map(t => t.direction + " entry=" + t.entry + " sl=" + t.sl + " tp=" + t.tp + " rr=" + t.rr + " -> " + t.outcome).join("\n")}
')}

Based on this data, what adjustments would improve future ${symbol} trade placement?
Consider: SL too tight (getting stopped out before TP), TP too ambitious (price reverses before hitting), entry timing.

Return ONLY this JSON (no markdown):
{
  "sl_multiplier": <0.5 to 2.0, multiply ATR-based SL distance by this>,
  "tp_multiplier": <0.5 to 3.0, multiply ATR-based TP distance by this>,
  "entry_bias": <-0.5 to 0.5, shift entry toward limit wall (negative) or away (positive)>,
  "ideal_rr_min": <minimum R:R to accept for this symbol>,
  "ideal_rr_max": <maximum R:R before TP is unrealistic>,
  "key_insight": "<one sentence about what the data shows>",
  "confidence": <0-100, based on sample size and consistency>
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
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const opt  = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Only apply if confidence is high enough
    if (opt.confidence >= 60) {
      entryOptimisation[symbol] = { ...opt, updatedAt: Date.now() };
      console.log(`[Claude] Entry optimised for ${symbol}: SL×${opt.sl_multiplier} TP×${opt.tp_multiplier} — ${opt.key_insight}`);
    }

    return opt;
  } catch(e) {
    console.error('[Claude] Entry optimisation error:', e.message);
    return null;
  }
}

function getEntryOptimisation(symbol) {
  return entryOptimisation[symbol] || null;
}

// ── Getters for dashboard ─────────────────────────────────────────────────────
function getRegime()          { return regimeCache; }
function getSessionPatterns() { return sessionPatterns; }
function getInsights()        { return postTradeInsights.slice(0, 20); }
function getAllOptimisations() { return entryOptimisation; }

module.exports = {
  onOutcome,
  dailySessionSummary,
  detectRegime,
  optimiseEntryLevels,
  getEntryOptimisation,
  getRegime,
  getSessionPatterns,
  getInsights,
  getAllOptimisations
};
