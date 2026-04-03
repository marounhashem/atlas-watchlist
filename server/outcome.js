const { getOpenSignals, updateOutcome, updatePaperOutcome, getLatestMarketData, updateMFE, run, addRecommendation, getRecommendations, markRecommendationFollowed, dismissRecommendation, resolveStaleRecommendations, persist } = require('./db');
let _sendRecAlert = null;
try { _sendRecAlert = require('./telegram').sendRecAlert; } catch(e) {}
const claudeLearner = require('./claudeLearner');
let _SYMBOLS = null;
function getSymbols() { return _SYMBOLS || (_SYMBOLS = require('./config').SYMBOLS); }

// ── Partial TP at 1:1 R:R ──────────────────────────────────────────────────
function checkPartialTP(sig, currentPrice) {
  const { entry, sl, tp, direction } = sig;
  if (!entry || !sl || !tp || !direction) return null;

  const recs = JSON.parse(sig.recommendations || '[]');
  if (recs.some(r => r.type === 'PARTIAL_CLOSE')) return null;

  const risk = Math.abs(entry - sl);
  const reward = direction === 'LONG' ? currentPrice - entry : entry - currentPrice;
  if (reward <= 0) return null;

  const rrAchieved = reward / risk;
  if (rrAchieved >= 1.0) {
    return {
      type: 'PARTIAL_CLOSE',
      reason: `1:1 R:R achieved — close 50% of position, move SL to breakeven (${entry})`,
      urgency: 'MEDIUM',
      close_pct: 50,
      new_sl: entry,
      price: currentPrice,
      rr_achieved: Math.round(rrAchieved * 10) / 10,
      mfe_pct: sig.mfe_pct || 0,
      progress_pct: Math.round((reward / Math.abs(tp - entry)) * 100)
    };
  }
  return null;
}

// ── Time stop on dead trades ────────────────────────────────────────────────
function checkTimeStop(sig) {
  if (sig.outcome !== 'ACTIVE') return null;
  const cfg = getSymbols()[sig.symbol];
  if (!cfg) return null;

  const activeTs = sig.outcome_ts || sig.ts;
  const hoursActive = (Date.now() - activeTs) / 3600000;
  const mfePct = sig.mfe_pct || 0;

  // Don't fire if trade is progressing well
  if (mfePct > 0.20) return null;

  // Check last TIME_STOP — re-fire every 2h if MFE hasn't improved
  const recs = JSON.parse(sig.recommendations || '[]');
  const lastTS = recs.filter(r => r.type === 'TIME_STOP').sort((a, b) => b.ts - a.ts)[0];
  if (lastTS) {
    const hoursSinceLast = (Date.now() - lastTS.ts) / 3600000;
    const mfeImproved = mfePct > (lastTS.mfe_pct || 0) + 0.05;
    if (hoursSinceLast < 2 || mfeImproved) return null;
  }

  // Escalate urgency with time
  let urgency, reason;
  if (hoursActive >= 12 && mfePct < 0.20) {
    urgency = 'HIGH';
    reason = `${Math.round(hoursActive)}h active, MFE only +${mfePct}% — strongly consider closing`;
  } else if (hoursActive >= 8 && mfePct < 0.15) {
    urgency = 'HIGH';
    reason = `${Math.round(hoursActive)}h active, MFE +${mfePct}% — trade is stagnating`;
  } else if (hoursActive >= 4 && mfePct < 0.10) {
    urgency = 'MEDIUM';
    reason = `${Math.round(hoursActive)}h active with only +${mfePct}% MFE — dead trade, consider closing`;
  } else {
    return null;
  }

  return {
    type: 'TIME_STOP',
    reason,
    urgency,
    hours_active: Math.round(hoursActive),
    mfe_pct: mfePct,
    price: null
  };
}

