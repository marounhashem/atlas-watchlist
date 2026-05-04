// Telegram Bot Integration — raw fetch(), no external libraries
// Sends signal alerts, trade monitor recs, morning brief, health alerts

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Escape untrusted content for Telegram HTML parse_mode. Only needed on
// interpolated content (DB fields, req.body, scraped event titles), NOT on
// template structure tags (<b>, <i>, <code>) which are intentional.
// Helper added without call-site changes — see handover audit, Commit 3.
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Format scorer.macroState into a one-line tag for Telegram / dashboard cards.
// Macro is informational only (multiplier disabled 20260504). This makes it
// scannable so the trader can read context without it skewing the score.
function fmtMacroLine(macroState) {
  if (!macroState || !macroState.available) {
    if (macroState && macroState.stale) return `📰 Macro stale (${macroState.ageHours}h old) — info only`;
    return null;
  }
  const sent = macroState.sentiment || 'unknown';
  const strength = macroState.strength != null ? ` ${macroState.strength}/10` : '';
  const align = macroState.alignsWith === 'neutral' ? 'neutral'
    : macroState.alignsWith ? `aligns ${macroState.alignsWith}` : '';
  const sumShort = (macroState.summary || '').slice(0, 110).trim();
  const tail = sumShort ? ` — ${sumShort}` : '';
  return `📰 Macro: ${sent}${strength}${align ? ` · ${align}` : ''}${tail} <i>(info only)</i>`;
}

async function sendMessage(text, parseMode = 'HTML', retries = 2) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true
        })
      });
      const data = await res.json();
      if (!data.ok) console.error('[Telegram] Send error:', data.description);
      return data.ok;
    } catch(e) {
      console.error(`[Telegram] fetch failed (attempt ${attempt + 1}/${retries + 1}):`, e.message);
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return false;
}

// Signal alert — fires when a new PROCEED signal is saved
async function sendSignalAlert(signal) {
  const dir = signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';

  // Mercato generated signal — special format (Flow 3)
  if (signal.session === 'MERCATO') {
    const text = [
      `📡 <b>MERCATO GENERATED SIGNAL</b>`,
      `━━━━━━━━━━━━━━━━━`,
      `<b>${dir} ${signal.symbol}</b> — Score: ${signal.score} | RR: ${signal.rr}R`,
      ``,
      `Entry: <b>${signal.entry}</b>`,
      `SL: ${signal.sl}`,
      `TP1: ${signal.tp1} | TP2: ${signal.tp2} | TP3: ${signal.tp3}`,
      `━━━━━━━━━━━━━━━━━`,
      escHtml(signal.reasoning || '')
    ].join('\n');
    return sendMessage(text);
  }

  const tag = signal.eventRiskTag;
  const verdict = tag === 'SUPPRESSED' ? '🔕 WATCH/SUPPRESSED'
    : tag === 'PRE_EVENT' ? `⚠️ ${signal.verdict}/EVENT-RISK`
    : tag === 'CARRY_RISK' ? `⚠️ ${signal.verdict}/CARRY-RISK`
    : signal.verdict === 'PROCEED' ? '✅ PROCEED' : '👀 WATCH';
  const macroLine = fmtMacroLine(signal.macroState);
  const text = [
    `<b>ATLAS // ${signal.symbol} ${dir}</b>`,
    `${verdict} — Score: ${signal.score}%`,
    ``,
    `Entry: <b>${signal.entry}</b>`,
    `SL: ${signal.sl}`,
    `TP: ${signal.tp}`,
    `R:R: ${signal.rr}`,
    `Session: ${signal.session}`,
    ``,
    `${escHtml(signal.reasoning || '').split(' · ').slice(0, 4).join('\n')}`,
    macroLine ? `\n${macroLine}` : '',
  ].filter(Boolean).join('\n');
  return sendMessage(text);
}

