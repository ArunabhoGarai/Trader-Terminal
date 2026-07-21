/**
 * config.js — Front-end configuration
 * Mirrors the watchlist defined in server/index.js so the UI
 * can show all scripts even before live data arrives.
 */

window.TT_CONFIG = {
  SERVER_URL: 'http://localhost:3001',
  // IIFL Markets API field: ltp (last traded price)

  // Default equity calls shown in the bottom panel
  EQUITY_CALLS: [
    {
      symbol: 'RELIANCE',
      type: 'BUY',
      target: '3200',
      sl: '2950',
      horizon: 'Short Term',
      note: 'Near 52W High breakout with strong volumes. Target 3200, SL 2950.',
      time: '10:15 AM',
    },
    {
      symbol: 'INFY',
      type: 'BUY',
      target: '1800',
      sl: '1640',
      horizon: 'Medium Term',
      note: 'Consolidating above support. IT sector momentum positive.',
      time: '10:32 AM',
    },
    {
      symbol: 'TATASTEEL',
      type: 'SELL',
      target: '130',
      sl: '155',
      horizon: 'Short Term',
      note: 'Metal sector pressure. Forming lower highs pattern.',
      time: '11:00 AM',
    },
    {
      symbol: 'HDFCBANK',
      type: 'BUY',
      target: '1850',
      sl: '1670',
      horizon: 'Medium Term',
      note: 'Banking sector recovery. Strong fundamentals intact.',
      time: '11:15 AM',
    },
    {
      symbol: 'BAJFINANCE',
      type: 'ALERT',
      target: '--',
      sl: '--',
      horizon: 'Watch',
      note: 'Approaching 52-week high. Monitor for breakout confirmation.',
      time: '11:45 AM',
    },
    {
      symbol: 'SUNPHARMA',
      type: 'BUY',
      target: '1650',
      sl: '1500',
      horizon: 'Short Term',
      note: 'Pharma index outperforming. RSI indicates momentum.',
      time: '12:05 PM',
    },
  ],

  // Screener thresholds
  NEAR_52H_THRESHOLD: 0.98,   // within 2% of 52W high
  NEAR_52L_THRESHOLD: 1.02,   // within 2% of 52W low
};