// ── Loss/Win taxonomy ───────────────────────────────────────────────────────
function categoriseOutcome(signal, outcome) {
  const recs = JSON.parse(signal.recommendations || '[]');
  const reasoning = signal.reasoning || '';
  const mfePct = signal.mfe_pct || 0;
  const structScore = signal.weighted_struct_score || 0;

  if (outcome === 'LOSS') {
    if (signal.event_risk_tag || reasoning.includes('pre-event') || reasoning.includes('Trump') || reasoning.includes('NFP'))
      return { category: 'EVENT_RISK', notes: 'Loss around high-impact event.' };
    const highCloses = recs.filter(r => r.type === 'CLOSE' && r.urgency === 'HIGH' && !r.resolved);
    if (highCloses.length >= 2 && signal.rec_followed === 0)
      return { category: 'IGNORED_RECS', notes: `${highCloses.length} HIGH CLOSE recs ignored.` };
    if (recs.some(r => r.type === 'CLOSE' && r.reason?.includes('RSI') && r.urgency === 'HIGH') && mfePct < 0.3)
      return { category: 'MOMENTUM_FAILURE', notes: 'RSI reversed sharply at entry.' };
    if (structScore < 2.0)
      return { category: 'WEAK_STRUCTURE', notes: `Structure ${structScore}/8.5 — lower TF only.` };
    if (reasoning.includes('Counter-trend') || reasoning.includes('conflicts'))
      return { category: 'COUNTER_TREND', notes: 'Counter to macro or daily trend.' };
    if (!signal.macro_context_available)
      return { category: 'NO_MACRO_CONTEXT', notes: 'Scored without macro context.' };
    if (signal.session === 'offHours')
      return { category: 'OFF_HOURS', notes: 'Off-hours session, reduced reliability.' };
    if (reasoning.includes('No Retail OB'))
      return { category: 'NO_OB_DATA', notes: 'Missing Retail Order Book data.' };
    if (mfePct > 0.5)
      return { category: 'MFE_CAPTURE_FAILURE', notes: `MFE was +${mfePct}% but not captured.` };
    return { category: 'UNKNOWN', notes: 'Review manually.' };
  }

  // WIN categories
  if (structScore >= 7.0) return { category: 'STRONG_STRUCTURE', notes: `Structure ${structScore}/8.5 — full TF confirmation.` };
  if (reasoning.includes('Macro') && reasoning.includes('confirms')) return { category: 'MACRO_ALIGNED', notes: 'Macro confirmed direction.' };
  if (reasoning.includes('COT extreme favours')) return { category: 'COT_CONTRARIAN', notes: 'COT extreme provided contrarian edge.' };
  if (signal.session !== 'offHours') return { category: 'PEAK_SESSION', notes: 'Clean win during peak session.' };
  return { category: 'TECHNICAL', notes: 'Technical setup executed cleanly.' };
}

// checkOutcomes runs across ALL cycles — retired signals still get WIN/LOSS detected
// Only dedup (saveSignal) uses getCurrentCycleOpenSignals

// Signal lifecycle:
// OPEN (entry not touched) → ACTIVE (entry touched, TP/SL not yet) → WIN / LOSS
// OPEN can also be REPLACED (better signal superseded it)
// ACTIVE signals cannot be replaced

