/**
 * IIFL Markets API gateway for the trader-terminal UI.
 *
 * Credentials and access tokens remain server-side. Each browser receives an
 * isolated in-memory session containing its own active watchlist and token.
 *
 * Real-time updates are pushed to the browser via WebSocket.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const axios = require('axios');
const express = require('express');
const { WebSocketServer } = require('ws');
const nseScraper = require('./nse_scraper');
const nseMaster = require('./nse_master');

nseMaster.loadNSEMaster();

loadDotEnv(path.join(__dirname, '.env'));

const CONFIG = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3001),
  apiBaseUrl: (process.env.IIFL_API_BASE_URL || 'https://api.iiflcapital.com/v1').replace(/\/$/, ''),
  marketsUrl: (process.env.IIFL_MARKETS_URL || 'https://markets.iiflcapital.com').replace(/\/$/, ''),
  appKey: process.env.IIFL_APP_KEY || '',
  appSecret: process.env.IIFL_APP_SECRET || '',
  redirectUri: process.env.IIFL_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/auth/callback`,
  quotePollMs: Math.max(Number(process.env.IIFL_QUOTE_POLL_MS || 1000), 1000),
};

const MAX_WATCHLIST_SIZE = 400;
const ACTION_WATCH_LIMIT = 200;
const SESSION_COOKIE = 'tt_session';
const CONTRACT_CACHE_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Built-in NSE Equity symbols — keeps the terminal useful immediately
// ---------------------------------------------------------------------------
const DEFAULT_SPECS = [
  ['ABB', '13', 687.55], ['ACC', '22', 1345.15], ['SBILIFE', '21808', 3160.55],
  ['BHEL', '438', 832.05], ['BPCL', '526', 285.60], ['RELIANCE', '2885', 561.00],
  ['GRASIM', '1232', 96.70], ['AMBUJACEM', '1270', 313.90], ['HDFCBANK', '1333', 1299.00],
  ['HEROMOTOCO', '1348', 160.30], ['HINDALCO', '1363', 306.00], ['HINDUNILVR', '1394', 418.00],
  ['INFY', '1594', 669.00], ['ITC', '1660', 65.00], ['M&M', '2031', 720.00],
  ['ONGC', '2475', 720.00], ['TCS', '11536', 3802.40], ['ICICIBANK', '4963', 1270.70],
  ['TATAMOTORS', '3456', 760.15], ['SUNPHARMA', '3351', 1680.80],
];

const EXTRA_NSE_SPECS = [
  ['KOTAKBANK', '1922', 1920], ['LT', '11483', 3580], ['AXISBANK', '5900', 1180],
  ['ASIANPAINT', '236', 2350], ['MARUTI', '10999', 12800], ['BAJFINANCE', '317', 7200],
  ['TITAN', '3506', 3650], ['WIPRO', '3787', 545], ['HCLTECH', '7229', 1650],
  ['ULTRACEMCO', '11532', 11600], ['NESTLEIND', '17963', 2200], ['POWERGRID', '14977', 342],
  ['NTPC', '11630', 375], ['COALINDIA', '20374', 438], ['ADANIENT', '25', 2600],
  ['ADANIPORTS', '15083', 1380], ['JSWSTEEL', '11723', 945], ['TATASTEEL', '3499', 153],
  ['DRREDDY', '881', 6250], ['CIPLA', '694', 1520], ['DIVISLAB', '10940', 4800],
  ['BAJAJFINSV', '16675', 1850], ['INDUSINDBK', '5258', 1560], ['TECHM', '13538', 1680],
  ['BRITANNIA', '547', 5200], ['EICHERMOT', '910', 4800], ['APOLLOHOSP', '157', 6900],
  ['HDFCLIFE', '467', 680], ['HDFCAMC', '4306', 3950], ['TATACONSUM', '3432', 995],
  ['UPL', '2142', 540], ['SHREECEM', '3103', 28500], ['BAJAJ-AUTO', '16669', 9200],
];

function makeInstrument([symbol, instrumentId, basePrice], index) {
  return { symbol, instrumentId: String(instrumentId), exchange: 'NSEEQ', segment: 'Equity', basePrice, index };
}

const DEFAULT_WATCHLIST = DEFAULT_SPECS.map(makeInstrument);
const STATIC_CATALOG = [...DEFAULT_SPECS, ...EXTRA_NSE_SPECS].map(makeInstrument);
const knownInstruments = new Map(STATIC_CATALOG.map((instrument) => [instrumentKey(instrument), instrument]));
const contractCache = new Map();
const browserSessions = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: 'index.html' }));

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalAt = line.indexOf('=');
    if (equalAt < 1) continue;
    const key = line.slice(0, equalAt).trim();
    let value = line.slice(equalAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function configured() {
  return Boolean(CONFIG.appKey && CONFIG.appSecret && CONFIG.redirectUri);
}

function instrumentKey(instrument) {
  return `${String(instrument.exchange).toUpperCase()}:${String(instrument.instrumentId)}`;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function exchangeCode(exchange, segment) {
  const normalizedExchange = String(exchange || 'NSE').toUpperCase();
  const normalizedSegment = String(segment || 'Equity').toUpperCase();
  if (normalizedExchange === 'NSEEQ' || normalizedExchange === 'BSEEQ' || normalizedExchange === 'NSEFO' || normalizedExchange === 'BSEFO') return normalizedExchange;
  const prefix = normalizedExchange === 'BSE' ? 'BSE' : 'NSE';
  return normalizedSegment === 'F&O' || normalizedSegment === 'FO' || normalizedSegment === 'FNO' ? `${prefix}FO` : `${prefix}EQ`;
}

function segmentLabel(code) {
  return code.endsWith('FO') ? 'F&O' : 'Equity';
}

function publicInstrument(instrument) {
  return { instrumentId: String(instrument.instrumentId), symbol: instrument.symbol, exchange: instrument.exchange, segment: instrument.segment || segmentLabel(instrument.exchange), displayName: instrument.displayName || instrument.symbol };
}

function indiaTradingDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function indiaTimeString() {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
}

// ---------------------------------------------------------------------------
// Quote builders
// ---------------------------------------------------------------------------
function makeEmptyLiveQuote(instrument, position = 0) {
  return {
    exchange: instrument.exchange, instrumentId: instrument.instrumentId, symbol: instrument.symbol,
    lastPrice: 0, pctChange: 0, close: 0, open: 0, high: 0, low: 0,
    bestBidPrice: 0, bestBidQty: 0, bestAskPrice: 0, bestAskQty: 0,
    tradedVolume: 0, week52High: 0, week52Low: 0, position
  };
}

function makeSimulationQuote(instrument, position = 0) {
  const direction = [-.44, 1.43, .51, -1.11, -.83, 1.82, -2.85, .21, .32, .06, .35, 1.01, -.21, 2.14, 1.08, .82, .53, -.47, .16, .72][position % 20] || .1;
  const basePrice = number(instrument.basePrice, 100 + ((position + 1) * 41));
  const close = basePrice / (1 + direction / 100);
  const spread = Math.max(basePrice * .00035, .05);
  const high = Math.max(basePrice, close * (1 + ((position % 5) - 2) / 1000), basePrice + spread) * 1.001;
  const low = Math.max(0, Math.min(basePrice, close * (1 + ((position % 5) - 2) / 1000), basePrice - spread)) * 0.999;

  // Distribute stocks: ~1/3 near 52W high, ~1/3 near 52W low, ~1/3 in between
  const category = position % 3;
  let week52High, week52Low;
  if (category === 0) {
    // Near 52W high: LTP is within 1-3% of the yearly peak
    week52High = +(basePrice * (1.01 + (position % 7) * 0.004)).toFixed(2);
    week52Low  = +(basePrice * (0.55 + (position % 5) * 0.03)).toFixed(2);
  } else if (category === 1) {
    // Near 52W low: LTP is within 1-3% of the yearly floor
    week52High = +(basePrice * (1.30 + (position % 7) * 0.05)).toFixed(2);
    week52Low  = +(basePrice * (0.97 + (position % 5) * 0.004)).toFixed(2);
  } else {
    // In between: neither near high nor low
    week52High = +(basePrice * (1.15 + (position % 7) * 0.03)).toFixed(2);
    week52Low  = +(basePrice * (0.70 + (position % 5) * 0.025)).toFixed(2);
  }

  return {
    instrumentId: String(instrument.instrumentId), symbol: instrument.symbol, exchange: instrument.exchange, segment: instrument.segment || segmentLabel(instrument.exchange),
    lastPrice: basePrice, pctChange: direction, close,
    open: close * (1 + ((position % 5) - 2) / 1000), high,
    low, bestBidPrice: Math.max(0, basePrice - spread),
    bestBidQty: 80 + position * 53, bestAskPrice: basePrice + spread,
    bestAskQty: 100 + position * 61, tradedVolume: 70000 + position * 12431,
    week52High, week52Low, updatedAt: new Date().toISOString(), position,
  };
}

function extract(obj, keys, fallback) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== 0 && obj[k] !== '0' && obj[k] !== '') {
      return Number(obj[k]);
    }
  }
  return fallback;
}

function quoteFromPayload(raw, fallback, position) {
  const ltp = extract(raw, ['ltp', 'lastPrice', 'lastTradedPrice', 'LastTradedPrice', 'LTP', 'LastPrice'], fallback.lastPrice);
  let close = extract(raw, ['PClose', 'pClose', 'close', 'previousClose', 'pcClose', 'Close', 'PreviousClose', 'ClosePrice', 'PrevClose'], fallback.close);
  let open = extract(raw, ['open', 'Open', 'OpenPrice', 'OpeningPrice', 'LastOpenPrice'], fallback.open); 
  
  const prevClose = close > 0 ? close : (open > 0 ? open : ltp);
  const pctChange = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
  
  // Extract Bid/Ask handling nested structures from IIFL OpenAPI
  let bidPrice = extract(raw, ['bestBidPrice', 'BuyRate', 'buyRate', 'BuyRate1', 'buyRate1', 'buyPrice', 'buyPrice1', 'BuyPrice1', 'BidRate', 'bidRate', 'BuyPrice', 'BidPrice'], raw.Bids?.[0]?.Price ?? raw.bids?.[0]?.price ?? fallback.bestBidPrice);
  let bidQty = extract(raw, ['bestBidQuantity', 'bestBidQty', 'BuyQty', 'buyQty', 'BuyQty1', 'buyQty1', 'BidQty', 'bidQty', 'TotalBuyQty'], raw.Bids?.[0]?.Size ?? raw.bids?.[0]?.quantity ?? raw.Bids?.[0]?.Quantity ?? fallback.bestBidQty);
  
  let askPrice = extract(raw, ['bestAskPrice', 'bestAskRate', 'SellRate', 'sellRate', 'SellRate1', 'sellRate1', 'sellPrice', 'sellPrice1', 'SellPrice1', 'AskRate', 'askRate', 'SellPrice', 'OfferRate', 'AskPrice'], raw.Asks?.[0]?.Price ?? raw.asks?.[0]?.price ?? fallback.bestAskPrice);
  let askQty = extract(raw, ['bestAskQuantity', 'bestAskQty', 'SellQty', 'sellQty', 'SellQty1', 'sellQty1', 'AskQty', 'askQty', 'OfferQty', 'TotalSellQty'], raw.Asks?.[0]?.Size ?? raw.asks?.[0]?.quantity ?? raw.Asks?.[0]?.Quantity ?? fallback.bestAskQty);

  let high = extract(raw, ['high', 'High', 'HighPrice', 'DayHigh', 'DayHighPrice', 'SessionHigh'], fallback.high);
  let low = extract(raw, ['low', 'Low', 'LowPrice', 'DayLow', 'DayLowPrice', 'SessionLow'], fallback.low);

  // Enforce High/Low bounds based on LTP only if they are non-zero (so 0 remains 0 if missing)
  if (high > 0 && high < ltp) high = ltp;
  if (low > 0 && low > ltp) low = ltp;

  // SANITY CHECK: Enforce High/Low bounds and prevent 5% deviations on depth rates
  if (ltp > 0) {
    const spread = Math.max(ltp * 0.00035, 0.05);
    if (Math.abs(bidPrice - ltp) / ltp > 0.05 || (high > 0 && bidPrice > high) || (low > 0 && bidPrice < low)) bidPrice = +(ltp - spread).toFixed(2);
    if (Math.abs(askPrice - ltp) / ltp > 0.05 || (high > 0 && askPrice > high) || (low > 0 && askPrice < low)) askPrice = +(ltp + spread).toFixed(2);
  }

  // Extract 52W High & Low with all possible IIFL key aliases
  let week52High = extract(raw, [
    'week52High', 'FiftyTwoWeekHighPrice', 'FiftyTwoWeekHigh', 'High52Week', 'High52', 
    '52WHigh', '52WeekHigh', 'FiftyTwoWkHigh', 'High52WK', 'High52W', 'High52WeekPrice', 'FiftyTwoWeekHighRate'
  ], fallback.week52High);

  let week52Low = extract(raw, [
    'week52Low', 'FiftyTwoWeekLowPrice', 'FiftyTwoWeekLow', 'Low52Week', 'Low52', 
    '52WLow', '52WeekLow', 'FiftyTwoWkLow', 'Low52WK', 'Low52W', 'Low52WeekPrice', 'FiftyTwoWeekLowRate'
  ], fallback.week52Low);

  // If live IIFL payload or raw object doesn't supply valid 52W bounds, ensure fallback is anchored to real LTP
  if (!week52High || week52High <= 0) {
    week52High = fallback.week52High > 0 && Math.abs(fallback.week52High - ltp) / ltp < 0.5 
      ? fallback.week52High 
      : +(ltp * 1.03).toFixed(2);
  }
  if (!week52Low || week52Low <= 0) {
    week52Low = fallback.week52Low > 0 && Math.abs(fallback.week52Low - ltp) / ltp < 0.5 
      ? fallback.week52Low 
      : +(ltp * 0.85).toFixed(2);
  }

  let tickTime = extract(raw, ['TickTime', 'tickTime', 'tickTimestamp', 'timestamp', 'Time', 'time'], null);
  let parsedTime = new Date().toISOString();
  if (tickTime) {
    if (typeof tickTime === 'string' && tickTime.startsWith('/Date(')) {
      parsedTime = new Date(parseInt(tickTime.substr(6))).toISOString();
    } else {
      let d = new Date(tickTime);
      if (!isNaN(d.getTime())) parsedTime = d.toISOString();
    }
  }

  return {
    exchange: raw.exchange ?? raw.ExchangeSegment ?? fallback.exchange,
    instrumentId: String(raw.instrumentId ?? raw.token ?? raw.ExchangeInstrumentID ?? raw.ExchangeInstrumentId ?? fallback.instrumentId),
    symbol: raw.symbol ?? raw.tradingSymbol ?? raw.TradingSymbol ?? raw.DisplayName ?? raw.displayName ?? fallback.symbol,
    lastPrice: ltp,
    pctChange: extract(raw, ['pctChange', 'changePercent', 'PercentChange', 'ChangePercent', 'ChangePercentage', 'priceChangePercent', 'NetChangePercentage', 'PcntChg'], pctChange),
    close: prevClose,
    open, 
    high, 
    low,
    bestBidPrice: bidPrice, 
    bestBidQty: bidQty,
    bestAskPrice: askPrice, 
    bestAskQty: askQty,
    tradedVolume: extract(raw, ['tradedVolume', 'totalQty', 'totalTradedQuantity', 'TotalQty', 'Volume', 'TotalTradedQuantity', 'TotalTradedQty', 'TradedVolume', 'VolumeTraded', 'TTQ'], fallback.tradedVolume),
    week52High, 
    week52Low,
    updatedAt: parsedTime, 
    position: fallback.position,
  };
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------
function createBrowserSession() {
  const watchlist = DEFAULT_WATCHLIST.map((instrument) => ({ ...instrument }));
  const quotes = watchlist.map(makeSimulationQuote);
  return {
    id: crypto.randomUUID(), accessToken: null, expiresAt: null, authenticatedAt: null, mode: 'SIMULATION', lastError: null,
    watchlist, quotes, actionWatch: [], actionWatchDate: indiaTradingDate(),
    // Per-instrument state for the action watch engine
    // Seed intradayRanges from LTP only (not OHLC high/low) so the monotonic breakout check starts clean
    intradayRanges: new Map(quotes.map((quote) => [instrumentKey(quote), { high: quote.lastPrice, low: quote.lastPrice, lastAlertHigh: null, lastAlertLow: null, lastAlertTime: 0 }])),
    // WebSocket clients attached to this session
    wsClients: new Set(),
    marketAnalysis: { highs: [], lows: [], gainers: [], losers: [] },
  };
}

const STATE_FILE = path.join(__dirname, 'terminal_state.json');
const STATE_VERSION = 2; // Bump this when simulation logic changes to force regeneration

function loadGlobalState() {
  const session = createBrowserSession();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.accessToken) session.accessToken = data.accessToken;
      if (data.expiresAt) session.expiresAt = data.expiresAt;
      if (data.authenticatedAt) session.authenticatedAt = data.authenticatedAt;
      if (data.mode) session.mode = data.mode;
      if (data.actionWatch) session.actionWatch = data.actionWatch;
      if (data.actionWatchDate) session.actionWatchDate = data.actionWatchDate;

      // Restore watchlist, ensuring basePrice is available from catalog
      if (data.watchlist) {
        session.watchlist = data.watchlist.map((savedInst) => {
          const catalogInst = knownInstruments.get(instrumentKey(savedInst));
          return { ...savedInst, basePrice: savedInst.basePrice || catalogInst?.basePrice || 100 };
        });
      }
      // Rebuild initial quotes matching the loaded watchlist
      session.quotes = session.watchlist.map((inst, idx) => session.mode === 'LIVE' ? makeEmptyLiveQuote(inst, idx) : makeSimulationQuote(inst, idx));
      if (data.intradayRanges) {
        // Restore saved ranges and normalise to include deduplication fields (added in newer builds)
        session.intradayRanges = new Map(data.intradayRanges.map(([key, range]) => [
          key,
          { lastAlertHigh: null, lastAlertLow: null, lastAlertTime: 0, ...range }
        ]));
      } else {
        // Fresh start — seed from LTP only
        session.intradayRanges = new Map(session.quotes.map((q) => [instrumentKey(q), { high: q.lastPrice, low: q.lastPrice, lastAlertHigh: null, lastAlertLow: null, lastAlertTime: 0 }]));
      }
      console.log(`[STATE] Loaded terminal state with ${session.watchlist.length} scrips and ${session.actionWatch.length} alerts.`);
    } catch (e) {
      console.warn('[STATE] Failed to load terminal_state.json, starting fresh.', e);
    }
  }
  return session;
}

let lastStateJson = '';
function saveGlobalState() {
  const session = browserSessions.get(GLOBAL_SESSION_ID);
  if (!session) return;
  const state = {
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
    authenticatedAt: session.authenticatedAt,
    mode: session.mode,
    watchlist: session.watchlist,
    actionWatch: session.actionWatch,
    actionWatchDate: session.actionWatchDate,
    intradayRanges: Array.from(session.intradayRanges.entries()),
  };
  const json = JSON.stringify(state);
  if (json !== lastStateJson) {
    fs.writeFileSync(STATE_FILE, json, 'utf8');
    lastStateJson = json;
  }
}

const GLOBAL_SESSION_ID = 'global_terminal_session';
if (!browserSessions.has(GLOBAL_SESSION_ID)) {
  browserSessions.set(GLOBAL_SESSION_ID, loadGlobalState());
}

function browserSession(req, res) {
  const session = browserSessions.get(GLOBAL_SESSION_ID);
  if (res) {
    const secure = CONFIG.redirectUri.startsWith('https://') ? '; Secure' : '';
    res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(GLOBAL_SESSION_ID)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  }
  return session;
}

function publicSession(session) {
  return { mode: session.mode, authenticated: Boolean(session.accessToken), configured: configured(), expiresAt: session.expiresAt, pollIntervalMs: CONFIG.quotePollMs, lastError: session.lastError };
}

function publicWatchlist(session) {
  return { count: session.watchlist.length, max: MAX_WATCHLIST_SIZE, items: session.watchlist.map(publicInstrument) };
}

function terminalPayload(session) {
  return { quotes: session.quotes, session: publicSession(session), watchlist: publicWatchlist(session), actionWatch: session.actionWatch, marketAnalysis: session.marketAnalysis };
}

// ---------------------------------------------------------------------------
// ACTION WATCH ENGINE — The core alert detection logic
// ---------------------------------------------------------------------------
// Direction/sentiment is determined by comparing LTP against PREVIOUS DAY'S
// CLOSE, NOT the previous tick. This is what creates the "pink New High"
// paradox: a stock can hit a session high while still being below yesterday's
// close (gap-down recovery), resulting in a New High alert colored pink.
// ---------------------------------------------------------------------------
function updateActionWatch(session, nextQuotes) {
  const today = indiaTradingDate();
  if (session.actionWatchDate !== today) {
    session.actionWatchDate = today;
    session.actionWatch = [];
    session.intradayRanges.clear();
  }

  const newEvents = [];

  for (const quote of nextQuotes) {
    const key = instrumentKey(quote);
    const ltp = quote.lastPrice;
    if (!ltp || ltp <= 0) continue;

    const priorRange = session.intradayRanges.get(key);
    const previousClose = number(quote.close, 0);

    if (!priorRange) {
      // First time seeing this instrument today — establish baseline from LTP only, no alert
      session.intradayRanges.set(key, {
        high: ltp,
        low: ltp,
        lastAlertHigh: null,  // LTP that triggered the last New High event
        lastAlertLow: null,   // LTP that triggered the last New Low event
        lastAlertTime: 0,     // Timestamp of last alert (for deduplication)
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // STRICT MONOTONIC BREAKOUT CHECK
    // A "New High" fires ONLY when the current LTP is strictly greater than
    // the highest LTP seen so far this session (priorRange.high).
    // A "New Low" fires ONLY when the current LTP is strictly less than the
    // lowest LTP seen so far this session (priorRange.low).
    // We deliberately do NOT use quote.high / quote.low (the exchange's OHLC
    // fields) because those can lag, spike transiently, or be stale — causing
    // false breakout alerts as seen in the ICICIBANK 1439.50 → 1439.30 bug.
    // -----------------------------------------------------------------------
    const isNewHigh = ltp > priorRange.high;
    const isNewLow  = ltp < priorRange.low;

    // Sentiment: LTP vs previous day's close (not vs previous tick)
    const direction = previousClose > 0 && ltp < previousClose ? 'down' : 'up';

    if (isNewHigh || isNewLow) {
      const nowMs = Date.now();
      const status = isNewHigh ? 'New High' : 'New Low';

      // Deduplication: suppress duplicate events for the same scrip+status
      // within a 2-second window to prevent rapid-fire identical rows
      const isDuplicate =
        priorRange.lastAlertTime &&
        (nowMs - priorRange.lastAlertTime) < 2000 &&
        ((isNewHigh && priorRange.lastAlertHigh !== null && ltp <= priorRange.lastAlertHigh + 0.01) ||
         (isNewLow  && priorRange.lastAlertLow  !== null && ltp >= priorRange.lastAlertLow  - 0.01));

      if (!isDuplicate) {
        const event = {
          instrumentId: String(quote.instrumentId),
          symbol: quote.symbol,
          exchange: quote.exchange,
          segment: quote.segment || segmentLabel(quote.exchange),
          status,
          lastPrice: ltp,
          close: previousClose,
          direction,
          timestamp: quote.updatedAt || new Date().toISOString(),
          time: indiaTimeString(),
        };
        newEvents.push(event);
        session.actionWatch.unshift(event);
        if (session.actionWatch.length > ACTION_WATCH_LIMIT) session.actionWatch.length = ACTION_WATCH_LIMIT;

        // Record this alert for deduplication on the next tick
        priorRange.lastAlertHigh = isNewHigh ? ltp : priorRange.lastAlertHigh;
        priorRange.lastAlertLow  = isNewLow  ? ltp : priorRange.lastAlertLow;
        priorRange.lastAlertTime = nowMs;
      }
    }

    // Update tracked session range — strictly monotonic from LTP only
    session.intradayRanges.set(key, {
      ...priorRange,
      high: Math.max(priorRange.high, ltp),
      low:  Math.min(priorRange.low,  ltp),
    });
  }

  return newEvents;
}

// ---------------------------------------------------------------------------
// IIFL API integration
// ---------------------------------------------------------------------------
function clearSession(session, message) {
  session.accessToken = null;
  session.expiresAt = null;
  session.authenticatedAt = null;
  session.mode = 'SIMULATION';
  session.lastError = message || null;
}

function extractToken(payload) {
  return payload?.access_token || payload?.accessToken || payload?.result?.access_token || payload?.result?.accessToken || payload?.result?.userSession || payload?.userSession || payload?.token || null;
}

function callbackClientId(req) {
  const value = req.query.clientId || req.query.clientid || req.query.clientCode || req.query.clientcode || req.query.client_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function exchangeAuthorizationCode(code, clientId, session) {
  if (!clientId) throw new Error('The IIFL callback did not include a client ID. Confirm the current /getusersession request schema with IIFL before enabling live login.');
  const checksum = crypto.createHash('sha256').update(`${clientId}${code}${CONFIG.appSecret}`).digest('hex');
  const response = await axios.post(`${CONFIG.apiBaseUrl}/getusersession`, { clientId, checkSum: checksum }, {
    headers: { 'Content-Type': 'application/json', AppKey: CONFIG.appKey }, timeout: 15000,
  });
  const token = extractToken(response.data);
  if (!token) throw new Error('IIFL did not return an access token. Verify the app key, client ID, redirect URI, and token endpoint settings.');
  session.accessToken = token;
  session.authenticatedAt = new Date().toISOString();
  const expiresIn = number(response.data?.expires_in ?? response.data?.result?.expires_in, 0);
  session.expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  session.mode = 'LIVE';
  session.lastError = null;
  // First live snapshot establishes today's range — not an alert
  session.actionWatch = [];
  session.actionWatchDate = indiaTradingDate();
  session.intradayRanges.clear();
}

async function refreshLiveQuotes(session) {
  if (!session.accessToken) return { success: false, events: [] };
  
  // Build request payload: Watchlist + Next 100 Market Scanner stocks
  const requestInstruments = new Map();
  session.watchlist.forEach((inst) => requestInstruments.set(instrumentKey(inst), { exchange: inst.exchange, instrumentId: inst.instrumentId, symbol: inst.symbol, isWatchlist: true }));
  
  // Add 52W High & 52W Low scrips from Moneycontrol & official NSE to batch request
  const realNseData = nseScraper.getNSEMarketWideData();
  const highsMcList = realNseData.highs_mc || [];
  const highsNseList = realNseData.highs || [];
  const lowsMcList = realNseData.lows_mc || [];
  const lowsNseList = realNseData.lows || [];

  // Deduplicate and merge 52W High scrips
  const mergedHighsMap = new Map();
  highsMcList.forEach((item) => {
    const symKey = String(item.nseSymbol || item.symbol || '').replace(/-EQ$/i, '').toUpperCase().trim();
    if (symKey && !mergedHighsMap.has(symKey)) mergedHighsMap.set(symKey, { ...item, symbol: `${symKey}-EQ` });
  });
  highsNseList.forEach((item) => {
    const symKey = String(item.nseSymbol || item.symbol || '').replace(/-EQ$/i, '').toUpperCase().trim();
    if (symKey && !mergedHighsMap.has(symKey)) mergedHighsMap.set(symKey, { ...item, symbol: `${symKey}-EQ` });
  });
  const mergedHighsList = Array.from(mergedHighsMap.values());

  // Deduplicate and merge 52W Low scrips
  const mergedLowsMap = new Map();
  lowsMcList.forEach((item) => {
    const symKey = String(item.nseSymbol || item.symbol || '').replace(/-EQ$/i, '').toUpperCase().trim();
    if (symKey && !mergedLowsMap.has(symKey)) mergedLowsMap.set(symKey, { ...item, symbol: `${symKey}-EQ` });
  });
  lowsNseList.forEach((item) => {
    const symKey = String(item.nseSymbol || item.symbol || '').replace(/-EQ$/i, '').toUpperCase().trim();
    if (symKey && !mergedLowsMap.has(symKey)) mergedLowsMap.set(symKey, { ...item, symbol: `${symKey}-EQ` });
  });
  const mergedLowsList = Array.from(mergedLowsMap.values());

  [...mergedHighsList, ...mergedLowsList].forEach((item) => {
    const inst = findInstrumentBySymbol(item.nseSymbol || item.symbol);
    if (inst) {
      const k = instrumentKey(inst);
      if (!requestInstruments.has(k)) {
        requestInstruments.set(k, { exchange: inst.exchange, instrumentId: inst.instrumentId, symbol: inst.symbol, isWatchlist: false });
      }
    }
  });

  if (requestInstruments.size === 0) return { success: false, events: [] };

  try {
    const payload = Array.from(requestInstruments.values()).map(({ exchange, instrumentId }) => ({ exchange, instrumentId }));
    const response = await axios.post(`${CONFIG.apiBaseUrl}/marketdata/marketquotes`, payload, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, timeout: 15000,
    });
    
    const results = Array.isArray(response.data?.result) ? response.data.result : [];
    if (!results.length) {
      console.error('[IIFL ERROR] Empty marketquotes response:', response.data);
      throw new Error(response.data?.message || 'The market quote response did not contain results.');
    }
    
    const previous = new Map(session.quotes.map((quote) => [instrumentKey(quote), quote]));
    // Strongly map by any available ID field to prevent mapping wipeouts
    const resultsByKey = new Map(results.map((quote) => {
      const id = String(quote.instrumentId ?? quote.InstrumentId ?? quote.token ?? quote.Token ?? quote.ScripCode ?? '').trim();
      return [id, quote];
    }));
    
    // Update active watchlist quotes
    const nextQuotes = session.watchlist.map((instrument, index) => {
      const fallback = previous.get(instrumentKey(instrument)) || makeEmptyLiveQuote(instrument, index);
      const raw = resultsByKey.get(String(instrument.instrumentId).trim());
      return raw ? quoteFromPayload(raw, fallback, index) : fallback;
    });
    
    // Enrich merged scanner items with live IIFL quote data and volume
    const enrichScannerList = (list) => {
      const enriched = list.map((item) => {
        const inst = findInstrumentBySymbol(item.nseSymbol || item.symbol);
        if (inst) {
          const raw = resultsByKey.get(String(inst.instrumentId).trim());
          if (raw) {
            const ltp = extract(raw, ['ltp', 'lastPrice', 'lastTradedPrice', 'LastTradedPrice', 'LTP'], item.lastPrice);
            const close = extract(raw, ['PClose', 'pClose', 'close', 'previousClose', 'pcClose', 'Close'], item.prevClose);
            const open = extract(raw, ['open', 'Open', 'OpenPrice'], item.open);
            const high = extract(raw, ['high', 'High', 'HighPrice', 'DayHigh'], item.high);
            const low = extract(raw, ['low', 'Low', 'LowPrice', 'DayLow'], item.low);
            const vol = extract(raw, ['tradedVolume', 'totalQty', 'totalTradedQuantity', 'TotalQty', 'Volume', 'TTQ'], item.tradedVolume || item.volume || 0);
            const pct = close > 0 ? ((ltp - close) / close) * 100 : item.pctChange;
            
            return {
              ...item,
              symbol: `${inst.symbol.replace(/-EQ$/i, '')}-EQ`,
              companyName: item.companyName || inst.symbol.replace(/-EQ$/i, ''),
              instrumentId: inst.instrumentId,
              lastPrice: ltp,
              prevClose: close,
              open,
              high,
              low,
              pctChange: pct,
              tradedVolume: vol,
              volume: vol,
              updatedAt: Date.now()
            };
          }
        }
        return {
          ...item,
          symbol: `${(item.nseSymbol || item.symbol || '').replace(/-EQ$/i, '')}-EQ`,
          companyName: item.companyName || item.symbol
        };
      });
      enriched.sort((a, b) => Number(b.tradedVolume || b.volume || 0) - Number(a.tradedVolume || a.volume || 0));
      return enriched;
    };

    const enrichedHighs = enrichScannerList(mergedHighsList);
    const enrichedLows = enrichScannerList(mergedLowsList);

    // Compute top market-wide analytics
    session.marketAnalysis.highs = enrichedHighs;
    session.marketAnalysis.lows = enrichedLows;
    session.marketAnalysis.highs_mc = enrichedHighs;
    session.marketAnalysis.lows_mc = enrichedLows;
    session.marketAnalysis.gainers = realNseData.gainers;
    session.marketAnalysis.losers = realNseData.losers;
    session.marketAnalysis.volume = realNseData.volume;
    session.marketAnalysis.value = realNseData.value;

    const events = updateActionWatch(session, nextQuotes);
    session.quotes = nextQuotes;
    return { success: true, events };
  } catch (error) {
    console.error('[IIFL API ERROR]', error.response?.data || error.message);
    if (error.response?.status === 401 || error.response?.status === 403) clearSession(session, 'IIFL session expired. Sign in again to continue live data.');
    else session.lastError = 'IIFL market data request failed: ' + (error.response?.data?.message || error.message);
    return { success: false, events: [] };
  }
}

// ---------------------------------------------------------------------------
// Enhanced simulation — generates visible action watch events
// ---------------------------------------------------------------------------
function advanceSimulation(session) {
  // STRICTLY live data logic requested by user: no random simulation.
  // We only sync the background scraped market data (Moneycontrol/NSE) into the session.
  const nseScraper = require('./nse_scraper');
  const realNseData = nseScraper.getNSEMarketWideData();
  const highsMcList = realNseData.highs_mc || [];
  const highsNseList = realNseData.highs || [];
  const lowsMcList = realNseData.lows_mc || [];
  const lowsNseList = realNseData.lows || [];

  const mergedHighsMap = new Map();
  highsMcList.forEach((item) => {
    const symKey = String(item.nseSymbol || item.symbol || '').replace(/-EQ$/i, '').toUpperCase().trim();
    if (symKey && !mergedHighsMap.has(symKey)) mergedHighsMap.set(symKey, { ...item, symbol: `${symKey}-EQ` });
  });
  highsNseList.forEach((item) => {
    const symKey = String(item.nseSymbol || item.symbol || '').replace(/-EQ$/i, '').toUpperCase().trim();
    if (symKey && !mergedHighsMap.has(symKey)) mergedHighsMap.set(symKey, { ...item, symbol: `${symKey}-EQ` });
  });

  const mergedLowsMap = new Map();
  lowsMcList.forEach((item) => {
    const symKey = String(item.nseSymbol || item.symbol || '').replace(/-EQ$/i, '').toUpperCase().trim();
    if (symKey && !mergedLowsMap.has(symKey)) mergedLowsMap.set(symKey, { ...item, symbol: `${symKey}-EQ` });
  });
  lowsNseList.forEach((item) => {
    const symKey = String(item.nseSymbol || item.symbol || '').replace(/-EQ$/i, '').toUpperCase().trim();
    if (symKey && !mergedLowsMap.has(symKey)) mergedLowsMap.set(symKey, { ...item, symbol: `${symKey}-EQ` });
  });

  const mergedHighs = Array.from(mergedHighsMap.values());
  mergedHighs.sort((a, b) => Number(b.tradedVolume || b.volume || 0) - Number(a.tradedVolume || a.volume || 0));

  const mergedLows = Array.from(mergedLowsMap.values());
  mergedLows.sort((a, b) => Number(b.tradedVolume || b.volume || 0) - Number(a.tradedVolume || a.volume || 0));

  session.marketAnalysis.highs = mergedHighs;
  session.marketAnalysis.lows = mergedLows;
  session.marketAnalysis.highs_mc = mergedHighs;
  session.marketAnalysis.lows_mc = mergedLows;
  session.marketAnalysis.gainers = realNseData.gainers;
  session.marketAnalysis.losers = realNseData.losers;
  session.marketAnalysis.volume = realNseData.volume;
  session.marketAnalysis.value = realNseData.value;
  
  return []; // no action watch events generated in static mode
}

// ---------------------------------------------------------------------------
// Contract file search (instrument discovery)
// ---------------------------------------------------------------------------
function contractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.instruments)) return payload.instruments;
  return [];
}

function normaliseContract(row, code, index) {
  const instrumentId = row.instrumentId ?? row.instrumentID ?? row.InstrumentId ?? row.InstrumentID ?? row.exchangeInstrumentId ?? row.exchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.ExchangeInstrumentID ?? row.token ?? row.Token ?? row.securityId ?? row.securityID ?? row.SecurityId ?? row.SecurityID;
  const symbol = row.symbol ?? row.Symbol ?? row.tradingSymbol ?? row.TradingSymbol ?? row.tradingSymbolName ?? row.TradingSymbolName ?? row.scripName ?? row.ScripName ?? row.name ?? row.Name ?? row.displayName ?? row.DisplayName;
  if (!instrumentId || !symbol) return null;
  const instrument = {
    instrumentId: String(instrumentId), symbol: String(symbol).trim().toUpperCase(), exchange: code,
    segment: segmentLabel(code), displayName: String(row.displayName ?? row.name ?? row.scripName ?? symbol).trim(),
    basePrice: number(row.lastPrice ?? row.close ?? row.strikePrice, 100 + ((index + 1) * 17)),
  };
  knownInstruments.set(instrumentKey(instrument), instrument);
  return instrument;
}

async function contractsFor(code) {
  const cached = contractCache.get(code);
  if (cached && Date.now() - cached.at < CONTRACT_CACHE_MS) return cached.instruments;
  try {
    const response = await axios.get(`${CONFIG.apiBaseUrl}/contractfiles/${code}.json`, { timeout: 20000 });
    const instruments = contractRows(response.data).map((row, index) => normaliseContract(row, code, index)).filter(Boolean);
    contractCache.set(code, { at: Date.now(), instruments });
    return instruments;
  } catch (error) {
    return [];
  }
}

async function searchInstruments(exchange, segment, query) {
  const needle = String(query || '').trim().toUpperCase();
  const matches = (instrument) => !needle || instrument.symbol.includes(needle) || String(instrument.displayName || '').toUpperCase().includes(needle);
  const requestedExchange = String(exchange || 'NSE').toUpperCase();
  const requestedSegment = String(segment || 'Equity').toUpperCase();
  const codes = requestedExchange === 'ALL'
    ? (requestedSegment === 'ALL' ? ['NSEEQ', 'BSEEQ', 'NSEFO', 'BSEFO'] : ['NSE', 'BSE'].map((value) => exchangeCode(value, segment)))
    : (requestedSegment === 'ALL' ? [exchangeCode(exchange, 'Equity'), exchangeCode(exchange, 'F&O')] : [exchangeCode(exchange, segment)]);
  let instruments = STATIC_CATALOG.filter((instrument) => codes.includes(instrument.exchange) && matches(instrument));
  if (needle.length >= 2) {
    const catalogs = await Promise.all(codes.filter((code) => code !== 'NSEEQ' || instruments.length < 10).map(contractsFor));
    instruments = [...instruments, ...catalogs.flat().filter(matches)];
  }
  const unique = new Map();
  instruments.forEach((instrument) => {
    if (!unique.has(instrument.symbol)) {
      unique.set(instrument.symbol, instrument);
    }
  });
  return [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).slice(0, 15);
}

function knownInstrument(exchange, instrumentId) {
  return knownInstruments.get(instrumentKey({ exchange, instrumentId }));
}

function findInstrumentBySymbol(symbol) {
  if (!symbol) return null;
  const cleanSym = String(symbol).toUpperCase().replace(/-EQ$/, '').trim();
  for (const inst of knownInstruments.values()) {
    const instSym = String(inst.symbol || '').toUpperCase().replace(/-EQ$/, '').trim();
    if (instSym === cleanSym) return inst;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebSocket — real-time push to browser clients
// ---------------------------------------------------------------------------
function broadcastToSession(session, payload) {
  const message = JSON.stringify(payload);
  for (const ws of session.wsClients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      try { ws.send(message); } catch (_) { /* client will be cleaned up on close */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Server-side auto-poll loop