// HIGH urgency recommendation alert
async function sendRecAlert(signal, rec) {
  // Partial TP special format
  if (rec.type === 'PARTIAL_CLOSE') {
    return sendMessage([
      `⚡ <b>ATLAS // ${signal.symbol} ${signal.direction}</b>`,
      `PARTIAL CLOSE — 1:1 R:R achieved`, '',
      `Close half position at: <b>${rec.price}</b>`,
      `Move SL to breakeven: <b>${rec.new_sl}</b>`, '',
      `R:R reached: ${rec.rr_achieved} | MFE: +${rec.mfe_pct}%`,
      `Remaining runs to TP: ${signal.tp}`,
    ].join('\n'));
  }
  // Time stop special format
  if (rec.type === 'TIME_STOP') {
    return sendMessage([
      `⏱ <b>ATLAS // ${signal.symbol} TIME STOP</b>`, '',
      `${rec.hours_active}h active — price not moving`,
      `MFE only +${rec.mfe_pct}% — dead trade`, '',
      `Consider closing to free capital`,
      `Entry: ${signal.entry} | TP: ${signal.tp}`,
    ].join('\n'));
  }
  const urgencyIcon = rec.urgency === 'HIGH' ? '🚨' : '⚠️';
  const text = [
    `${urgencyIcon} <b>ATLAS // ${signal.symbol} ${signal.direction}</b>`,
    `<b>${rec.type}</b> — ${rec.urgency} URGENCY`,
    ``,
    `${rec.reason}`,
    `Price: ${rec.price}`,
    rec.new_sl ? `New SL: ${rec.new_sl}` : '',
    rec.mfe_pct ? `MFE: ${rec.mfe_pct}% | Progress: ${rec.progress_pct}%` : '',
    ``,
    `Entry: ${signal.entry} | TP: ${signal.tp}`,
  ].filter(Boolean).join('\n');
  return sendMessage(text);
}

// Morning brief — splits into multiple messages if >4096 chars (Telegram limit)
async function sendMorningBrief(brief) {
  if (!brief) return false;
  const MAX = 4000; // leave margin for safety
  if (brief.length <= MAX) return sendMessage(brief, 'HTML');

  // Split on double-newline section boundaries to keep sections intact
  const sections = brief.split('\n\n');
  const chunks = [];
  let current = '';
  for (const section of sections) {
    // If a single section exceeds MAX, hard-split it on newlines
    if (section.length > MAX) {
      if (current.trim()) { chunks.push(current.trim()); current = ''; }
      const lines = section.split('\n');
      let part = '';
      for (const line of lines) {
        if (part.length + line.length + 1 > MAX && part.length > 0) {
          chunks.push(part.trim());
          part = '';
        }
        part += (part ? '\n' : '') + line;
      }
      if (part.trim()) current = part;
      continue;
    }
    if (current.length + section.length + 2 > MAX && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += (current ? '\n\n' : '') + section;
  }
  if (current.trim()) chunks.push(current.trim());

  let allOk = true;
  for (let i = 0; i < chunks.length; i++) {
    const ok = await sendMessage(chunks[i], 'HTML');
    if (!ok) allOk = false;
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300)); // rate limit
  }
  return allOk;
}

// Health alert
async function sendHealthAlert(problems) {
  const text = [
    `⚠️ <b>ATLAS // SYSTEM DEGRADED</b>`,
    ``,
    ...problems.map(p => `${p.symbol}: ${p.alerts.join(', ')}`)
  ].join('\n');
  return sendMessage(text);
}

// Economic event fired alert with sentiment analysis
async function sendEventFiredAlert(event, sentiment, affectedSymbols) {
  const beat = sentiment?.beat || 0;
  const biasIcon = beat > 0 ? '📈' : beat < 0 ? '📉' : '➡️';
  const biasLabel = beat > 0
    ? `Beat forecast — ${event.currency} bullish signal`
    : beat < 0
    ? `Missed forecast — ${event.currency} bearish signal`
    : `In line with forecast`;

  // Get directional arrows and special case notes
  let arrows = '';
  let special = '';
  try {
    const { getEventArrows, getSpecialCaseNote } = require('./forexCalendar');
    arrows = getEventArrows(event.currency, beat);
    special = getSpecialCaseNote(event.currency, beat);
  } catch(e) {}

  const text = [
    `📊 <b>${escHtml(event.title)}</b>`,
    `Actual: <b>${escHtml(event.actual || 'Released')}</b> | Forecast: ${escHtml(event.forecast || '—')} | Prev: ${escHtml(event.previous || '—')}`,
    `${biasIcon} ${biasLabel}`,
    arrows,
    special,
    sentiment?.trendSummary ? `📊 ${sentiment.trendSummary}` : '',
    `⏸ 5min volatility window`,
    `✅ Opportunity window opens in 5min`,
  ].filter(Boolean).join('\n');
  return sendMessage(text);
}

// Swing channel signal alert
async function sendSwingMessage(text, parseMode = 'HTML') {
  const token = process.env.TELEGRAM_SWING_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_SWING_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true })
    });
    const data = await res.json();
    if (!data.ok) console.error('[Telegram-Swing] Send error:', data.description);
    return data.ok;
  } catch(e) { return false; }
}

