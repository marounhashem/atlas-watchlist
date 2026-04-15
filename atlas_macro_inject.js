#!/usr/bin/env node
/**
 * atlas_macro_inject.js — pre-analyzed macro context injector
 *
 * Pushes fresh per-symbol macro context into the ATLAS server's `macro_context`
 * table via POST /api/macro-inject. Bypasses Anthropic entirely — all sentiment,
 * strength, and summary text is authored by hand (or pasted from web research)
 * below. Run whenever the macro backdrop shifts.
 *
 *   node atlas_macro_inject.js
 *   ATLAS_URL=https://atlas-watchlist-xxx.railway.app node atlas_macro_inject.js
 *
 * Field contract matches db.upsertMacroContext() in server/db.js:
 *   sentiment       'BULLISH' | 'BEARISH' | 'NEUTRAL'
 *   strength        1-10  (conviction, not magnitude of move)
 *   summary         one sentence — surfaces on cards + morning brief
 *   key_risks       array of strings — what would flip the thesis
 *   supports_long   true when macro gives LONG signals a multiplier tailwind
 *   supports_short  true when macro gives SHORT signals a multiplier tailwind
 *   avoid_until     optional ISO string — scorer will avoid fresh entries until then
 *
 * Data authored: 2026-04-15 (Iran de-escalation tone, Hormuz still 10%,
 * Fed on hold, hot CPI driven by energy only, DXY 98, gold off ATH, risk-on rally).
 */

const ATLAS_URL = process.env.ATLAS_URL || 'http://localhost:3001';
const ENDPOINT = `${ATLAS_URL}/api/macro-inject`;

// Shared risk set — Hormuz break + Fed path + CPI print cadence dominate every symbol
const CORE_RISKS = [
  'Iran-US talks collapse, Hormuz flows stay at 10%',
  'Fed April 28-29 surprises hawkish on sticky core CPI',
  'Oil spikes back above $100 on Hormuz re-escalation'
];