// Runs continuously and pushes quote updates + action watch events to all
// connected WebSocket clients.
// ---------------------------------------------------------------------------
let pollTimer = null;

async function pollAllSessions() {
  try {
    for (const [, session] of browserSessions) {
      let newEvents = [];

      if (session.mode === 'LIVE') {
        const result = await refreshLiveQuotes(session);
        newEvents = result.events;
      } else {
        newEvents = advanceSimulation(session);
      }

      if (session.wsClients.size > 0) {
        broadcastToSession(session, {
          type: 'tick',
          quotes: session.quotes,
          actionWatch: session.actionWatch,
          marketAnalysis: session.marketAnalysis,
          newEvents,
          session: publicSession(session),
          watchlist: publicWatchlist(session),
          timestamp: new Date().toISOString(),
        });
      }
    }
    saveGlobalState();
  } catch (err) {
    console.error('[POLL ERROR]', err.message);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollAllSessions, CONFIG.quotePollMs);
  console.log(`Auto-poll started (every ${CONFIG.quotePollMs}ms)`);
}

// ---------------------------------------------------------------------------
// Express routes
// ---------------------------------------------------------------------------
function sendTerminal(_req, res) {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
}

app.get('/api/session', (req, res) => {
  const session = browserSession(req, res);
  res.json({ ...publicSession(session), watchlist: publicWatchlist(session) });
});

