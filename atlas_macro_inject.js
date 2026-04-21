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
 * Data authored: 2026-04-21 (CEASEFIRE EXPIRY DAY. Weekend escalation — seized
 * ship + vessel attacks pushed US-Iran truce to brink. Trump says VP Vance
 * leading delegation to Islamabad Monday, but Iran FM spokesperson says "no
 * plan" for second round. Nasdaq snapped 13-day win streak Mon; S&P pulled back
 * from 7,124 record; Stoxx 600 -0.9%. Oil softened in Asia — WTI $88.26, Brent
 * $94.87 — on guarded talk hopes. DXY 98.06 still pinned near 6-wk lows. Gold
 * $4,830 steady, silver $80, platinum $2,095, copper $6.07. BTC $75,324, ETH
 * $2,307. March CPI hot (+0.9% MoM on gas, core +0.2%); Fed 3.50-3.75% hold,
 * next FOMC Apr 28-29. Regime today: pure binary risk — haven bid re-firming
 * into expiry vs. deal headline could snap risk-on back on.)
 */

const ATLAS_URL = process.env.ATLAS_URL || 'http://localhost:3001';
const ENDPOINT = `${ATLAS_URL}/api/macro-inject`;

// Shared risk set — ceasefire expiry today is the single biggest cross-asset binary
const CORE_RISKS = [
  'Iran ceasefire expires TODAY Apr 21 — direct re-escalation into Hormuz',
  'Islamabad talks fail (Iran FM says "no plan" for round 2) → risk-off snap',
  'Fed Apr 28-29 FOMC turns hawkish on hot March CPI (+0.9% MoM headline)'
];