function checkOutcomes(broadcast) {
  const openSignals = getOpenSignals(); // returns OPEN and ACTIVE
  if (openSignals.length === 0) return;

  for (const sig of openSignals) {
    const data = getLatestMarketData(sig.symbol);
    if (!data || !data.close) continue;

    const price = data.close;
    // Intrabar high/low — captures TP/SL hits that close back through the level
    const barHigh = data.high || price;
    const barLow  = data.low  || price;
    const { direction, entry, sl, tp, id, outcome: currentState } = sig;
    if (!entry || !sl || !tp) continue;

    const tolerance = entry * 0.0015; // 0.15% tolerance for entry touch detection

    // ── Check entry touched ──────────────────────────────────────────────────
    let entryTouched = false;
    if (direction === 'LONG')  entryTouched = barLow  <= entry + tolerance;
    if (direction === 'SHORT') entryTouched = barHigh >= entry - tolerance;

    if (currentState === 'OPEN' && entryTouched) {
      // Transition OPEN → ACTIVE
      updateOutcome(id, 'ACTIVE', null);
      console.log(`[Outcome] ${sig.symbol} ${direction} → ACTIVE (entry touched @ ${price})`);
      if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome: 'ACTIVE', ts: Date.now() });

      // Only expire opposite OPEN signals — ACTIVE signals are real trades, don't auto-close
      // IMPORTANT: query OPEN-only, NOT getLatestOpenSignal which returns ACTIVE first
      const oppositeDir = direction === 'LONG' ? 'SHORT' : 'LONG';
      const dbMod = require('./db');
      const allOpen = dbMod.getOpenSignals().filter(s =>
        s.symbol === sig.symbol && s.direction === oppositeDir && s.outcome === 'OPEN'
      );
      const oppositeOpen = allOpen[0] || null;
      if (oppositeOpen) {
        dbMod.updateOutcome(oppositeOpen.id, 'EXPIRED', 0);
        console.log(`[Outcome] ${sig.symbol} — expired opposite ${oppositeDir} OPEN (id:${oppositeOpen.id})`);
        if (broadcast) broadcast({ type: 'OUTCOME', signalId: oppositeOpen.id, symbol: sig.symbol, direction: oppositeDir, outcome: 'EXPIRED', ts: Date.now() });
      }
      continue;
    }

    // ── Track max favorable excursion (MFE) on ACTIVE signals ────────────────
    // MFE = how far price moved toward TP before reversing
    // Stored so Claude can distinguish "right direction, bad SL" vs "wrong call"
    if (currentState === 'ACTIVE' && entry) {
      let favorable = 0;
      if (direction === 'LONG')  favorable = Math.max(0, barHigh - entry); // intrabar peak
      if (direction === 'SHORT') favorable = Math.max(0, entry - barLow);  // intrabar trough
      if (favorable > 0) {
        const mfePct = Math.round((favorable / entry) * 10000) / 100;
        updateMFE(id, favorable, mfePct);
      }
    }

    // ── Trade Monitor: Generate recommendations on ACTIVE signals ───────────────
    // Runs every outcome check cycle — evaluates if original thesis still holds
    if (currentState === 'ACTIVE') {
      // Resolve stale recommendations — RSI HIGH recs use invalidation, others use 20min timer
      const currentRsi = data.rsi || null;
      resolveStaleRecommendations(id, currentRsi, sig.direction);
      const recs = generateRecommendations(sig, data, price);
      // Partial TP at 1:1 R:R
      const partialRec = checkPartialTP(sig, price);
      if (partialRec) recs.push(partialRec);
      // Time stop on dead trades
      const timeRec = checkTimeStop(sig);
      if (timeRec) { timeRec.price = price; recs.push(timeRec); }
      for (const rec of recs) {
        const added = addRecommendation(id, rec);
        if (added) {
          console.log(`[Monitor] ${sig.symbol} ${direction} — ${rec.type} (${rec.urgency}): ${rec.reason}`);
          if (broadcast) broadcast({
            type: 'RECOMMENDATION',
            signalId: id,
            symbol: sig.symbol,
            direction,
            recommendation: rec,
            ts: Date.now()
          });
          // Telegram push for HIGH urgency recs + MEDIUM MOVE_SL near TP
          if (_sendRecAlert) {
            const pushHigh = rec.urgency === 'HIGH';
            const pushMoveSl = rec.urgency === 'MEDIUM' && rec.type === 'MOVE_SL' && rec.progress_pct >= 80;
            const pushPartial = rec.type === 'PARTIAL_CLOSE';
            const pushTimeStop = rec.type === 'TIME_STOP';
            if (pushHigh || pushMoveSl || pushPartial || pushTimeStop) {
              _sendRecAlert(sig, rec).catch(e => console.error('[Telegram] Rec alert error:', e.message));
            }
          }
        }
      }
    }

    // ── Check TP / SL for ACTIVE signals ─────────────────────────────────────
    if (currentState === 'ACTIVE') {
      let outcome = null;
      let pnlPct  = null;

      // Use intrabar high/low — catches TP/SL hits that occur intrabar
      // but where the bar closes back through the level (e.g. wick through TP).
      // PnL uses the fixed TP/SL price, not the intrabar extreme.
      if (direction === 'LONG') {
        if (barHigh >= tp) {
          outcome = 'WIN';
          pnlPct  = Math.round(((tp - entry) / entry) * 10000) / 100;
        } else if (barLow <= sl) {
          outcome = 'LOSS';
          pnlPct  = -Math.round((Math.abs(sl - entry) / entry) * 10000) / 100;
        }
      } else {
        if (barLow <= tp) {
          outcome = 'WIN';
          pnlPct  = Math.round(((entry - tp) / entry) * 10000) / 100;
        } else if (barHigh >= sl) {
          outcome = 'LOSS';
          pnlPct  = -Math.round((Math.abs(sl - entry) / entry) * 10000) / 100;
        }
      }

      if (outcome) {
        // Auto-mark CLOSE recommendations as followed when SL hits (LOSS)
        // Teaches learner: CLOSE rec before LOSS = recommendation was correct
        if (outcome === 'LOSS') {
          try {
            const existingRecs = getRecommendations(id);
            const hadClose = existingRecs.some(r => r.type === 'CLOSE' && !r.dismissed);
            if (hadClose) markRecommendationFollowed(id);
          } catch(e) {}
        }
        updateOutcome(id, outcome, pnlPct);
        // Categorise outcome
        try {
          const cat = categoriseOutcome(sig, outcome);
          run('UPDATE signals SET outcome_category=?, outcome_notes=? WHERE id=?', [cat.category, cat.notes, id]);
          persist();
          console.log(`[Outcome] ${sig.symbol} ${direction} → ${outcome} (${pnlPct > 0 ? '+' : ''}${pnlPct}%) [${cat.category}]`);
        } catch(e) {
          console.log(`[Outcome] ${sig.symbol} ${direction} → ${outcome} (${pnlPct > 0 ? '+' : ''}${pnlPct}%)`);
        }
        if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome, pnlPct, ts: Date.now() });
        // Fire Claude learning automatically
        claudeLearner.onOutcome({ ...sig, pnl_pct: pnlPct }, outcome, broadcast).catch(e =>
          console.error('[Claude] Auto-learning error:', e.message)
        );
      }

      // ── Expire ACTIVE signals older than 24h ────────────────────────────────
      // An ACTIVE signal stuck for 24h means price is going nowhere — treat as EXPIRED
      if (currentState === 'ACTIVE' && !outcome) {
        const ageHours = (Date.now() - sig.ts) / 3600000;
        if (ageHours > 24) {
          updateOutcome(id, 'EXPIRED', 0);
          console.log(`[Outcome] ${sig.symbol} ${direction} → EXPIRED (ACTIVE 24h timeout)`);
          if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome: 'EXPIRED', ts: Date.now() });
        }
      }
    }

    // ── Expire OPEN signals past their expiry time ─────────────────────────────
    if (currentState === 'OPEN') {
      const expired = sig.expires_at ? Date.now() > sig.expires_at : (Date.now() - sig.ts) / 3600000 > 48;
      if (expired) {
        updateOutcome(id, 'EXPIRED', 0);
        console.log(`[Outcome] ${sig.symbol} ${direction} → EXPIRED (${sig.expires_at ? 'asset-class expiry' : '48h fallback'})`);
        if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome: 'EXPIRED', ts: Date.now() });
      }
    }

    // WATCH paper trade tracking removed — WATCH signals are stored in watch_signals table
    // (not the signals table), so this code block was unreachable. Paper tracking for
    // WATCH signals would need to query watch_signals separately.
  }
}