app.get('/api/market-watch', (req, res) => {
  const session = browserSession(req, res);
  res.json(terminalPayload(session));
});

app.post('/api/market-watch/refresh', async (req, res) => {
  const session = browserSession(req, res);
  if (session.mode === 'LIVE') await refreshLiveQuotes(session);
  if (session.mode !== 'LIVE') advanceSimulation(session);
  res.json(terminalPayload(session));
});

app.post('/api/nse/refresh', async (req, res) => {
  const result = await nseScraper.scrapeNSE(true);
  res.json(result);
});

app.get('/api/instruments', async (req, res) => {
  const exchange = String(req.query.exchange || 'NSE');
  const segment = String(req.query.segment || 'Equity');
  const query = String(req.query.q || '').slice(0, 48);
  const instruments = await searchInstruments(exchange, segment, query);
  res.json({ exchange, segment, instruments: instruments.map(publicInstrument) });
});

// ---------------------------------------------------------------------------
// INDICES — Nifty 50, Sensex, Bank Nifty — real-time from IIFL
// 1. The Master Symbol Dictionary for strict resolution
const TERMINAL_INDEX_MAP = {
  "nifty": {
    displayLabel: "NIFTY 50",
    googleFinanceToken: "INDEXNSE:NIFTY_50",
    tradingViewToken: "NSE:NIFTY",
    yahooToken: "^NSEI",
    iiflPayload: {
      exchangeSegment: "INDICES",
      exchangeInstrumentID: 26000
    },
    simBase: 24836, simClose: 24700
  },
  "sensex": {
    displayLabel: "BSE SENSEX",
    googleFinanceToken: "INDEXBOM:SENSEX",
    tradingViewToken: "BSE:SENSEX",
    yahooToken: "^BSESN",
    iiflPayload: {
      exchangeSegment: "INDICES",
      exchangeInstrumentID: 10001
    },
    simBase: 81523, simClose: 81100
  },
  "banknifty": {
    displayLabel: "BANK NIFTY",
    googleFinanceToken: "INDEXNSE:NIFTY_BANK",
    tradingViewToken: "NSE:BANKNIFTY",
    yahooToken: "^NSEBANK",
    iiflPayload: {
      exchangeSegment: "INDICES",
      exchangeInstrumentID: 26009
    },
    simBase: 56200, simClose: 55900
  },
  "nasdaq": {
    displayLabel: "NASDAQ",
    googleFinanceToken: "INDEXNASDAQ:.IXIC",
    tradingViewToken: "NASDAQ:IXIC",
    yahooToken: "^IXIC",
    iiflPayload: null, // Fetched from Yahoo Finance, not IIFL
    simBase: 17800, simClose: 17750
  }
};

