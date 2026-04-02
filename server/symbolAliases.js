// Symbol alias mapping — resolves common names to ATLAS symbols
// Used by market intel auto-detection, trade idea parser, webhook

const SYMBOL_ALIASES = {
  J225:     ['J225','NKD','NIKKEI','NK225','JPN225','JAPAN225'],
  GOLD:     ['GOLD','XAU','XAUUSD','GC','GOLD FUTURES'],
  SILVER:   ['SILVER','XAG','XAGUSD','SI'],
  OILWTI:   ['OILWTI','WTI','CRUDE','CL','USOIL','OIL'],
  US30:     ['US30','DOW','DJIA','YM','DJI'],
  US100:    ['US100','NASDAQ','NAS100','NDX','QQ','NQ'],
  US500:    ['US500','SP500','SPX','ES','S&P'],
  DE40:     ['DE40','DAX','GER40','FDAX'],
  UK100:    ['UK100','FTSE'],
  BTCUSD:   ['BTCUSD','BTC','BITCOIN','XBT'],
  ETHUSD:   ['ETHUSD','ETH','ETHEREUM'],
  COPPER:   ['COPPER','HG','XCUUSD'],
  PLATINUM: ['PLATINUM','XPT','XPTUSD'],
  HK50:     ['HK50','HANGSENG','HSI','HKEX'],
  CN50:     ['CN50','CHINA50','A50','FTXINA50'],
  EURUSD:   ['EURUSD','EUR','EURO'],
  GBPUSD:   ['GBPUSD','GBP','POUND','CABLE'],
  USDJPY:   ['USDJPY','JPY','YEN'],
  USDCHF:   ['USDCHF','CHF','SWISSY'],
  USDCAD:   ['USDCAD','CAD','LOONIE'],
  AUDUSD:   ['AUDUSD','AUD','AUSSIE'],
  NZDUSD:   ['NZDUSD','NZD','KIWI'],
  EURJPY:   ['EURJPY'],
  GBPJPY:   ['GBPJPY'],
  AUDJPY:   ['AUDJPY'],
  EURGBP:   ['EURGBP'],
  EURAUD:   ['EURAUD'],
  EURCHF:   ['EURCHF'],
  GBPCHF:   ['GBPCHF'],
};

function resolveSymbol(text) {
  if (!text) return null;
  const upper = text.toUpperCase().trim();
  // Exact match first
  if (SYMBOL_ALIASES[upper]) return upper;
  // Alias search — longer aliases first to prevent partial matches
  const entries = Object.entries(SYMBOL_ALIASES)
    .flatMap(([sym, aliases]) => aliases.map(a => [a, sym]))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [alias, sym] of entries) {
    if (upper.includes(alias)) return sym;
  }
  return null;
}

module.exports = { SYMBOL_ALIASES, resolveSymbol };
