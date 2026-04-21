// server/stockScanner/notifier.js
//
// Optional push notifications sent after each successful scan.
// Two channels, both independently toggleable by env vars:
//
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//        -> sends formatted watchlist to a Telegram chat/channel
//
//   SMTP_HOST + SMTP_USER + SMTP_PASS + NOTIFY_EMAIL_TO
//        -> sends plain-text email. Uses nodemailer if installed,
//           otherwise gracefully no-ops.
//
// If neither set, the notifier silently does nothing — the scanner's
// main output is the dashboard; notifications are a convenience.

/**
 * Notify all configured channels. Never throws — logs failures.
 */
async function notify(scanResult, log = console.log) {
  const tasks = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    tasks.push(sendTelegram(scanResult, log));
  }
  if (process.env.SMTP_HOST && process.env.NOTIFY_EMAIL_TO) {
    tasks.push(sendEmail(scanResult, log));
  }
  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') log(`[notifier] channel failed: ${r.reason}`);
  }
}

// -------------------- Telegram --------------------

async function sendTelegram(scanResult, log) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const text = formatTelegram(scanResult);

  // Telegram caps messages at 4096 chars. If we ever exceed that,
  // split; 5 picks + header comfortably fits so not an issue in practice.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`telegram ${res.status}: ${body}`);
  }
  log('[notifier] telegram sent');
}

function formatTelegram(r) {
  const when = new Date(r.startedAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Dubai', hour12: false,
  });

  const header =
    `*ATLAS // STOCKS — pre-market*\n` +
    `_${when} UAE · v${r.version}_\n` +
    `universe ${r.stats.universeSize} · accepted ${r.stats.accepted}\n`;

  if (!r.watchlist?.length) {
    return header + '\n_No candidates cleared the gates today._';
  }

  const lines = r.watchlist.map((p, i) => {
    const dir = p.levels.direction === 'LONG' ? '🟢' : '🔴';
    const gap = (p.gapPct >= 0 ? '+' : '') + p.gapPct.toFixed(1);
    const cat = p.topCatalyst ? ` · ${p.topCatalyst.replace(/_/g, ' ')}` : '';
    const pri = p.levels.primary;
    return (
      `\n*${i + 1}. ${dir} ${p.symbol}* — score ${p.score}\n` +
      `   gap ${gap}% · rvol ${p.rvol.toFixed(1)}x · atr ${p.atrPct.toFixed(1)}%${cat}\n` +
      `   ${pri.name}: entry \`$${pri.entry}\` · stop \`$${pri.stop}\` · t1 \`$${pri.target1}\``
    );
  });

  return header + lines.join('');
}

// -------------------- Email --------------------

async function sendEmail(scanResult, log) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    log('[notifier] nodemailer not installed — skipping email');
    return;
  }

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    } : undefined,
  });

  const { subject, text } = formatEmail(scanResult);
  await transport.sendMail({
    from: process.env.NOTIFY_EMAIL_FROM || process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL_TO,
    subject,
    text,
  });
  log('[notifier] email sent');
}

function formatEmail(r) {
  const when = new Date(r.startedAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Dubai', hour12: false,
  });

  if (!r.watchlist?.length) {
    return {
      subject: `ATLAS stocks — no picks today (${when})`,
      text: `No candidates cleared the gates.\nUniverse: ${r.stats.universeSize}\n`,
    };
  }

  const top = r.watchlist[0];
  const subject = `ATLAS stocks — ${r.watchlist.length} picks, top: ${top.symbol} (score ${top.score})`;

  const body = r.watchlist.map((p, i) => {
    const pri = p.levels.primary;
    const alt = p.levels.alternative;
    return [
      `${i + 1}. ${p.symbol}  ${p.levels.direction}  score=${p.score}`,
      `   ${p.name}`,
      `   gap ${p.gapPct >= 0 ? '+' : ''}${p.gapPct}%   rvol ${p.rvol}x   atr ${p.atrPct}%`,
      `   catalyst: ${p.topCatalyst || 'none'}  sentiment ${p.sentiment}`,
      `   PRIMARY  (${pri.name})  entry ${pri.entry}  stop ${pri.stop}  t1 ${pri.target1}  t2 ${pri.target2}`,
      `   ALT      (${alt.name})  entry ${alt.entry}  stop ${alt.stop}  target ${alt.target}`,
      '',
    ].join('\n');
  }).join('\n');

  return {
    subject,
    text:
      `ATLAS // STOCKS pre-market watchlist\n` +
      `${when} UAE · v${r.version}\n` +
      `universe ${r.stats.universeSize}  fetched ${r.stats.fetched}  accepted ${r.stats.accepted}\n\n` +
      body,
  };
}

module.exports = { notify };