// Keep simulated index values in memory so they drift smoothly
const indexSimState = Object.fromEntries(
  Object.entries(TERMINAL_INDEX_MAP).map(([key, data]) => [key, { ltp: data.simBase, close: data.simClose }])
);

app.get('/api/analysis/refresh', async (req, res) => {
  const session = browserSession(req, res);
  const tab = String(req.query.tab || 'high');
  
  if (tab === 'high' || tab === 'low') {
    await nseScraper.scrapeMoneycontrol52W();
    await nseScraper.scrapeNSE();
  } else if (tab === 'gainers' || tab === 'losers') {
    await nseScraper.scrapeMoneycontrolGainersLosers();
  } else if (tab === 'traded' || tab === 'quantity') {
    await nseScraper.scrapeNSE();
  }
  
  if (session.mode === 'LIVE') {
    await refreshLiveQuotes(session);
  } else {
    advanceSimulation(session);
  }

  res.json(session.marketAnalysis);
});

// Utility: Fetch IIFL INDICES.json to dynamically resolve SENSEX token
async function fetchSensexToken() {
  try {
    const res = await axios.get('https://api.iiflcapital.com/v1/contractfiles/INDICES.json', { timeout: 15000 });
    const sensex = res.data.find(i => i.underlyingInstrumentName && i.underlyingInstrumentName.includes('SENSEX'));
    if (sensex && sensex.instrumentId) {
      TERMINAL_INDEX_MAP['sensex'].iiflPayload = {
        exchange: sensex.exchange || 'BSEEQ',           // for marketquotes payload
        exchangeSegment: 'INDICES',                      // kept for reference
        exchangeInstrumentID: parseInt(sensex.instrumentId, 10),
        instrumentId: sensex.instrumentId               // string form for marketquotes
      };
      console.log(`[INDICES] Dynamically resolved SENSEX IIFL Token: ${sensex.instrumentId} (${sensex.exchange})`);
    }
  } catch (err) {
    console.error('[INDICES] Failed to fetch dynamic SENSEX token, falling back to static config:', err.message);
  }
}

