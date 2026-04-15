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
 *
 * Server handles 12h TTL via */15 cleanup cron — do NOT set avoid_until/expires_at.
 *
 * Data authored: 2026-04-15 (Iran peace talks FAILED over weekend, US naval
 * blockade of Iranian ports active Apr 9-10, ~230 tankers waiting in Persian
 * Gulf, CPI HOT at 3.3% YoY on gasoline +21.2%, Fed cut repricing 2→1 for 2026,
 * DXY 98 still weak on 7-day losing streak, metals rally accelerating,
 * Nasdaq 100 pushing 25,842 on 10-day win streak.)
 */

const ATLAS_URL = process.env.ATLAS_URL || 'http://localhost:3001';
const ENDPOINT = `${ATLAS_URL}/api/macro-inject`;

// Shared risk set — Iran blockade + Fed repricing + CPI stickiness dominate every symbol
const CORE_RISKS = [
  'Surprise Iran ceasefire breakthrough collapses oil premium',
  'Fed June FOMC pivots hawkish on hot 3.3% CPI print',
  'Oil spikes above $110 on Hormuz tanker incident'
];

const SYMBOLS = [
  // ── PRECIOUS METALS ────────────────────────────────────────────────────────
  {
    symbol: 'GOLD',
    sentiment: 'BULLISH',
    strength: 8,
    summary: 'Gold $4,820, bid on hot 3.3% CPI + Iran blockade + DXY 7-day downtrend + Fed cut repricing. Holding above $4,800 support; institutional targets $5,400-$6,300 year-end.',
    key_risks: ['Surprise Iran ceasefire kills haven bid', 'DXY reclaims 100 on Fed hawk surprise', 'Rapid CPI cooldown'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'SILVER',
    sentiment: 'BULLISH',
    strength: 8,
    summary: 'Silver $79.35, surged 5%+ prior session on gold tailwind + industrial demand + Iran shock. Highest levels in over a decade, metals frenzy intact.',
    key_risks: ['Profit-taking after parabolic run', 'Industrial demand rollover on recession fears', 'Gold reversal'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'COPPER',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'Copper $6.08/lb (+0.87% 24h), still bid on electrification/data-center demand but LME inventories at 8-year highs signal demand softening. Conviction trimmed.',
    key_risks: ['LME inventory build accelerates', 'China CSI 300 weakness spreads', 'Rally exhaustion after parabolic move'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'PLATINUM',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Platinum $2,108 (+0.34%, +117.91% YoY). Auto-catalyst demand + precious metals rotation continue driving price; still strongest in years.',
    key_risks: ['Auto demand softening on recession fears', 'Metals rotation unwinds', 'Profit-taking after parabolic YoY gain'],
    supports_long: true,
    supports_short: false
  },

  // ── ENERGY ─────────────────────────────────────────────────────────────────
  {
    symbol: 'OILWTI',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'WTI $92, up from weekend as US-Iran peace talks failed and US naval blockade of Iranian ports active since Apr 9-10. ~230 tankers waiting in Persian Gulf; Brent $96.80.',
    key_risks: ['Sudden peace breakthrough → $75 flush', 'OPEC+ surprise production hike', 'US recession fear cuts demand'],
    supports_long: true,
    supports_short: false
  },

  // ── US INDICES ─────────────────────────────────────────────────────────────
  {
    symbol: 'US500',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'S&P 500 6,976 (+0.12%), approaching Jan 28 ATH of 7,002. Tech leadership + weak DXY + rate-cut repricing offset hot CPI concerns. Near-term overbought.',
    key_risks: ['Hot CPI forces Fed hawk pivot at June FOMC', 'Iran blockade tightens further', 'Earnings disappointment in Q1 reports'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'US30',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'Dow 48,536 (+0.66%), led by Amazon/Nvidia/Nike. Lagging Nasdaq on less tech exposure but participating in rally. Energy components benefit from higher oil.',
    key_risks: ['Rotation away from cyclicals', 'Industrials Q1 earnings miss', ...CORE_RISKS.slice(1, 2)],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'US100',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Nasdaq 100 25,842 on 10-day win streak (longest since 2021). Tech/software leadership + weak dollar tailwind + AI-capex narrative intact, but extended.',
    key_risks: ['10-day streak exhaustion', 'Rate-path shock hits long-duration tech', 'Hot CPI → Fed hawk pivot'],
    supports_long: true,
    supports_short: false
  },

  // ── EUROPE INDICES ─────────────────────────────────────────────────────────
  {
    symbol: 'UK100',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'FTSE 10,628 (+0.25%), bid on elevated oil supporting BP/Shell + defensive rotation. Energy-heavy composition is a direct Iran-shock tailwind.',
    key_risks: ['Oil flush on ceasefire unwinds BP/Shell bid', 'BoE stuck on UK inflation stickiness', 'Miners drag on China weakness'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'DE40',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'DAX 24,044 (+0.12%), modest gains but Germany is energy-import victim of Iran shock. ECB stuck between inflation stickiness and growth drag.',
    key_risks: ['Energy shock deepens on further Hormuz disruption', 'ECB delays cuts on inflation stickiness', 'Autos/industrials miss Q1'],
    supports_long: false,
    supports_short: false
  },

  // ── ASIA INDICES ───────────────────────────────────────────────────────────
  {
    symbol: 'J225',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Nikkei ~58,000 near ATH. Weak yen (down 11.29% YTD) tailwind for exporters + risk-on regional tone. Flagged as 2026 outperformer.',
    key_risks: ['Yen strength squeeze on BoJ pivot', 'Iran shock triggers risk-off globally', 'Global tech pullback'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'HK50',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'Hang Seng 25,708 (-0.71%), pulled back from recent highs despite earlier Iran-ceasefire bid. Riding regional sentiment but without strong directional conviction.',
    key_risks: ['China property/deflation relapse', 'Mainland CSI 300 weakness spreads', 'Tech sector pullback'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'CN50',
    sentiment: 'BEARISH',
    strength: 5,
    summary: 'CSI 300 lagging regional gains on deflation/property overhang. Mainland China underperforming despite global risk-on; LME copper inventory build flags China demand softness.',
    key_risks: ['Beijing stimulus surprise', 'PBoC easing pivot', 'Commodity demand rebound'],
    supports_long: false,
    supports_short: true
  },

  // ── CRYPTO ─────────────────────────────────────────────────────────────────
  {
    symbol: 'BTCUSD',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'BTC $73,725 (+5.05% 24h), rebounding hard on weak DXY + tech risk-on + inflation hedge narrative. $75k breakout resistance in play; two-month high.',
    key_risks: ['$75k breakout fails into heavy supply', 'Iran shock triggers risk-off de-risking', 'Spot ETF outflow surprise'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'ETHUSD',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'ETH riding BTC beta on the risk-on flip + weak DXY + inflation hedge narrative. Outperforming during up-legs; participating in crypto rally.',
    key_risks: ['Beta unwind if BTC stalls at $75k', 'ETH/BTC ratio rollover', 'Risk-off from Iran escalation'],
    supports_long: true,
    supports_short: false
  },

  // ── USD MAJORS ─────────────────────────────────────────────────────────────
  {
    symbol: 'EURUSD',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'EUR/USD 1.1795 (+0.30%), +4.54% YTD on DXY weakness. Europe is energy-import victim of Iran shock — net conflicted, two-way price action likely.',
    key_risks: ['Fed hawk surprise reverses DXY slide', 'Iran blockade deepens EUR energy drag', 'ECB earlier-cut signal'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'GBPUSD',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'Cable 1.3588 near session highs. GBP capped by BoE stickiness + energy import drag; DXY weakness provides partial tailwind. No clean macro edge.',
    key_risks: ['UK CPI surprise', 'DXY reclaims 100', 'BoE cut timing shift'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'USDJPY',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'USDJPY 159.28, JPY weak 11.29% YTD despite DXY 7-day downtrend. Haven bid into Iran risk fights yield-differential gravity; two-way risk.',
    key_risks: ['BoJ hawkish pivot on imported inflation', 'Fed hawk repricing', 'Clean Iran ceasefire removes haven bid'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'USDCAD',
    sentiment: 'BEARISH',
    strength: 7,
    summary: 'USDCAD 1.3765, double headwind from WTI $92 supporting CAD + DXY 7-day downtrend. Short bias clean while Brent holds $96+.',
    key_risks: ['Oil flush below $80 on ceasefire', 'BoC dovish surprise', 'DXY reversal above 100'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'USDCHF',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'USDCHF 0.7810 (-0.43%), CHF +5.26% YTD on haven bid + DXY downtrend. SNB tolerant of strength given imported inflation concerns.',
    key_risks: ['SNB intervention on excessive CHF strength', 'Fed hawk pivot', 'Ceasefire removes haven bid'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'AUDUSD',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'AUDUSD 0.7143, tailwind from copper $6.08 + risk-on + weak DXY. Offset by China CSI weakness + LME copper inventory build. Modest long bias.',
    key_risks: ['China demand rollover', 'Copper reversal on LME inventory', 'DXY reclaims 100'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'NZDUSD',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'NZDUSD 0.5886 (+0.31%). RBNZ shifted hawkish — 74bps hikes priced by year-end on inflation/wage stickiness. New tailwind on top of risk-on + weak DXY.',
    key_risks: ['RBNZ walks back hawkish signal', 'Risk-off from Iran escalation', 'Dairy auction miss'],
    supports_long: true,
    supports_short: false
  },

  // ── CROSSES ────────────────────────────────────────────────────────────────
  {
    symbol: 'EURGBP',
    sentiment: 'NEUTRAL',
    strength: 3,
    summary: 'Both EUR and GBP hit by energy import drag; no clean directional macro edge. Pure technicals pair — let price structure lead.',
    key_risks: ['ECB/BoE divergence', 'UK CPI asymmetry vs EU', 'Energy shock re-intensifies'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'EURAUD',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'AUD benefits from copper $6.08 + risk-on; EUR dragged by energy shock. Clean short bias while metals-rally vs energy-drag divergence holds.',
    key_risks: ['China CSI weakness hits copper', 'ECB hawkish surprise', 'Metals reversal on inventory build'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'EURJPY',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'EUR hit by energy import drag, JPY has haven bid but weak 11.29% YTD on yield gravity. Cross direction conflicted; no clean macro edge today.',
    key_risks: ['BoJ hawkish pivot', 'Iran ceasefire removes JPY haven bid', 'ECB hawk surprise'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'EURCHF',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'EUR weak on energy shock; CHF bid as Europe-proximate haven with +5.26% YTD strength. SNB tolerating strength. Short bias respects intervention risk.',
    key_risks: ['SNB intervention', 'Ceasefire removes CHF haven bid', 'ECB hawk pivot'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'GBPCHF',
    sentiment: 'BEARISH',
    strength: 5,
    summary: 'GBP energy-import drag + CHF haven bid + YTD strength. Weaker conviction than EURCHF but same directional story.',
    key_risks: ['SNB intervention', 'BoE hawk surprise on UK CPI', 'Ceasefire removes CHF haven bid'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'GBPJPY',
    sentiment: 'NEUTRAL',
    strength: 3,
    summary: 'GBP has energy drag, JPY weak YTD despite haven bid. Two conflicted currencies — no clean macro edge, technicals-only pair today.',
    key_risks: ['BoJ hawkish pivot', 'UK CPI asymmetry', 'Risk-on/off regime flip'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'AUDJPY',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'Classic risk-on proxy — AUD benefits from copper + metals + risk-on; JPY weak YTD on yield gravity. Modest long bias while risk-on holds.',
    key_risks: ['Iran ceasefire flips narrative', 'BoJ hawkish surprise', 'Copper reversal on LME build'],
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
    summary: 'DXY 98.09, 7 straight down days, lowest since late February. Weak despite hawkish Fed repricing — weak risk-haven demand + post-conflict soft-USD narrative.',
    key_risks: ['Fed hawk surprise at June FOMC on hot 3.3% CPI', 'Iran escalation triggers safe-haven USD bid', 'Euro area data shock'],
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
