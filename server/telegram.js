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
  const verdict = signal.verdict === 'PROCEED' ? '✅ PROCEED' : '👀 WATCH';
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

// Test message
async function sendTest() {
  return sendMessage('✅ <b>ATLAS // WATCHLIST</b>\nTelegram connected successfully.');
}

module.exports = { sendMessage, sendSignalAlert, sendRecAlert, sendMorningBrief, sendHealthAlert, sendTest };