// Utility: Fetch all indices concurrently from Yahoo Finance proxy
async function fetchYahooIndices() {
  const targets = [
    { symbol: '^NSEI', name: 'nifty' },
    { symbol: '^BSESN', name: 'sensex' },
    { symbol: '^NSEBANK', name: 'banknifty' },
    { symbol: '^IXIC', name: 'nasdaq' }
  ];

  const fetchPromises = targets.map(async ({ symbol, name }) => {
    try {
      const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, { timeout: 6000 });
      const meta = res.data?.chart?.result?.[0]?.meta;
      if (meta) {
        return { 
          name, 
          ltp: meta.regularMarketPrice, 
          close: meta.chartPreviousClose 
        };
      }
    } catch (err) {}
    return null;
  });

  const results = await Promise.all(fetchPromises);
  return results.filter(Boolean);
}

app.get('/api/indices/debug', async (req, res) => {
  res.json({ message: "Legacy debug endpoint disabled." });
});

app.get('/api/indices', async (req, res) => {
  const session = browserSession(req, res);

  // Always fetch Yahoo to get reliable previous close baselines
  const yahooData = await fetchYahooIndices();
  const getYahoo = (name) => yahooData.find(y => y.name === name);

  if (session.accessToken) {
    const iiflIndexInstruments = [
      { exchange: 'NSEEQ', instrumentId: '999920000', name: 'nifty' },
      { exchange: 'NSEEQ', instrumentId: '999920005', name: 'banknifty' },
      { 
        exchange: TERMINAL_INDEX_MAP['sensex'].iiflPayload?.exchange || 'BSEEQ', 
        instrumentId: String(TERMINAL_INDEX_MAP['sensex'].iiflPayload?.exchangeInstrumentID || '999901'),
        name: 'sensex'
      },
    ];

    let iiflError = null;
    let iiflRawErrorBody = null;
    let results = [];

    try {
      const iiflResponse = await axios.post(
        `${CONFIG.apiBaseUrl}/marketdata/marketquotes`,
        iiflIndexInstruments.map(({ exchange, instrumentId }) => ({ exchange, instrumentId })),
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, timeout: 8000 }
      );
      results = Array.isArray(iiflResponse.data?.result) ? iiflResponse.data.result : [];
    } catch (err) {
      iiflError = err.message;
      iiflRawErrorBody = err.response?.data;
    }

    const indices = [];
    const byToken = new Map(results.map(r => [String(r.instrumentId ?? r.token ?? ''), r]));

    for (const inst of iiflIndexInstruments) {
      const raw = byToken.get(inst.instrumentId) || results.find(r => String(r.instrumentId ?? r.token) === inst.instrumentId);
      const data = TERMINAL_INDEX_MAP[inst.name];
      const yData = getYahoo(inst.name);

      if (raw) {
        // Fetch Real-time Live Price from IIFL
        const ltp = extract(raw, ['ltp', 'lastPrice', 'lastTradedPrice', 'LastTradedPrice', 'LTP', 'LastPrice'], data.simBase);
        
        // Fetch Previous Close from Yahoo (highly reliable) instead of IIFL (which omits it)
        const cl = yData?.close || data.simClose;

        const chg = +(ltp - cl).toFixed(2);
        const pct = cl > 0 ? +((chg / cl) * 100).toFixed(2) : 0;

        indices.push({ name: inst.name, ltp: +ltp.toFixed(2), change: chg, pct, live: true });
      } else if (iiflError) {
        indices.push({
          name: inst.name, ltp: 0, change: 0, pct: 0, live: false, error: true,
          errorReason: `IIFL API ERR: ${iiflError}`,
          errorBody: JSON.stringify(iiflRawErrorBody).substring(0, 200)
        });
      } else {
        indices.push({
          name: inst.name, ltp: 0, change: 0, pct: 0, live: false, error: true,
          errorReason: `Token ${inst.instrumentId} not found in IIFL response`
        });
      }
    }

    // Add NASDAQ strictly from Yahoo
    const nasdaqEntry = getYahoo('nasdaq');
    if (nasdaqEntry) {
      const chg = nasdaqEntry.ltp - nasdaqEntry.close;
      const pct = (chg / nasdaqEntry.close) * 100;
      indices.push({ name: 'nasdaq', ltp: +nasdaqEntry.ltp.toFixed(2), change: +chg.toFixed(2), pct: +pct.toFixed(2), live: true });
    } else {
      indices.push({ name: 'nasdaq', ltp: 0, change: 0, pct: 0, live: false, error: true, errorReason: 'Yahoo Finance fetch failed' });
    }

    return res.json({ success: true, live: true, indices });
  }

  // Fallback: use Yahoo Finance data directly (no random simulation)
  const indices = Object.entries(TERMINAL_INDEX_MAP).map(([name, data]) => {
    const yData = getYahoo(name);
    if (yData) {
      const chg = +(yData.ltp - yData.close).toFixed(2);
      const pct = yData.close > 0 ? +((chg / yData.close) * 100).toFixed(2) : 0;
      return { name, ltp: +yData.ltp.toFixed(2), change: chg, pct, live: true };
    }
    // If Yahoo also failed, return static baseline with no drift
    return { name, ltp: data.simBase, change: 0, pct: 0, live: false };
  });

  res.json({ success: true, live: false, indices });
});

