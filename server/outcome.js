const { getOpenSignals, updateOutcome, updatePaperOutcome, getLatestMarketData, updateMFE, run, addRecommendation, getRecommendations, markRecommendationFollowed, dismissRecommendation, resolveStaleRecommendations } = require('./db');
const claudeLearner = require('./claudeLearner');

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
    const { direction, entry, sl, tp, id, outcome: currentState } = sig;
    if (!entry || !sl || !tp) continue;

    const tolerance = entry * 0.0015; // 0.15% tolerance for entry touch detection

    // ── Check entry touched ──────────────────────────────────────────────────
    let entryTouched = false;
    if (direction === 'LONG')  entryTouched = price <= entry + tolerance;
    if (direction === 'SHORT') entryTouched = price >= entry - tolerance;

    if (currentState === 'OPEN' && entryTouched) {
      // Transition OPEN → ACTIVE
      updateOutcome(id, 'ACTIVE', null);
      console.log(`[Outcome] ${sig.symbol} ${direction} → ACTIVE (entry touched @ ${price})`);
      if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome: 'ACTIVE', ts: Date.now() });

      // Expire any opposite direction ACTIVE signals — can't be long and short simultaneously
      const oppositeDir = direction === 'LONG' ? 'SHORT' : 'LONG';
      const { run: dbRun, persist: dbPersist, get: dbGet } = require('./db');
      const oppositeActive = dbGet(
        "SELECT id FROM signals WHERE symbol=? AND direction=? AND outcome='ACTIVE' AND (cycle IS NULL OR cycle=0) ORDER BY ts DESC LIMIT 1",
        [sig.symbol, oppositeDir]
      );
      if (oppositeActive) {
        dbRun("UPDATE signals SET outcome='EXPIRED', outcome_ts=? WHERE id=?", [Date.now(), oppositeActive.id]);
        dbPersist();
        console.log(`[Outcome] ${sig.symbol} — expired opposite ${oppositeDir} ACTIVE (id:${oppositeActive.id})`);
        if (broadcast) broadcast({ type: 'OUTCOME', signalId: oppositeActive.id, symbol: sig.symbol, direction: oppositeDir, outcome: 'EXPIRED', ts: Date.now() });
      }
      continue;
    }

    // ── Track max favorable excursion (MFE) on ACTIVE signals ────────────────
    // MFE = how far price moved toward TP before reversing
    // Stored so Claude can distinguish "right direction, bad SL" vs "wrong call"
    if (currentState === 'ACTIVE' && entry) {
      let favorable = 0;
      if (direction === 'LONG'  && price > entry) favorable = price - entry;
      if (direction === 'SHORT' && price < entry) favorable = entry - price;
      if (favorable > 0) {
        const mfePct = Math.round((favorable / entry) * 10000) / 100;
        updateMFE(id, favorable, mfePct);
      }
    }

    // ── Trade Monitor: Generate recommendations on ACTIVE signals ───────────────
    // Runs every outcome check cycle — evaluates if original thesis still holds
    if (currentState === 'ACTIVE') {
      // First resolve stale recommendations (20 min old = condition gone)
      resolveStaleRecommendations(id);
      const recs = generateRecommendations(sig, data, price);
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
        }
      }
    }

    // ── Check TP / SL for ACTIVE signals ─────────────────────────────────────
    if (currentState === 'ACTIVE') {
      let outcome = null;
      let pnlPct  = null;

      if (direction === 'LONG') {
        if (price >= tp) {
          outcome = 'WIN';
          pnlPct  = Math.round(((tp - entry) / entry) * 10000) / 100;
        } else if (price <= sl) {
          outcome = 'LOSS';
          pnlPct  = Math.round(((sl - entry) / entry) * 10000) / 100;
        }
      } else {
        if (price <= tp) {
          outcome = 'WIN';
          pnlPct  = Math.round(((entry - tp) / entry) * 10000) / 100;
        } else if (price >= sl) {
          outcome = 'LOSS';
          pnlPct  = Math.round(((entry - sl) / entry) * 10000) / 100;
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
        console.log(`[Outcome] ${sig.symbol} ${direction} → ${outcome} (${pnlPct > 0 ? '+' : ''}${pnlPct}%)`);
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

    // ── Expire OPEN signals older than 48h ────────────────────────────────────
    if (currentState === 'OPEN') {
      const ageHours = (Date.now() - sig.ts) / 3600000;
      if (ageHours > 48) {
        updateOutcome(id, 'EXPIRED', 0);
        console.log(`[Outcome] ${sig.symbol} ${direction} → EXPIRED (48h)`);
        if (broadcast) broadcast({ type: 'OUTCOME', signalId: id, symbol: sig.symbol, direction, outcome: 'EXPIRED', ts: Date.now() });
      }
    }

    // ── WATCH paper trade tracking ────────────────────────────────────────────
    // Only record paper outcome if entry was actually touched first
    // Prevents inflated stats from signals that were never realistically enterable
    if (sig.verdict === 'WATCH' && !sig.paper_outcome && entry && sl && tp) {
      const watchEntryTouched = direction === 'LONG'
        ? price <= entry + tolerance
        : price >= entry - tolerance;
      if (watchEntryTouched) {
        let paperOutcome = null;
        if (direction === 'LONG') {
          if (price >= tp) paperOutcome = 'WIN';
          else if (price <= sl) paperOutcome = 'LOSS';
        } else {
          if (price <= tp) paperOutcome = 'WIN';
          else if (price >= sl) paperOutcome = 'LOSS';
        }
        if (paperOutcome) {
          updatePaperOutcome(id, paperOutcome);
          console.log(`[Outcome] ${sig.symbol} ${direction} WATCH → paper ${paperOutcome}`);
          if (broadcast) broadcast({ type: 'PAPER_OUTCOME', signalId: id, symbol: sig.symbol, direction, paperOutcome, ts: Date.now() });
        }
      }
    }
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
        reason: `FXSSI crowd flipped — ${longPct}% now LONG (was short) — squeeze thesis gone`,
        urgency: 'HIGH',
        price,
        mfe_pct: mfePct,
        progress_pct: progressPct
      });
    }
    if (direction === 'SHORT' && shortPct >= 65) {
      recs.push({
        type: 'CLOSE',
        reason: `FXSSI crowd flipped — ${shortPct}% now SHORT (was long) — squeeze thesis gone`,
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
  // 40% = early warning (MEDIUM), 70% = urgent (HIGH)
  const maeProgress = slDist > 0 ? Math.round((-priceDist / slDist) * 100) : 0;
  if (maeProgress > 70) {
    recs.push({
      type: 'CLOSE',
      reason: `Price ${maeProgress}% of the way to SL — urgent, cut now`,
      urgency: 'HIGH',
      price,
      mfe_pct: mfePct,
      progress_pct: progressPct
    });
  } else if (maeProgress > 40) {
    recs.push({
      type: 'CLOSE',
      reason: `Price ${maeProgress}% of the way to SL — consider cutting early`,
      urgency: 'MEDIUM',
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
            reason: `FXSSI gravity cluster at ${gravity} between SL and price — tighten SL`,
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
