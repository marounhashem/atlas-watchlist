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
 * Server handles 12h TTL via a 15-min cleanup cron — do NOT set avoid_until/expires_at.
 *
 * Data authored: 2026-04-16 (Iran deal optimism surging — Trump says "very close
 * to over", new talks in Islamabad imminent, ceasefire expires Apr 21. S&P 500
 * closed above 7,000 for first time, Nasdaq 11-day record win streak. Oil
 * softened on peace hopes — WTI $90.72, Brent $94.89. CPI still hot 3.3% YoY,
 * Fed holds 3.50-3.75%, dot plot signals 1 cut in 2026. DXY ~98 still weak.
 * Gold $4,822 stable, silver pulled back to $77, BTC $74,287.)
 */

const ATLAS_URL = process.env.ATLAS_URL || 'http://localhost:3001';
const ENDPOINT = `${ATLAS_URL}/api/macro-inject`;

// Shared risk set — Iran deal uncertainty + Fed repricing + CPI stickiness dominate every symbol
const CORE_RISKS = [
  'Iran deal collapses before Apr 21 ceasefire expiry — oil spikes, risk-off',
  'Fed June FOMC pivots hawkish on sticky 3.3% CPI print',
  'Iran deal confirmed — oil flushes to $75, haven bid evaporates'
];