const SYMBOLS = [
  // ── PRECIOUS METALS ────────────────────────────────────────────────────────
  {
    symbol: 'GOLD',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Gold $4,781, ~15% below Jan $5,595 ATH. DXY 7-day losing streak + Fed cut repricing rebuilds bid; institutional targets $5,400-$6,300 for year-end.',
    key_risks: ['Hard Iran ceasefire kills haven bid', 'DXY reclaims 100 on Fed hawk surprise', ...CORE_RISKS.slice(0, 1)],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'SILVER',
    sentiment: 'BULLISH',
    strength: 8,
    summary: 'Silver ~$74-77, +150% YoY, metals frenzy driven by industrial/data-center demand on top of gold tailwind. Highest decade-plus levels.',
    key_risks: ['Industrial demand rollover on recession fears', 'Unsustainable rally narrative triggers profit-taking'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'COPPER',
    sentiment: 'BULLISH',
    strength: 8,
    summary: 'Copper $5.81/lb (near $6.30 peak, +37% YoY). Supply squeeze + electrification/data-center demand. Rally flagged as "unsustainable" but no reversal signal yet.',
    key_risks: ['China CSI 300 weakness spreads to industrial metals', 'Unsustainable rally reversal'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'PLATINUM',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Platinum $2,108 — strongest in years on auto-catalyst demand + precious metals rotation. Retail + institutional see it as the 2026 breakout metal.',
    key_risks: ['Auto demand softening', 'Metals rotation unwinds'],
    supports_long: true,
    supports_short: false
  },

  // ── ENERGY ─────────────────────────────────────────────────────────────────
  {
    symbol: 'OILWTI',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'WTI $90.81, off Feb/Mar spike peaks but Hormuz still at 10% (~2.1mbpd). De-escalation pulls price down, supply-break keeps a floor. Two-way risk.',
    key_risks: ['Hormuz reopens fully → $75 flush', 'Talks collapse → $110+ re-spike', 'OPEC+ announcement'],
    supports_long: false,
    supports_short: false
  },

  // ── US INDICES ─────────────────────────────────────────────────────────────
  {
    symbol: 'US500',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'S&P 500 at 6,967 (+1.18%), erased Iran war losses, now positive YTD and within sight of late-Jan ATH. Tech leading; weaker dollar + Fed cut repricing + peace-talk optimism.',
    key_risks: ['Ceasefire breaks (happened once already)', 'Sticky core CPI forces Fed hawk pivot', 'Earnings disappointment in Q1 reports'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'US30',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'Dow 48,535 (+0.66%), lagging Nasdaq on less tech exposure but participating in the relief rally. Industrial/energy components benefit from stable oil.',
    key_risks: ['Rotation away from defensives', 'Earnings miss in industrials', ...CORE_RISKS.slice(2, 3)],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'US100',
    sentiment: 'BULLISH',
    strength: 8,
    summary: 'Nasdaq 100 on 10-day win streak (longest since 2021), +1.96% to 23,639. Tech/software leadership, weak dollar tailwind, AI-capex narrative intact.',
    key_risks: ['10-day streak exhaustion', 'Rate-path surprise hits long-duration tech', 'AI capex pause signal'],
    supports_long: true,
    supports_short: false
  },

  // ── EUROPE INDICES ─────────────────────────────────────────────────────────
  {
    symbol: 'UK100',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'FTSE bid on defensives + BP/Shell benefit from elevated crude. Stoxx 600 +1% on de-escalation hopes but energy-importer drag caps upside.',
    key_risks: ['Oil crash unwinds energy-heavy FTSE bid', 'BoE stuck on sticky UK inflation'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'DE40',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'DAX ~24,037, volatile. Germany is energy-import victim of the Iran shock; ECB stuck between inflation stickiness and growth drag. Recovery hopes fight the shock.',
    key_risks: ['Energy shock extends if Hormuz stays broken', 'ECB delays cuts on inflation stickiness', 'Autos/industrials miss Q1'],
    supports_long: false,
    supports_short: false
  },

  // ── ASIA INDICES ───────────────────────────────────────────────────────────
  {
    symbol: 'J225',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Nikkei 58,134 (+0.44%), nearing ATH. Weak yen backdrop + Japanese exporter tailwind + risk-on regional tone. Flagged as 2026 outperformer.',
    key_risks: ['Yen strength squeeze on BoJ pivot', 'Ceasefire break hits risk-on globally'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'HK50',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Hang Seng 26,190 (+1.2%), highest since March. Riding the regional relief rally + weak dollar + China stimulus hopes.',
    key_risks: ['China property/deflation relapse', 'Mainland CSI 300 weakness spreads', 'Geopolitics re-escalates'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'CN50',
    sentiment: 'BEARISH',
    strength: 5,
    summary: 'CSI 300 -0.34% at 4,685, bucking Asian regional gains. Mainland China lagging on deflation/property overhang despite global risk-on.',
    key_risks: ['Stimulus surprise', 'Beijing props up A-shares directly', 'Hong Kong strength spills over'],
    supports_long: false,
    supports_short: true
  },

  // ── CRYPTO ─────────────────────────────────────────────────────────────────
  {
    symbol: 'BTCUSD',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'BTC ~$74k, +8.1% weekly, two-month high on Iran de-escalation + weak dollar. Rebounding from Feb 5 flush to $60k; $75k breakout level in play.',
    key_risks: ['$75k breakout fails into heavy supply', 'Ceasefire break triggers risk-off', 'Spot ETF outflow surprise'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'ETHUSD',
    sentiment: 'BULLISH',
    strength: 8,
    summary: 'ETH ~$2,375, +12.4% weekly, outperforming BTC on relief rally. Two-month high, beta-to-BTC playing out strongly on risk-on flip.',
    key_risks: ['Beta unwind if BTC stalls', 'ETH/BTC ratio rollover', 'Risk-off from Iran break'],
    supports_long: true,
    supports_short: false
  },

  // ── USD MAJORS ─────────────────────────────────────────────────────────────
  {
    symbol: 'EURUSD',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'EUR hit hardest by Iran energy shock (Europe imports oil), but DXY 98 and 7-day losing streak pulls pair higher. Net conflicted — two-way price action.',
    key_risks: ['Fed hawkish surprise reverses DXY slide', 'Energy shock re-intensifies on Hormuz break', 'ECB signals earlier cuts'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'GBPUSD',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'GBP capped by BoE stickiness + energy import drag; DXY weakness provides partial tailwind. Bearish technical bias into key support but no clean macro edge.',
    key_risks: ['UK CPI surprise', 'DXY reclaims 100', 'BoE cut timing shift'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'USDJPY',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'DXY 98 7-day downtrend + JPY haven bid into Iran uncertainty pressures USDJPY lower. Yen outperforming as safe-haven flows return on any risk-off flicker.',
    key_risks: ['BoJ dovish surprise', 'Fed hawk pivot', 'Clean Iran ceasefire removes haven bid'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'USDCAD',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'Oil $90+ supports CAD; DXY weakness compounds. Double headwind for pair — short bias preferred while Brent holds $90+ and DXY below 99.',
    key_risks: ['Oil flush below $80 on ceasefire', 'BoC dovish surprise', 'DXY reversal'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'USDCHF',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'CHF bid as Europe-proximate haven into Iran tail risk + DXY 7-day downtrend. SNB tolerant of CHF strength given imported inflation fears.',
    key_risks: ['SNB intervention on excessive CHF strength', 'Fed hawk pivot', 'Ceasefire removes haven bid'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'AUDUSD',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'AUD tailwind from copper $5.81 + risk-on rally + weak DXY. Offset by China CSI 300 weakness. Modest long bias while metals complex bids.',
    key_risks: ['China demand rollover', 'Copper reversal', 'DXY reclaims 100'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'NZDUSD',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'NZD riding risk-on + weak DXY but without the metals kicker AUD gets. Dairy pricing neutral. Modest long lean, secondary to AUD.',
    key_risks: ['RBNZ dovish surprise', 'Risk-off from Iran break', 'Dairy auction miss'],
    supports_long: true,
    supports_short: false
  },

  // ── CROSSES ────────────────────────────────────────────────────────────────
  {
    symbol: 'EURGBP',
    sentiment: 'NEUTRAL',
    strength: 3,
    summary: 'Both EUR and GBP hit by energy import drag; no clean directional macro edge. Pure technicals pair — let price structure lead.',
    key_risks: ['ECB/BoE divergence', 'UK CPI asymmetry', 'Energy shock re-intensifies'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'EURAUD',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'AUD benefits from copper/metals rally + risk-on; EUR dragged by energy shock. Clean short bias while this divergence holds.',
    key_risks: ['China CSI weakness spreads to copper', 'ECB hawkish surprise', 'Metals reversal'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'EURJPY',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'EUR hit by energy import, JPY bid as haven — double headwind for the cross. Short bias until Iran tail clears.',
    key_risks: ['Clean ceasefire removes haven bid', 'BoJ dovish surprise', 'ECB hawk surprise'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'EURCHF',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'EUR weak on energy shock; CHF bid as Europe-proximate haven. SNB tolerating strength. Short bias respects SNB intervention risk.',
    key_risks: ['SNB intervention', 'Ceasefire removes haven bid', 'ECB hawk pivot'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'GBPCHF',
    sentiment: 'BEARISH',
    strength: 5,
    summary: 'GBP energy-import drag + CHF haven bid. Weaker conviction than EURCHF but same directional story.',
    key_risks: ['SNB intervention', 'BoE hawk surprise on UK CPI', 'Ceasefire removes haven bid'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'GBPJPY',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'Both GBP and JPY carry bearish tilts against USD — GBP from energy drag, JPY haven bid cuts both ways against GBP. No clean macro edge.',
    key_risks: ['BoJ dovish surprise', 'UK CPI asymmetry', 'Risk-on/off regime flip'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'AUDJPY',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'Classic risk-on/off proxy pair — AUD benefits from metals + risk-on, JPY from haven bid. Conflicted, slight long lean while risk-on holds.',
    key_risks: ['Iran ceasefire break → risk-off', 'BoJ hawk surprise', 'Copper reversal'],
    supports_long: true,
    supports_short: false
  },

  // ── DXY reference ──────────────────────────────────────────────────────────
  // Not traded directly (lives in dxy_reference table, not signals), but
  // scorer reads macroContext['DXY'] as a correlation check for USD pairs.
  {
    symbol: 'DXY',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'DXY 98.08, 7 straight down days, lowest since pre-Iran conflict. De-escalation pricing + Fed cut repricing + weak risk-haven demand. Key 98 support in play.',
    key_risks: ['Fed hawk surprise at Apr 28-29', 'Ceasefire break triggers safe-haven USD bid', 'US CPI re-accelerates beyond energy'],
    supports_long: false,
    supports_short: true
  }
];

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[macro-inject] Target: ${ENDPOINT}`);
  console.log(`[macro-inject] Symbols: ${SYMBOLS.length}`);
  const started = Date.now();
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: SYMBOLS })
    });
  } catch (e) {
    console.error(`[macro-inject] Network error: ${e.message}`);
    console.error(`[macro-inject] Is the server running at ${ATLAS_URL}?`);
    process.exit(1);
  }
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  const ms = Date.now() - started;
  if (!response.ok || !data.ok) {
    console.error(`[macro-inject] HTTP ${response.status} after ${ms}ms`);
    console.error(data);
    process.exit(1);
  }
  console.log(`[macro-inject] OK — ${data.count} symbols written in ${ms}ms`);
  if (data.skipped?.length) console.warn(`[macro-inject] Skipped: ${JSON.stringify(data.skipped)}`);
  console.log(`[macro-inject] Written: ${data.written.join(', ')}`);
}

main();