async function sendSwingSignalAlert(signal) {
  const dir = signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const slPct = Math.round(Math.abs(signal.entry - signal.sl) / signal.entry * 1000) / 10;
  const macroLine = fmtMacroLine(signal.macroState);
  const text = [
    `📈 <b>ATLAS SWING // ${signal.symbol} ${dir}</b>`,
    `✅ PROCEED — Score: ${signal.score}% | R:R: ${signal.rr}`,
    `Structure: ${signal.weightedStructScore}/8.5 — swing confirmed`,
    ``,
    `🎯 Entry: <b>${signal.entry}</b>`,
    `🛡 Stop: ${signal.sl} (${slPct}%)`,
    `💰 Target: ${signal.tp}`,
    `⏰ Session: ${signal.session}`,
    ``,
    `${escHtml(signal.reasoning || '').split(' · ').slice(0, 4).join('\n')}`,
    macroLine ? `\n${macroLine}` : '',
  ].filter(Boolean).join('\n');
  return sendSwingMessage(text);
}

// ── ABC signal alert → swing Telegram channel ─────────────────────────────────
async function sendAbcSignalAlert(sig) {
  const dir     = sig.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const verdict = sig.verdict === 'PROCEED' ? '✅ PROCEED' : '👁 WATCH';
  const cls     = sig.pineClass === 'A' ? '⭐ Class A' : sig.pineClass === 'B' ? '🔷 Class B' : '🔹 Class C';

  const msg = [
    `${cls} ${verdict} — ${sig.symbol} ${dir}`,
    `Entry: ${sig.entry} | SL: ${sig.sl} | Score: ${sig.score}/95`,
    '',
    sig.tp1 ? `TP1 🎯 ${sig.tp1}  (partial close)` : '',
    sig.tp2 ? `TP2 🎯 ${sig.tp2}  (main target)` : (sig.tp ? `TP 🎯 ${sig.tp}` : ''),
    sig.tp3 ? `TP3 🚀 ${sig.tp3}  (runner)` : '',
    '',
    `RR: ${sig.rr}R | Session: ${sig.session}`,
    sig.reasoning ? escHtml(sig.reasoning).split('. ').slice(0, 2).join('. ') : ''
  ].filter(Boolean).join('\n');

  return sendSwingMessage(msg);
}

// Entry touch alert — fires when a PROCEED signal transitions OPEN → ACTIVE
async function sendEntryTouchAlert(signal, touchPrice) {
  const dir  = signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const slPct = Math.round(Math.abs(signal.entry - signal.sl) / signal.entry * 1000) / 10;
  const tpPct = Math.round(Math.abs(signal.tp - signal.entry) / signal.entry * 1000) / 10;
  const text = [
    `🎯 <b>ATLAS // ENTRY TOUCHED</b>`,
    `${dir} ${signal.symbol} — now ACTIVE`,
    ``,
    `Touched @ <b>${touchPrice}</b>`,
    `Entry: ${signal.entry}`,
    `SL: ${signal.sl} (${slPct}%)`,
    `TP: ${signal.tp} (${tpPct}%)`,
    `R:R: ${signal.rr}`,
    ``,
    `Manage from here — partials at 1:1, trail as progress grows.`
  ].join('\n');
  return sendMessage(text);
}

// ABC entry touch alert → swing Telegram channel
async function sendAbcEntryTouchAlert(sig, touchPrice) {
  const dir = sig.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const pClass = sig.pineClass || sig.pine_class;
  const cls = pClass === 'A' ? '⭐ Class A' : pClass === 'B' ? '🔷 Class B' : '🔹 Class C';
  const slPct = Math.round(Math.abs(sig.entry - sig.sl) / sig.entry * 1000) / 10;
  const msg = [
    `🎯 <b>ATLAS SWING // ENTRY TOUCHED</b>`,
    `${cls} ${dir} ${sig.symbol} — now ACTIVE`,
    ``,
    `Touched @ <b>${touchPrice}</b>`,
    `Entry: ${sig.entry}`,
    `SL: ${sig.sl} (${slPct}%)`,
    sig.tp1 ? `TP1: ${sig.tp1} (partial)` : '',
    sig.tp2 ? `TP2: ${sig.tp2} (main)` : '',
    sig.tp3 ? `TP3: ${sig.tp3} (runner)` : '',
    ``,
    `Manage from here — close 40% at TP1, breakeven SL.`
  ].filter(Boolean).join('\n');
  return sendSwingMessage(msg);
}

// Test message
async function sendTest() {
  return sendMessage('✅ <b>ATLAS // WATCHLIST</b>\nTelegram connected successfully.');
}

module.exports = { sendMessage, sendSignalAlert, sendRecAlert, sendMorningBrief, sendHealthAlert, sendEventFiredAlert, sendSwingMessage, sendSwingSignalAlert, sendAbcSignalAlert, sendEntryTouchAlert, sendAbcEntryTouchAlert, sendTest, escHtml };