// ── Trade Monitor: Recommendation Engine ─────────────────────────────────────
// Called on every ACTIVE signal check
// Returns array of recommendations based on current market conditions
function generateRecommendations(sig, data, price) {
  const recs = [];
  const { direction, entry, sl, tp, id } = sig;
  if (!entry || !sl || !tp || !price) return recs;

  const mfePct = sig.mfe_pct || 0;
  const tpDist = Math.abs(tp - entry);
  const slDist = Math.abs(sl - entry);
  const priceDist = direction === 'LONG' ? price - entry : entry - price;
  const progressPct = tpDist > 0 ? Math.round((priceDist / tpDist) * 100) : 0;

  // ── 1. CLOSE recommendations ──────────────────────────────────────────────

  // Structure flipped against direction on BOTH 1h and 4h
  // Requires 2 consecutive checks (2 minutes) before firing — reduces noise from
  // brief intraday structure flips that recover within one candle
  try {
    if (data.raw_payload) {
      const raw = JSON.parse(data.raw_payload);
      const st  = raw.structure || {};
      const str1h = typeof st['1h'] === 'number' ? st['1h'] : 0;
      const str4h = typeof st['4h'] === 'number' ? st['4h'] : 0;

      const structBearish = direction === 'LONG'  && str1h === -1 && str4h === -1;
      const structBullish = direction === 'SHORT' && str1h ===  1 && str4h ===  1;

      if (structBearish || structBullish) {
        // Check if structure was ALREADY against direction on previous check
        // by looking for an unresolved CLOSE rec with structure reason < 3 min ago
        const existingRecs = getRecommendations(sig.id);
        const twoMinAgo = Date.now() - 3 * 60 * 1000;
        const prevStructureFlip = existingRecs.find(r =>
          r.type === 'CLOSE' &&
          r.reason && r.reason.includes('Structure flipped') &&
          !r.resolved &&
          !r.dismissed &&
          r.ts > twoMinAgo
        );

        if (prevStructureFlip) {
          // Structure was already against us last check AND still is — confirmed flip
          recs.push({
            type: 'CLOSE',
            reason: structBearish
              ? 'Structure confirmed bearish on 1h AND 4h (2nd consecutive check) — exit now'
              : 'Structure confirmed bullish on 1h AND 4h (2nd consecutive check) — exit now',
            urgency: 'HIGH',
            price,
            mfe_pct: mfePct,
            progress_pct: progressPct
          });
        } else {
          // First time seeing this flip — store as a LOW urgency warning, not CLOSE yet
          recs.push({
            type: 'CLOSE',
            reason: structBearish
              ? 'Structure flipped bearish on 1h AND 4h — monitoring, will confirm next check'
              : 'Structure flipped bullish on 1h AND 4h — monitoring, will confirm next check',
            urgency: 'LOW', // downgraded until confirmed
            price,
            mfe_pct: mfePct,
            progress_pct: progressPct
          });
        }
      }
    }
  } catch(e) {}

  // FXSSI crowd trap reversed — was trapped short (our LONG thesis), now trapped long
  try {
    const longPct  = data.fxssi_long_pct  || 50;
    const shortPct = data.fxssi_short_pct || 50;
    if (direction === 'LONG'  && longPct  >= 65) {
      recs.push({
        type: 'CLOSE',
        reason: `Retail Order Book crowd flipped — ${longPct}% now LONG (was short) — squeeze thesis gone`,
        urgency: 'HIGH',
        price,
        mfe_pct: mfePct,
        progress_pct: progressPct
      });
    }
    if (direction === 'SHORT' && shortPct >= 65) {
      recs.push({
        type: 'CLOSE',
        reason: `Retail Order Book crowd flipped — ${shortPct}% now SHORT (was long) — squeeze thesis gone`,
        urgency: 'HIGH',
        price,
        mfe_pct: mfePct,
        progress_pct: progressPct
      });
    }
  } catch(e) {}

  // RSI extreme against direction
  try {
    const rsi = data.rsi || 50;
    if (direction === 'LONG'  && rsi < 30) {
      recs.push({
        type: 'CLOSE',
        reason: `RSI ${rsi} — extreme momentum against LONG, likely accelerating down`,
        urgency: 'HIGH',
        price,
        mfe_pct: mfePct,
        progress_pct: progressPct
      });
    }
    if (direction === 'SHORT' && rsi > 70) {
      recs.push({
        type: 'CLOSE',
        reason: `RSI ${rsi} — extreme momentum against SHORT, likely accelerating up`,
        urgency: 'HIGH',
        price,
        mfe_pct: mfePct,
        progress_pct: progressPct
      });
    }
  } catch(e) {}

  // Price moved against trade — fire CLOSE rec early enough to act on
  // 60% = early warning (MEDIUM), 70% = urgent (HIGH)
  // Raised from 40% → 60%: below 60% is normal oscillation on a 2:1 RR trade.
  // The RSI HIGH rec already covers early momentum reversals.
  // MEDIUM fires only when you're genuinely close to the SL.
  // SL proximity — escalating urgency, never auto-expires
  const maeProgress = slDist > 0 ? Math.round((-priceDist / slDist) * 100) : 0;
  if (maeProgress > 85) {
    recs.push({
      type: 'CLOSE',
      reason: `Price ${maeProgress}% of the way to SL — urgent, cut now`,
      urgency: 'HIGH',
      price,
      mfe_pct: mfePct,
      progress_pct: progressPct
    });
    // 95%+ to SL — immediate Telegram push
    if (maeProgress > 95 && _sendRecAlert) {
      try {
        _sendRecAlert(sig, {
          type: 'CLOSE', urgency: 'HIGH',
          reason: `🚨 ${sig.symbol} ${direction} — price ${maeProgress}% to SL · Entry: ${entry} · SL: ${sl} · Current: ${price}`
        }).catch(() => {});
      } catch(e) {}
    }
  } else if (maeProgress > 70) {
    recs.push({
      type: 'CLOSE',
      reason: `Price ${maeProgress}% of the way to SL — consider cutting early`,
      urgency: 'MEDIUM',
      price,
      mfe_pct: mfePct,
      progress_pct: progressPct
    });
  } else if (maeProgress > 50) {
    recs.push({
      type: 'CLOSE',
      reason: `Price ${maeProgress}% of the way to SL — monitor closely`,
      urgency: 'LOW',
      price,
      mfe_pct: mfePct,
      progress_pct: progressPct
    });
  }

  // ── 2. MOVE_SL recommendations ────────────────────────────────────────────

  // MFE > 50% of TP distance — move SL to breakeven
  if (progressPct >= 50 && progressPct < 100) {
    const breakevenSL = Math.round(entry * 10000) / 10000;
    recs.push({
      type: 'MOVE_SL',
      reason: `Price ${progressPct}% toward TP — move SL to breakeven (${breakevenSL})`,
      urgency: 'MEDIUM',
      new_sl: breakevenSL,
      price,
      mfe_pct: mfePct,
      progress_pct: progressPct
    });
  }

  // MFE > 75% of TP — trail SL to 25% of TP distance
  if (progressPct >= 75) {
    const trailSL = direction === 'LONG'
      ? Math.round((entry + tpDist * 0.25) * 10000) / 10000
      : Math.round((entry - tpDist * 0.25) * 10000) / 10000;
    recs.push({
      type: 'MOVE_SL',
      reason: `Price ${progressPct}% toward TP — trail SL to protect 25% of TP (${trailSL})`,
      urgency: 'MEDIUM',
      new_sl: trailSL,
      price,
      mfe_pct: mfePct,
      progress_pct: progressPct
    });
  }

  // New FXSSI gravity cluster between entry and SL — tighten
  try {
    if (data.fxssi_analysis) {
      const fx = typeof data.fxssi_analysis === 'string'
        ? JSON.parse(data.fxssi_analysis) : data.fxssi_analysis;
      const gravity = fx?.gravity?.price;
      if (gravity) {
        const gravitySL = direction === 'LONG'
          ? gravity < price && gravity > sl && gravity > entry * 0.997
          : gravity > price && gravity < sl && gravity < entry * 1.003;
        if (gravitySL) {
          const newSL = direction === 'LONG'
            ? Math.round((gravity * 0.999) * 10000) / 10000
            : Math.round((gravity * 1.001) * 10000) / 10000;
          recs.push({
            type: 'MOVE_SL',
            reason: `Retail Order Book gravity cluster at ${gravity} between SL and price — tighten SL`,
            urgency: 'LOW',
            new_sl: newSL,
            price,
            mfe_pct: mfePct,
            progress_pct: progressPct
          });
        }
      }
    }
  } catch(e) {}

  // ── 3. ADJUST_TP recommendations ─────────────────────────────────────────

  // New FXSSI resistance/support appeared between price and TP
  try {
    if (data.fxssi_analysis) {
      const fx = typeof data.fxssi_analysis === 'string'
        ? JSON.parse(data.fxssi_analysis) : data.fxssi_analysis;
      const walls = fx?.limitWalls || [];
      for (const wall of walls) {
        const wallBetween = direction === 'LONG'
          ? wall.price > price && wall.price < tp && wall.volume > 1.5
          : wall.price < price && wall.price > tp && wall.volume > 1.5;
        if (wallBetween) {
          const newTP = direction === 'LONG'
            ? Math.round((wall.price * 0.999) * 10000) / 10000
            : Math.round((wall.price * 1.001) * 10000) / 10000;
          recs.push({
            type: 'ADJUST_TP',
            reason: `Strong limit wall (vol ${wall.volume}) at ${wall.price} blocking TP — consider taking profit earlier`,
            urgency: 'LOW',
            new_tp: newTP,
            price,
            mfe_pct: mfePct,
            progress_pct: progressPct
          });
          break; // only flag nearest wall
        }
      }
    }
  } catch(e) {}

  return recs;
}

module.exports = { checkOutcomes };