const SYMBOLS = [
  // ── PRECIOUS METALS ────────────────────────────────────────────────────────
  {
    symbol: 'GOLD',
    sentiment: 'BULLISH',
    strength: 8,
    summary: 'Gold $4,830, stable near highs with haven bid re-firming as Apr 21 ceasefire expires today; DXY 98 weakness + sticky 3%+ CPI still tailwind.',
    key_risks: ['Surprise Islamabad breakthrough → haven bid collapses', 'DXY reclaims 100 on Fed hawk surprise', 'Profit-taking after extended parabolic run'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'SILVER',
    sentiment: 'BULLISH',
    strength: 7,
    summary: 'Silver ~$80, holding decade-high ground on gold tailwind + industrial demand; profit-taking has cooled but trend intact as Iran risk re-prices.',
    key_risks: ['Profit-taking after vertical run', 'Industrial demand rollover on global growth scare', 'Gold reversal if ceasefire holds past today'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'COPPER',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'Copper ~$6.07/lb, hovering near 2-month highs but risk-on momentum fading as Iran tension returns; China rebound partially absorbed.',
    key_risks: ['Risk-off snap on ceasefire collapse', 'LME inventory build accelerates', 'CSI 300 rebound fades'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'PLATINUM',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'Platinum ~$2,095, holding gains on auto-catalyst demand + metals rotation; YoY still strongest in years but momentum flattening.',
    key_risks: ['Auto demand softening on global growth scare', 'Metals rotation unwinds', 'Profit-taking after parabolic YoY gain'],
    supports_long: true,
    supports_short: false
  },

  // ── ENERGY ─────────────────────────────────────────────────────────────────
  {
    symbol: 'OILWTI',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'WTI $88.26, Brent $94.87 — softened in Asia on guarded Islamabad talk hopes, but ceasefire expires TODAY with weekend escalation unresolved. Binary either way.',
    key_risks: ['Ceasefire holds → flush toward $80', 'Ceasefire breaks → spike above $100 on Hormuz', 'OPEC+ surprise production decision'],
    supports_long: false,
    supports_short: false
  },

  // ── US INDICES ─────────────────────────────────────────────────────────────
  {
    symbol: 'US500',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'S&P 500 ~7,124, pulled back -0.24% Monday from record as Iran re-escalation hit risk appetite; still extended but trend intact above 7,000.',
    key_risks: ['Ceasefire collapses today → sharp pullback', 'Hot CPI forces Fed hawk pivot Apr 28-29', 'Q1 earnings disappointments'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'US30',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'Dow ~49,443, flat Monday (-0.01%); energy component supportive if oil re-spikes but industrials vulnerable on weekend Iran re-escalation.',
    key_risks: ['Oil flush hurts energy components if deal holds', 'Industrials Q1 earnings miss', ...CORE_RISKS.slice(0, 1)],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'US100',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'Nasdaq -0.26% Monday, snapping 13-day win streak (longest since 1992). Tech leadership still intact on weak DXY but momentum cooling into ceasefire expiry.',
    key_risks: ['Streak-break follow-through selling', 'Rate-path shock hits long-duration tech', 'Ceasefire collapse triggers risk-off'],
    supports_long: true,
    supports_short: false
  },

  // ── EUROPE INDICES ─────────────────────────────────────────────────────────
  {
    symbol: 'UK100',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'FTSE ~10,609, fell -0.55% Monday with Stoxx 600 -0.9% on Iran re-tension; oil-heavy composition cuts both ways into today\'s ceasefire expiry.',
    key_risks: ['Iran deal reset → BP/Shell sell-off', 'BoE stuck on UK inflation stickiness', 'Miners drag on China uncertainty'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'DE40',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'DAX retraced with Stoxx 600 -0.9% Monday as Iran re-tension dented export sentiment; Germany most exposed to any Hormuz-driven energy re-spike.',
    key_risks: ['Ceasefire collapse → energy shock on German industry', 'ECB delays cuts on inflation stickiness', 'Autos/industrials miss Q1'],
    supports_long: false,
    supports_short: false
  },

  // ── ASIA INDICES ───────────────────────────────────────────────────────────
  {
    symbol: 'J225',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'Nikkei still near all-time high after +2.73% weekly run; weak-yen exporter tailwind intact but Iran re-tension caps further upside near term.',
    key_risks: ['Yen strength squeeze on BoJ pivot', 'Ceasefire collapse triggers regional risk-off', 'Global tech pullback after Nasdaq streak break'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'HK50',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'Hang Seng advanced +1.03% last week on China data + regional risk-on, but momentum stalls as Iran binary re-prices. No standalone catalyst today.',
    key_risks: ['China property/deflation relapse', 'CSI 300 rebound fades', 'Tech sector pullback on Nasdaq streak break'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'CN50',
    sentiment: 'NEUTRAL',
    strength: 5,
    summary: 'CSI 300 +1.99% last week on better-than-expected China data, but deflation/property overhang persists and Iran tension caps follow-through.',
    key_risks: ['Rebound fades into resistance', 'No follow-through from Beijing stimulus', 'Global risk-off on ceasefire collapse'],
    supports_long: false,
    supports_short: false
  },

  // ── CRYPTO ─────────────────────────────────────────────────────────────────
  {
    symbol: 'BTCUSD',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'BTC $75,324, pushing through $75k on weak DXY + ETF demand despite Iran re-tension; overhead supply heavy but breakout signal constructive.',
    key_risks: ['$75k fails into heavy supply', 'Ceasefire collapse triggers broad de-risking', 'Spot ETF outflow surprise'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'ETHUSD',
    sentiment: 'BULLISH',
    strength: 6,
    summary: 'ETH $2,307 after opening $2,263 — riding BTC beta on weak DXY + inflation hedge narrative; ETH/BTC ratio back at 3-month high.',
    key_risks: ['Beta unwind if BTC stalls at $75k', 'ETH/BTC ratio rollover', 'Risk-off from ceasefire collapse'],
    supports_long: true,
    supports_short: false
  },

  // ── USD MAJORS ─────────────────────────────────────────────────────────────
  {
    symbol: 'EURUSD',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'EUR/USD ~1.1759, trending back toward 2026 highs as DXY slips below 98; Iran tension cuts both ways for EUR via energy-import risk.',
    key_risks: ['Fed hawk surprise reverses DXY slide', 'Ceasefire collapse → EUR energy drag back in focus', 'ECB cuts earlier than expected'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'GBPUSD',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'Cable holding near highs on DXY below 99; sticky UK CPI keeps BoE on hold but Iran binary clouds energy-drag read near term.',
    key_risks: ['UK CPI surprise shifts BoE calculus', 'DXY reclaims 100 on Fed hawk surprise', 'Ceasefire collapse → risk-off USD bid'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'USDJPY',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'USDJPY pinned as both USD and JPY under pressure — dollar weak on DXY, yen weak on yield gravity; haven bid starting to firm into ceasefire expiry.',
    key_risks: ['BoJ hawkish pivot on imported inflation', 'Fed hawk repricing lifts USD', 'Ceasefire collapse restores JPY haven bid'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'USDCAD',
    sentiment: 'BEARISH',
    strength: 5,
    summary: 'USDCAD supported by DXY weakness but oil softening on talk hopes dents CAD tailwind; two-way risk into today\'s ceasefire expiry.',
    key_risks: ['Ceasefire holds → oil flush hurts CAD', 'BoC dovish surprise', 'Ceasefire breaks → USD haven bid reverses pair'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'USDCHF',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'CHF haven bid re-firming as ceasefire expires today + DXY at 98 weakness; conviction upgraded from 5 on renewed tension backdrop.',
    key_risks: ['SNB intervention on excessive CHF strength', 'Fed hawk pivot Apr 28-29', 'Surprise Islamabad breakthrough removes haven bid'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'AUDUSD',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'AUDUSD slipped from peak zone on Iran re-tension but copper $6.07 + weak DXY still a net tailwind; conviction trimmed from 6.',
    key_risks: ['China rebound fades', 'Copper reversal on LME inventory', 'Ceasefire collapse triggers risk-off'],
    supports_long: true,
    supports_short: false
  },
  {
    symbol: 'NZDUSD',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'NZDUSD rebounded from higher low zone on ascending triangle; RBNZ hawkish stance + weak DXY intact but risk-on cooling into ceasefire expiry.',
    key_risks: ['RBNZ walks back hawkish signal', 'Risk-off from ceasefire collapse', 'Dairy auction miss'],
    supports_long: true,
    supports_short: false
  },

  // ── CROSSES ────────────────────────────────────────────────────────────────
  {
    symbol: 'EURGBP',
    sentiment: 'NEUTRAL',
    strength: 3,
    summary: 'EUR and GBP share similar Iran re-tension energy-drag risk; no clean directional macro edge — pure technicals pair.',
    key_risks: ['ECB/BoE divergence', 'UK CPI asymmetry vs EU', 'Ceasefire collapse re-intensifies energy shock for both'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'EURAUD',
    sentiment: 'BEARISH',
    strength: 4,
    summary: 'AUD tailwind from copper + China data offsets some EUR upside; short bias holds but conviction trimmed as risk-on cools on Iran re-tension.',
    key_risks: ['CSI 300 rebound fades hitting AUD', 'ECB hawkish surprise', 'Ceasefire collapse triggers AUD risk-off'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'EURJPY',
    sentiment: 'NEUTRAL',
    strength: 4,
    summary: 'JPY haven bid firming into ceasefire expiry while EUR still benefits from DXY weakness; cross direction conflicted — no clean edge.',
    key_risks: ['BoJ hawkish pivot', 'Ceasefire collapse lifts JPY haven bid', 'ECB hawk surprise'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'EURCHF',
    sentiment: 'BEARISH',
    strength: 6,
    summary: 'CHF haven bid re-firming into Apr 21 ceasefire expiry while EUR carries residual energy-drag risk; conviction upgraded from 5.',
    key_risks: ['SNB intervention', 'Surprise Islamabad deal removes CHF haven bid', 'ECB hawk pivot'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'GBPCHF',
    sentiment: 'BEARISH',
    strength: 5,
    summary: 'CHF re-firming on renewed Iran tension outweighs GBP DXY-weak tailwind; conviction upgraded as haven bid comes back into focus today.',
    key_risks: ['SNB intervention', 'BoE hawk surprise on UK CPI', 'Ceasefire breakthrough removes CHF haven'],
    supports_long: false,
    supports_short: true
  },
  {
    symbol: 'GBPJPY',
    sentiment: 'NEUTRAL',
    strength: 3,
    summary: 'GBP energy-drag risk re-emerges with Iran re-tension while JPY haven bid firms; two conflicted forces — technicals-only.',
    key_risks: ['BoJ hawkish pivot', 'UK CPI asymmetry', 'Risk-on/off regime flip on ceasefire outcome'],
    supports_long: false,
    supports_short: false
  },
  {
    symbol: 'AUDJPY',
    sentiment: 'BULLISH',
    strength: 5,
    summary: 'Classic risk-on proxy — AUD copper tailwind intact but risk-on cooling as JPY haven bid firms into ceasefire expiry; conviction trimmed from 6.',
    key_risks: ['Ceasefire collapses → risk-off snap', 'BoJ hawkish surprise', 'Copper reversal on LME build'],
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
    summary: 'DXY 98.06, pinned near 6-week lows; Iran re-tension raises two-way risk (haven bid possible) but base case stays soft below 99 until Fed repricing.',
    key_risks: ['Fed hawk surprise Apr 28-29 on hot March CPI', 'Ceasefire collapse triggers safe-haven USD bid', 'Euro area data shock'],
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