app.get('/api/watchlist', (req, res) => {
  const session = browserSession(req, res);
  res.json(terminalPayload(session));
});

app.post('/api/watchlist', async (req, res) => {
  const session = browserSession(req, res);
  const { exchange, instrumentId, symbol, basePrice } = req.body;
  if (!instrumentId || !exchange) return res.status(400).json({ message: 'Missing scrip identifiers.' });

  const key = instrumentKey({ exchange, instrumentId });
  if (session.watchlist.some((instrument) => instrumentKey(instrument) === key)) return res.status(400).json({ message: 'Scrip already in watchlist.' });

  const next = makeInstrument([symbol || 'UNKNOWN', instrumentId, basePrice || 100, exchange]);
  session.watchlist.push(next);
  session.quotes.push(session.mode === 'LIVE' ? makeEmptyLiveQuote(next, session.watchlist.length - 1) : makeSimulationQuote(next, session.watchlist.length - 1));
  if (session.mode === 'LIVE') await refreshLiveQuotes(session);
  // Notify WebSocket clients about the updated watchlist
  broadcastToSession(session, { type: 'watchlist', quotes: session.quotes, watchlist: publicWatchlist(session), actionWatch: session.actionWatch, session: publicSession(session) });
  res.status(201).json(terminalPayload(session));
});

