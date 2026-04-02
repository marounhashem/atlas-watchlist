// Telegram Bot Integration — raw fetch(), no external libraries
// Sends signal alerts, trade monitor recs, morning brief, health alerts

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendMessage(text, parseMode = 'HTML') {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
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
    console.error('[Telegram] Error:', e.message);
    return false;
  }
}

// Signal alert — fires when a new PROCEED signal is saved
async function sendSignalAlert(signal) {
  const dir = signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const tag = signal.eventRiskTag;
  const verdict = tag === 'SUPPRESSED' ? '🔕 WATCH/SUPPRESSED'
    : tag === 'PRE_EVENT' ? `⚠️ ${signal.verdict}/EVENT-RISK`
    : tag === 'CARRY_RISK' ? `⚠️ ${signal.verdict}/CARRY-RISK`
    : signal.verdict === 'PROCEED' ? '✅ PROCEED' : '👀 WATCH';
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
    `${(signal.reasoning || '').split(' · ').slice(0, 4).join('\n')}`,
  ].join('\n');
  return sendMessage(text);
}

// HIGH urgency recommendation alert
async function sendRecAlert(signal, rec) {
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

// Morning brief
async function sendMorningBrief(brief) {
  return sendMessage(brief, 'HTML');
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
  const beatIcon = sentiment?.beat > 0 ? '📈' : sentiment?.beat < 0 ? '📉' : '➡️';
  const vs = event.forecast ? ` | Forecast: ${event.forecast}` : '';
  const prev = event.previous ? ` | Prev: ${event.previous}` : '';
  const text = [
    `📊 <b>${event.title} — ${event.currency}</b>`,
    ``,
    `${beatIcon} Actual: <b>${event.actual || 'Released'}</b>${vs}${prev}`,
    sentiment?.summary ? `<b>${sentiment.summary}</b>` : '',
    sentiment?.magnitude ? `Surprise: ${sentiment.magnitude} (${sentiment.pctDelta || '?'}%)` : '',
    ``,
    `⏸ 5min volatility block — hold signals`,
    `✅ Opportunity window opens in 5min`,
    `Enhanced scoring active for 2 hours`,
    ``,
    `Watch: ${affectedSymbols.slice(0, 8).join(', ')}${affectedSymbols.length > 8 ? ` +${affectedSymbols.length - 8} more` : ''}`,
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
    `${(signal.reasoning || '').split(' · ').slice(0, 4).join('\n')}`,
  ].filter(Boolean).join('\n');
  return sendSwingMessage(text);
}

// Test message
async function sendTest() {
  return sendMessage('✅ <b>ATLAS // WATCHLIST</b>\nTelegram connected successfully.');
}

module.exports = { sendMessage, sendSignalAlert, sendRecAlert, sendMorningBrief, sendHealthAlert, sendEventFiredAlert, sendSwingSignalAlert, sendTest };