const SYMBOLS = [
  // ── PRECIOUS METALS ────────────────────────────────────────────────────────
  {
    symbol: 'GOLD',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Gold $4,822, steady near highs on hot CPI + DXY weakness at 98. Iran deal optimism trims haven bid slightly vs yesterday; ceasefire expiry Apr 21 adds uncertainty.',
    key_risks: ['Iran deal confirmed → haven bid evaporates fast', 'DXY reclaims 100 on Fed hawk surprise', 'Rapid CPI cooldown in next print'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'SILVER',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Silver ~$77, pulled back from $79.35 on profit-taking after parabolic run. Still bid on gold tailwind + industrial demand; decade-high levels intact.',
    key_risks: ['Continued profit-taking after vertical run', 'Industrial demand rollover on recession fears', 'Gold reversal on Iran deal'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'COPPER',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'Copper ~$6.1/lb, climbing toward 2-month highs on electrification demand + risk-on. CSI 300 rebound eases China-drag concern; LME inventory still elevated.',
    key_risks: ['LME inventory build accelerates', 'China rebound fades quickly', 'Rally exhaustion after parabolic move'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'PLATINUM',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Platinum ~$2,100, holding gains on auto-catalyst demand + precious metals rotation. Still strongest in years with +117% YoY gain intact.',
    key_risks: ['Auto demand softening on recession fears', 'Metals rotation unwinds', 'Profit-taking after parabolic YoY gain'],
    supports_long: true,
    supports_short: false
  },

  // ── ENERGY ─────────────────────────────────────────────────────────────────
  {
    symbol: 'OILWTI',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'WTI $90.72, Brent $94.89 — softened from $92+ as Iran deal optimism grows. Trump says war "very close to over"; ceasefire expires Apr 21. Two-way risk elevated.',
    key_risks: ['Deal confirmed → $75 flush', 'Deal collapses before Apr 21 → spike above $100', 'OPEC+ surprise production hike'],
    supports_long: false,
    supports_short: false
  },

  // ── US INDICES ─────────────────────────────────────────────────────────────
  {
    symbol: 'US500',
    sentiment: 'BULLISH',
    strength: 8,
    summary: 'S&P 500 closed above 7,000 for first time (+0.8%). Record territory on Iran deal optimism + tech leadership + weak DXY. Overbought but momentum strong.',
    key_risks: ['Extreme extension triggers pullback', 'Iran deal falls apart before Apr 21', 'Q1 earnings disappointments'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'US30',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'Dow ~48,500, flat to slightly down while Nasdaq surges. Lagging on lower tech weight; energy names may lose tailwind if Iran deal lowers oil.',
    key_risks: ['Oil flush hurts energy components', 'Industrials Q1 earnings miss', ...CORE_RISKS.slice(1, 2)],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'US100',
    sentiment: 'BULLISH',
    strength: 8,
    summary: 'Nasdaq Composite +1.59% to record high, 11-day win streak — strongest on record. Tech/AI leadership + weak DXY + Iran deal optimism. Extremely extended.',
    key_risks: ['Record streak exhaustion imminent', 'Rate-path shock hits long-duration tech', 'Iran deal collapse triggers risk-off'],
    supports_long: true,
    supports_short: false
  },

  // ── EUROPE INDICES ─────────────────────────────────────────────────────────
  {
    symbol: 'UK100',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'FTSE ~10,604, modest gains. Oil-heavy composition faces headwind if Iran deal materializes; defensive qualities provide floor. Mixed cross-currents.',
    key_risks: ['Iran deal confirmed → BP/Shell sell-off', 'BoE stuck on UK inflation stickiness', 'Miners drag on China uncertainty'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'DE40',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'DAX ~24,073 (+0.12%), benefiting from Iran deal optimism reducing energy-import drag. Germany positioned to gain most in Europe from lower oil prices.',
    key_risks: ['Iran deal collapses → energy shock deepens', 'ECB delays cuts on inflation stickiness', 'Autos/industrials miss Q1'],
    supports_long: true,
    supports_short: false
  },

  // ── ASIA INDICES ───────────────────────────────────────────────────────────
  {
    symbol: 'J225',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Nikkei 58,134 (+0.44%), rising on US-Iran deal hopes lifting global sentiment. Weak yen tailwind for exporters + risk-on regional tone intact.',
    key_risks: ['Yen strength squeeze on BoJ pivot', 'Iran deal collapse triggers risk-off globally', 'Global tech pullback'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'HK50',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'Hang Seng gaining ~0.4% on regional risk-on. Riding US-Iran deal optimism but without strong independent catalyst; mainland rebound helps.',
    key_risks: ['China property/deflation relapse', 'CSI 300 rebound fades', 'Tech sector pullback'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'CN50',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'CSI 300 rebounded +1.55% to 4,791 after lagging — biggest single-day move in weeks. Deflation/property overhang persists but short-term momentum improved.',
    key_risks: ['Rebound fades into resistance', 'No follow-through from Beijing stimulus', 'Global risk-off on Iran deal collapse'],
    supports_long: false,
    supports_short: false
  },

  // ── CRYPTO ─────────────────────────────────────────────────────────────────
  {
    symbol: 'BTCUSD',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'BTC $74,287, pushing above $74k on weak DXY + risk-on momentum + ETF demand. Iran deal optimism boosts broader risk appetite; $75k resistance key.',
    key_risks: ['$75k breakout fails into heavy supply', 'Iran deal collapse triggers de-risking', 'Spot ETF outflow surprise'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'ETHUSD',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'ETH $2,325 riding BTC beta on risk-on + weak DXY + inflation hedge narrative. Up 20.2% since Iran war began; participating in crypto rally.',
    key_risks: ['Beta unwind if BTC stalls at $75k', 'ETH/BTC ratio rollover', 'Risk-off from Iran deal collapse'],
    supports_long: true,
    supports_short: false
  },

  // ── USD MAJORS ─────────────────────────────────────────────────────────────
  {
    symbol: 'EURUSD',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'EUR/USD 1.1808, near 2026 highs on persistent DXY weakness. Iran deal optimism reduces EUR energy-drag headwind; upgrades bias from neutral.',
    key_risks: ['Fed hawk surprise reverses DXY slide', 'Iran deal collapses → EUR energy drag returns', 'ECB cuts earlier than expected'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'GBPUSD',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'Cable 1.3570, holding near highs on DXY weakness + Iran deal optimism easing energy drag. Modest long bias while DXY stays below 99.',
    key_risks: ['UK CPI surprise shifts BoE calculus', 'DXY reclaims 100', 'Iran deal collapses'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'USDJPY',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'USDJPY 158.84-159.00, JPY still weak YTD on yield gravity despite DXY weakness. Iran deal optimism removes some haven bid; two-way risk persists.',
    key_risks: ['BoJ hawkish pivot on imported inflation', 'Fed hawk repricing', 'Iran deal collapse restores haven bid'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'USDCAD',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'USDCAD 1.3730, DXY weakness supports short but oil softening on Iran deal hopes reduces CAD tailwind. Conviction trimmed vs yesterday.',
    key_risks: ['Iran deal confirmed → oil flush hurts CAD', 'BoC dovish surprise', 'DXY reversal above 100'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'USDCHF',
    sentiment: 'BEARISH',
    strength: 5,
    summary: 'USDCHF ~0.7810, CHF still bid on haven + DXY weakness. Iran deal optimism slightly erodes CHF haven bid; conviction trimmed.',
    key_risks: ['SNB intervention on excessive CHF strength', 'Fed hawk pivot', 'Iran deal confirmed removes haven bid'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'AUDUSD',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'AUDUSD 0.7141, tailwind from copper near 2-month highs + risk-on + weak DXY. CSI 300 rebound eases China-drag concern; upgrades conviction.',
    key_risks: ['China rebound fades', 'Copper reversal on LME inventory', 'DXY reclaims 100'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'NZDUSD',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'NZDUSD 0.5904 holding gains. RBNZ hawkish stance + risk-on + weak DXY provide triple tailwind. Conviction steady.',
    key_risks: ['RBNZ walks back hawkish signal', 'Risk-off from Iran deal collapse', 'Dairy auction miss'],
    supports_long: true,
    supports_short: false
  },

  // ── CROSSES ────────────────────────────────────────────────────────────────
  {
    symbol: 'EURGBP',
    sentiment: 'NEUTRAL',
    strength: 3,
    summary: 'Both EUR and GBP benefit from Iran deal optimism easing energy drag equally. No clean directional macro edge — pure technicals pair.',
    key_risks: ['ECB/BoE divergence', 'UK CPI asymmetry vs EU', 'Iran deal collapse re-intensifies energy shock'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'EURAUD',
    sentiment: 'BEARISH',
    strength: 5,
    summary: 'AUD benefits from copper + risk-on + CSI rebound; EUR energy drag easing but still present. Short bias holds but conviction trimmed on EUR improvement.',
    key_risks: ['CSI 300 rebound fades hitting AUD', 'ECB hawkish surprise', 'Metals reversal on inventory build'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'EURJPY',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'EUR improving on Iran deal hopes, JPY losing haven bid on same news. Cross direction still conflicted; no clean macro edge.',
    key_risks: ['BoJ hawkish pivot', 'Iran deal collapse restores JPY haven bid', 'ECB hawk surprise'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'EURCHF',
    sentiment: 'BEARISH',
    strength: 5,
    summary: 'EUR improving on Iran deal hopes but CHF still bid on residual haven demand + YTD strength. Conviction trimmed from 6 to 5 as EUR energy drag eases.',
    key_risks: ['SNB intervention', 'Iran deal fully confirmed removes CHF haven bid', 'ECB hawk pivot'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'GBPCHF',
    sentiment: 'BEARISH',
    strength: 4,
    summary: 'GBP gaining on Iran deal hopes but CHF still has residual haven bid. Weakest conviction in CHF-cross shorts as narratives converge.',
    key_risks: ['SNB intervention', 'BoE hawk surprise on UK CPI', 'Iran deal confirmed removes CHF haven'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'GBPJPY',
    sentiment: 'NEUTRAL',
    strength: 3,
    summary: 'GBP improving as energy drag eases on Iran deal hopes; JPY losing haven bid on same news. Still two conflicted forces — technicals-only.',
    key_risks: ['BoJ hawkish pivot', 'UK CPI asymmetry', 'Risk-on/off regime flip'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'AUDJPY',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'Classic risk-on proxy strengthened — AUD benefits from copper + CSI rebound + risk-on; JPY losing haven bid on Iran deal hopes. Upgrades conviction.',
    key_risks: ['Iran deal collapses → risk-off snap', 'BoJ hawkish surprise', 'Copper reversal on LME build'],
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
    summary: 'DXY 98.05, lingering near 6-week lows. Iran deal optimism + risk-on narrative keep USD soft despite hawkish Fed repricing. Bearish bias intact below 99.',
    key_risks: ['Fed hawk surprise at June FOMC on sticky 3.3% CPI', 'Iran deal collapse triggers safe-haven USD bid', 'Euro area data shock'],
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