app.delete('/api/watchlist/:exchange/:instrumentId', (req, res) => {
  const session = browserSession(req, res);
  const key = instrumentKey({ exchange: req.params.exchange, instrumentId: req.params.instrumentId });
  const index = session.watchlist.findIndex((instrument) => instrumentKey(instrument) === key);
  if (index < 0) return res.status(404).json({ message: 'That scrip is not in this watchlist.' });
  session.watchlist.splice(index, 1);
  session.quotes.splice(index, 1);
  // Notify WebSocket clients
  broadcastToSession(session, { type: 'watchlist', quotes: session.quotes, watchlist: publicWatchlist(session), actionWatch: session.actionWatch, session: publicSession(session) });
  res.json(terminalPayload(session));
});

// Debug endpoint to fetch live raw IIFL payload directly
app.get('/api/debug-quotes', async (req, res) => {
  const session = browserSession(req, res);
  if (session.mode !== 'LIVE') return res.status(400).json({ error: 'Not in LIVE mode. Authenticate with IIFL first.' });
  try {
    const payload = session.watchlist.map(({ exchange, instrumentId }) => ({ exchange, instrumentId }));
    const response = await axios.post(`${CONFIG.apiBaseUrl}/marketdata/marketquotes`, payload, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, timeout: 15000,
    });
    res.json({ request: payload, response: response.data });
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

app.post('/api/watchlist/reorder', (req, res) => {
  const session = browserSession(req, res);
  const keys = req.body.keys || [];
  if (!Array.isArray(keys)) return res.status(400).json({ message: 'Expected an array of keys.' });

  const watchMap = new Map(session.watchlist.map((i) => [instrumentKey(i), i]));
  const quoteMap = new Map(session.quotes.map((q) => [instrumentKey(q), q]));

  const nextWatchlist = [];
  const nextQuotes = [];

  for (const k of keys) {
    if (watchMap.has(k)) {
      nextWatchlist.push(watchMap.get(k));
      nextQuotes.push(quoteMap.get(k));
      watchMap.delete(k);
      quoteMap.delete(k);
    }
  }

  // Append any missing ones (in case frontend missed something)
  for (const [k, i] of watchMap.entries()) {
    nextWatchlist.push(i);
    nextQuotes.push(quoteMap.get(k));
  }

  session.watchlist = nextWatchlist;
  session.quotes = nextQuotes;

  // Notify WebSocket clients
  broadcastToSession(session, { type: 'watchlist', quotes: session.quotes, watchlist: publicWatchlist(session), actionWatch: session.actionWatch, session: publicSession(session) });
  res.json(terminalPayload(session));
});

function parseIIFLHistoricalCandles(rawResult, isIntraday) {
  if (!Array.isArray(rawResult)) return [];
  const candles = [];
  for (const c of rawResult) {
    let t, o, h, l, cl;
    if (Array.isArray(c)) {
      t = c[0]; o = c[1]; h = c[2]; l = c[3]; cl = c[4];
    } else if (typeof c === 'string') {
      const parts = c.split(',');
      if (parts.length >= 5) {
        t = parts[0]; o = parts[1]; h = parts[2]; l = parts[3]; cl = parts[4];
      } else continue;
    } else if (c && typeof c === 'object') {
      t = c.time ?? c.Time ?? c.Date ?? c.date ?? c.Timestamp ?? c.timestamp;
      o = c.open ?? c.Open;
      h = c.high ?? c.High;
      l = c.low ?? c.Low;
      cl = c.close ?? c.Close;
    } else continue;

    const rawTimeStr = String(t || '');
    let dateObj;
    if (/^\d+$/.test(rawTimeStr)) {
      const num = Number(rawTimeStr);
      dateObj = new Date(num > 2000000000 ? num : num * 1000);
    } else {
      dateObj = new Date(rawTimeStr.includes('T') ? rawTimeStr : rawTimeStr.replace(' ', 'T'));
    }

    if (isNaN(dateObj.getTime())) continue;

    const timeVal = isIntraday ? Math.floor(dateObj.getTime() / 1000) : dateObj.toISOString().split('T')[0];
    const openNum = Number(o);
    const highNum = Number(h);
    const lowNum = Number(l);
    const closeNum = Number(cl);

    if (Number.isFinite(openNum) && Number.isFinite(highNum) && Number.isFinite(lowNum) && Number.isFinite(closeNum)) {
      candles.push({ time: timeVal, open: openNum, high: highNum, low: lowNum, close: closeNum });
    }
  }
  return candles;
}

app.get('/api/chart/:exchange/:instrumentId', async (req, res) => {
  const session = browserSession(req, res);
  const { exchange, instrumentId } = req.params;
  const { timeframe } = req.query; // '1D', '1M', '1Y', '10Y', '20Y'

  // Build IIFL date strings in "dd-MMM-yyyy" format (e.g. "19-Sep-2024")
  const fmtIIFLDate = (d) => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
  };

  const end = new Date();
  const start = new Date();
  let interval; // IIFL interval string

  switch(timeframe) {
    case '1D':
      start.setDate(end.getDate() - 1);
      interval = '5 minutes';
      break;
    case '1M':
      start.setMonth(end.getMonth() - 1);
      interval = '1 day';
      break;
    case '1Y':
      start.setFullYear(end.getFullYear() - 1);
      interval = 'weekly';
      break;
    case '10Y':
      start.setFullYear(end.getFullYear() - 10);
      interval = 'monthly';
      break;
    case '20Y':
      start.setFullYear(end.getFullYear() - 20);
      interval = 'monthly';
      break;
    default:
      start.setDate(end.getDate() - 1);
      interval = '5 minutes';
  }

  // IIFL API payload — matches docs exactly
  const payload = {
    exchange: exchange,           // e.g. "NSEEQ"
    instrumentId: instrumentId,   // string, e.g. "2885"
    interval: interval,           // e.g. "5 minutes", "1 day", "monthly"
    fromDate: fmtIIFLDate(start), // e.g. "19-Sep-2024"
    toDate: fmtIIFLDate(end)      // e.g. "20-Sep-2024"
  };

  const isIntraday = timeframe === '1D';

  const parseIIFLCandles = (raw) => {
    // Response: result[0].candles = [[timestamp, open, high, low, close, volume], ...]
    const candleArray = Array.isArray(raw?.result)
      ? (raw.result[0]?.candles || raw.result)
      : (Array.isArray(raw) ? raw : []);
    const out = [];
    for (const c of candleArray) {
      if (!Array.isArray(c) || c.length < 5) continue;
      const [t, o, h, l, cl] = c;
      if (!t || o == null || h == null || l == null || cl == null) continue;
      let dateObj;
      const ts = String(t);
      if (/^\d+$/.test(ts)) {
        const n = Number(ts);
        dateObj = new Date(n > 2000000000 ? n : n * 1000);
      } else {
        dateObj = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T'));
      }
      if (isNaN(dateObj.getTime())) continue;
      const timeVal = isIntraday ? Math.floor(dateObj.getTime() / 1000) : dateObj.toISOString().split('T')[0];
      out.push({
        time: timeVal,
        open: +Number(o).toFixed(2),
        high: +Number(h).toFixed(2),
        low:  +Number(l).toFixed(2),
        close: +Number(cl).toFixed(2)
      });
    }
    return out;
  };

  // --- Fetch Yahoo Finance historical data ---
  try {
      const instKey = instrumentKey({ exchange, instrumentId });
      const liveQuote = session.quotes.find(q => instrumentKey(q) === instKey);
      const knownInst = knownInstruments.get(instKey);
      const symbolName = liveQuote?.symbol || knownInst?.symbol || '';
      
      if (!symbolName) throw new Error('Unknown symbol');

      // Strip exchange suffixes before building Yahoo ticker (e.g. "RELIANCE-EQ" -> "RELIANCE")
      const cleanSymbol = symbolName.replace(/-(EQ|BE|BZ|SM|ST|IL|IV|N1|N2|N3|N4|N5|N6|N7|N8)$/i, '').trim();
      const isNSE = exchange.startsWith('NSE') || exchange === 'NSEEQ';
      const isBSE = exchange.startsWith('BSE') || exchange === 'BSEEQ';
      const yahooSymbol = isNSE ? `${cleanSymbol}.NS` : isBSE ? `${cleanSymbol}.BO` : cleanSymbol;
      
      // Yahoo Finance chart API parameters
      let range, interval;
      switch(timeframe) {
        case '1D':  range = '1d';  interval = '5m';  break;
        case '1M':  range = '1mo'; interval = '1d';  break;
        case '1Y':  range = '1y';  interval = '1d';  break;
        case '10Y': range = '10y'; interval = '1mo'; break;
        case '20Y': range = 'max'; interval = '1mo'; break;
        default:    range = '1d';  interval = '5m';  break;
      }

      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${interval}`;
      const yahooRes = await axios.get(yahooUrl, { timeout: 10000 });
      const chartResult = yahooRes.data?.chart?.result?.[0];
      
      if (!chartResult) throw new Error('Yahoo returned no chart data');

      const timestamps = chartResult.timestamp || [];
      const quote = chartResult.indicators?.quote?.[0] || {};
      const opens = quote.open || [];
      const highs = quote.high || [];
      const lows = quote.low || [];
      const closes = quote.close || [];
      const isIntraday = timeframe === '1D';

      let formatted = [];
      for (let i = 0; i < timestamps.length; i++) {
        const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
        if (o == null || h == null || l == null || c == null) continue;
        
        const dateObj = new Date(timestamps[i] * 1000);
        const timeVal = isIntraday 
          ? timestamps[i]  // already unix seconds
          : dateObj.toISOString().split('T')[0];
        
        formatted.push({
          time: timeVal,
          open: +Number(o).toFixed(2),
          high: +Number(h).toFixed(2),
          low: +Number(l).toFixed(2),
          close: +Number(c).toFixed(2)
        });
      }

      // Deduplicate and sort
      const uniqueMap = new Map();
      formatted.forEach(item => uniqueMap.set(item.time, item));
      formatted = Array.from(uniqueMap.values()).sort((a, b) => a.time > b.time ? 1 : -1);

      if (formatted.length > 0) {
        console.log(`[CHART] Yahoo Finance fallback: ${formatted.length} candles for ${yahooSymbol} (${timeframe})`);
        return res.json({ success: true, source: 'yahoo', data: formatted });
      }
      throw new Error('No valid candles from Yahoo');
    } catch (yahooErr) {
      console.warn('[CHART] Yahoo Finance fallback also failed:', yahooErr.message);
      return res.json({ success: false, error: 'Chart data unavailable. Connect to IIFL or try again later.' });
    }
});

app.get('/auth/login', (req, res) => {
  browserSession(req, res);
  if (!configured()) return res.status(503).send('IIFL is not configured. Add IIFL_APP_KEY, IIFL_APP_SECRET, and IIFL_REDIRECT_URI to server/.env, then restart the server.');
  const authUrl = `${CONFIG.marketsUrl}/?v=1&appkey=${encodeURIComponent(CONFIG.appKey)}&redirecturl=${CONFIG.redirectUri}`;
  res.redirect(authUrl);
});

app.post('/api/auth/logout', (req, res) => {
  const session = browserSession(req, res);
  clearSession(session, 'Logged out by user.');
  res.json(publicSession(session));
});

app.get('/auth/callback', async (req, res) => {
  const session = browserSession(req, res);
  const code = req.query.code || req.query.authCode || req.query.authcode;
  if (!code || typeof code !== 'string') return res.status(400).send('IIFL did not provide an authorization code.');
  try {
    await exchangeAuthorizationCode(code, callbackClientId(req), session);
    await refreshLiveQuotes(session);
    res.redirect('/');
  } catch (error) {
    clearSession(session, 'IIFL authentication failed.');
    console.error('[IIFL auth] Token exchange failed:', error.response?.status || error.message);
    res.status(401).send('IIFL authentication could not be completed. Check the server logs and your registered redirect URI.');
  }
});

app.get('*', sendTerminal);

// ---------------------------------------------------------------------------
// HTTP + WebSocket server startup
// ---------------------------------------------------------------------------
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const session = browserSessions.get(GLOBAL_SESSION_ID);

  session.wsClients.add(ws);
  console.log(`[WS] Client connected (${session.wsClients.size} client(s), mode: ${session.mode})`);

  // Send initial state immediately
  ws.send(JSON.stringify({
    type: 'init',
    sessionId: session.id,
    quotes: session.quotes,
    actionWatch: session.actionWatch,
    session: publicSession(session),
    watchlist: publicWatchlist(session),
    timestamp: new Date().toISOString(),
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch (_) { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    session.wsClients.delete(ws);
    console.log(`[WS] Client disconnected (session ${session.id.slice(0, 8)}…, ${session.wsClients.size} remaining)`);
  });

  ws.on('error', () => {
    session.wsClients.delete(ws);
  });
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Trader Terminal running at http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`WebSocket endpoint: ws://localhost:${CONFIG.port}/ws`);
  console.log(configured() ? 'IIFL credentials detected; awaiting daily browser login.' : 'Simulation mode; add server/.env to enable IIFL login.');
  startPolling();
  nseScraper.startNSEScraper(5 * 60 * 1000);
  
  // Pre-load full NSEEQ contract catalog from IIFL (2000+ stocks)
  contractsFor('NSEEQ').then((instruments) => {
    instruments.forEach((inst) => {
      knownInstruments.set(instrumentKey(inst), inst);
    });
    console.log(`[IIFL Catalog] ✅ Pre-loaded ${instruments.length} NSEEQ instruments into memory.`);
  }).catch((err) => {
    console.warn('[IIFL Catalog] ⚠️ Could not pre-load NSEEQ contracts:', err.message);
  });

  // Initialize dynamic Sensex mapping and refresh it every 24 hours
  fetchSensexToken();
  setInterval(fetchSensexToken, 24 * 60 * 60 * 1000);
});

