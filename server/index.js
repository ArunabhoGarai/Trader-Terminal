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

loadDotEnv(path.join(__dirname, '.env'));

const CONFIG = {
  port: Number(process.env.PORT || 3001),
  apiBaseUrl: (process.env.IIFL_API_BASE_URL || 'https://api.iiflcapital.com/v1').replace(/\/$/, ''),
  marketsUrl: (process.env.IIFL_MARKETS_URL || 'https://markets.iiflcapital.com').replace(/\/$/, ''),
  appKey: process.env.IIFL_APP_KEY || '',
  appSecret: process.env.IIFL_APP_SECRET || '',
  redirectUri: process.env.IIFL_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/auth/callback`,
  quotePollMs: Math.max(Number(process.env.IIFL_QUOTE_POLL_MS || 2500), 1000),
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
function makeSimulationQuote(instrument, position = 0) {
  const direction = [-.44, 1.43, .51, -1.11, -.83, 1.82, -2.85, .21, .32, .06, .35, 1.01, -.21, 2.14, 1.08, .82, .53, -.47, .16, .72][position % 20] || .1;
  const basePrice = number(instrument.basePrice, 100 + ((position + 1) * 41));
  const close = basePrice / (1 + direction / 100);
  const spread = Math.max(basePrice * .00035, .05);
  const high = Math.max(basePrice, close * (1 + ((position % 5) - 2) / 1000), basePrice + spread) * 1.001;
  const low = Math.max(0, Math.min(basePrice, close * (1 + ((position % 5) - 2) / 1000), basePrice - spread)) * 0.999;
  return {
    instrumentId: String(instrument.instrumentId), symbol: instrument.symbol, exchange: instrument.exchange, segment: instrument.segment || segmentLabel(instrument.exchange),
    lastPrice: basePrice, pctChange: direction, close,
    open: close * (1 + ((position % 5) - 2) / 1000), high,
    low, bestBidPrice: Math.max(0, basePrice - spread),
    bestBidQty: 80 + position * 53, bestAskPrice: basePrice + spread,
    bestAskQty: 100 + position * 61, tradedVolume: 70000 + position * 12431,
    week52High: basePrice * (1.035 + (position % 3) * .02),
    week52Low: basePrice * (.70 + (position % 4) * .025), updatedAt: new Date().toISOString(),
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
  const ltp = extract(raw, ['ltp', 'lastPrice', 'lastTradedPrice', 'LastTradedPrice', 'LTP'], fallback.lastPrice);
  const close = extract(raw, ['close', 'previousClose', 'pcClose', 'Close', 'PreviousClose', 'ClosePrice'], fallback.close);
  const pctChange = close ? ((ltp - close) / close) * 100 : 0;
  
  // Extract Bid/Ask handling nested structures from IIFL OpenAPI
  let bidPrice = extract(raw, ['bestBidPrice', 'BuyRate', 'buyRate', 'BuyRate1', 'buyRate1', 'buyPrice', 'buyPrice1', 'BuyPrice1', 'BidRate', 'bidRate', 'BuyPrice', 'BidPrice'], raw.Bids?.[0]?.Price ?? raw.bids?.[0]?.price ?? fallback.bestBidPrice);
  let bidQty = extract(raw, ['bestBidQty', 'bestBidQuantity', 'BuyQty', 'buyQty', 'BuyQty1', 'buyQty1', 'BidQty', 'bidQty', 'TotalBuyQty'], raw.Bids?.[0]?.Size ?? raw.bids?.[0]?.quantity ?? raw.Bids?.[0]?.Quantity ?? fallback.bestBidQty);
  
  let askPrice = extract(raw, ['bestAskPrice', 'bestAskRate', 'SellRate', 'sellRate', 'SellRate1', 'sellRate1', 'sellPrice', 'sellPrice1', 'SellPrice1', 'AskRate', 'askRate', 'SellPrice', 'OfferRate', 'AskPrice'], raw.Asks?.[0]?.Price ?? raw.asks?.[0]?.price ?? fallback.bestAskPrice);
  let askQty = extract(raw, ['bestAskQty', 'bestAskQuantity', 'SellQty', 'sellQty', 'SellQty1', 'sellQty1', 'AskQty', 'askQty', 'OfferQty', 'TotalSellQty'], raw.Asks?.[0]?.Size ?? raw.asks?.[0]?.quantity ?? raw.Asks?.[0]?.Quantity ?? fallback.bestAskQty);

  // SANITY CHECK: If depth rates deviate by > 5% from LTP, they are likely stale fallbacks or bad data. Recalculate them synthetically around the live LTP.
  if (ltp > 0) {
    const spread = Math.max(ltp * 0.00035, 0.05);
    if (Math.abs(bidPrice - ltp) / ltp > 0.05) bidPrice = +(ltp - spread).toFixed(2);
    if (Math.abs(askPrice - ltp) / ltp > 0.05) askPrice = +(ltp + spread).toFixed(2);
  }

  return {
    ...fallback,
    instrumentId: String(raw.instrumentId ?? raw.token ?? raw.ExchangeInstrumentID ?? raw.ExchangeInstrumentId ?? fallback.instrumentId),
    symbol: raw.symbol ?? raw.tradingSymbol ?? raw.TradingSymbol ?? fallback.symbol,
    exchange: raw.exchange ?? raw.ExchangeSegment ?? fallback.exchange,
    lastPrice: ltp,
    pctChange: extract(raw, ['pctChange', 'changePercent', 'PercentChange'], pctChange),
    close,
    open: extract(raw, ['open', 'Open', 'OpenPrice'], fallback.open), 
    high: extract(raw, ['high', 'High', 'HighPrice'], fallback.high), 
    low: extract(raw, ['low', 'Low', 'LowPrice'], fallback.low),
    bestBidPrice: bidPrice, 
    bestBidQty: bidQty,
    bestAskPrice: askPrice, 
    bestAskQty: askQty,
    tradedVolume: extract(raw, ['tradedVolume', 'totalQty', 'totalTradedQuantity', 'TotalQty', 'Volume', 'TotalTradedQuantity'], fallback.tradedVolume),
    week52High: extract(raw, ['week52High', 'FiftyTwoWeekHighPrice'], fallback.week52High), 
    week52Low: extract(raw, ['week52Low', 'FiftyTwoWeekLowPrice'], fallback.week52Low),
    updatedAt: new Date().toISOString(), position,
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
    intradayRanges: new Map(quotes.map((quote) => [instrumentKey(quote), { high: quote.high, low: quote.low }])),
    // WebSocket clients attached to this session
    wsClients: new Set(),
    // Market Scanner state
    marketScannerQuotes: new Map(),
    marketScannerCursor: 0,
    marketAnalysis: { highs: [], lows: [], gainers: [], losers: [] },
  };
}

const STATE_FILE = path.join(__dirname, 'terminal_state.json');

function loadGlobalState() {
  const session = createBrowserSession();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.accessToken) session.accessToken = data.accessToken;
      if (data.expiresAt) session.expiresAt = data.expiresAt;
      if (data.authenticatedAt) session.authenticatedAt = data.authenticatedAt;
      if (data.mode) session.mode = data.mode;
      if (data.watchlist) session.watchlist = data.watchlist;
      if (data.actionWatch) session.actionWatch = data.actionWatch;
      if (data.actionWatchDate) session.actionWatchDate = data.actionWatchDate;
      if (data.intradayRanges) session.intradayRanges = new Map(data.intradayRanges);
      
      // Rebuild initial quotes matching the loaded watchlist
      session.quotes = session.watchlist.map(makeSimulationQuote);
      if (!data.intradayRanges) {
        session.intradayRanges = new Map(session.quotes.map((q) => [instrumentKey(q), { high: q.high, low: q.low }]));
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
  return { mode: session.mode, authenticated: Boolean(session.accessToken), configured: configured(), expiresAt: session.expiresAt, pollIntervalMs: CONFIG.quotePollMs };
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
function updateActionWatch(session, previousQuotes, nextQuotes) {
  const today = indiaTradingDate();
  if (session.actionWatchDate !== today) {
    session.actionWatchDate = today;
    session.actionWatch = [];
    session.intradayRanges.clear();
  }

  const newEvents = [];
  const previous = new Map(previousQuotes.map((quote) => [instrumentKey(quote), quote]));

  for (const quote of nextQuotes) {
    const key = instrumentKey(quote);
    const priorRange = session.intradayRanges.get(key);
    const dayHigh = number(quote.high, quote.lastPrice);
    const dayLow = number(quote.low, quote.lastPrice);
    const previousClose = number(quote.close, 0);

    if (!priorRange) {
      // First time seeing this instrument today — establish baseline, no alert
      session.intradayRanges.set(key, {
        high: Math.max(dayHigh, quote.lastPrice),
        low: Math.min(dayLow, quote.lastPrice),
      });
      continue;
    }

    const isNewHigh = dayHigh > priorRange.high || quote.lastPrice > priorRange.high;
    const isNewLow = dayLow < priorRange.low || quote.lastPrice < priorRange.low;

    // Sentiment: compare LTP against PREVIOUS DAY'S CLOSE
    // Green = LTP >= previous close (positive for the day)
    // Pink  = LTP <  previous close (negative for the day)
    const direction = previousClose > 0 && quote.lastPrice < previousClose ? 'down' : 'up';

    if (isNewHigh || isNewLow) {
      const event = {
        instrumentId: String(quote.instrumentId),
        symbol: quote.symbol,
        exchange: quote.exchange,
        segment: quote.segment || segmentLabel(quote.exchange),
        status: isNewHigh ? 'New High' : 'New Low',
        lastPrice: quote.lastPrice,
        close: previousClose,
        direction,
        timestamp: quote.updatedAt || new Date().toISOString(),
        time: indiaTimeString(),
      };
      newEvents.push(event);
      session.actionWatch.unshift(event);
      if (session.actionWatch.length > ACTION_WATCH_LIMIT) session.actionWatch.length = ACTION_WATCH_LIMIT;
    }

    // Update tracked range
    session.intradayRanges.set(key, {
      high: Math.max(priorRange.high, dayHigh, quote.lastPrice),
      low: Math.min(priorRange.low, dayLow, quote.lastPrice),
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
  
  // Add market scanner chunk
  const allNse = contractCache.get('NSEEQ')?.instruments || STATIC_CATALOG;
  if (allNse.length > 0) {
    if (session.marketScannerCursor >= allNse.length) session.marketScannerCursor = 0;
    const chunk = allNse.slice(session.marketScannerCursor, session.marketScannerCursor + 100);
    session.marketScannerCursor += 100;
    chunk.forEach((inst) => {
      const k = instrumentKey(inst);
      if (!requestInstruments.has(k)) requestInstruments.set(k, { exchange: inst.exchange, instrumentId: inst.instrumentId, symbol: inst.symbol, isWatchlist: false });
    });
  }
  
  if (requestInstruments.size === 0) return { success: false, events: [] };

  try {
    const payload = Array.from(requestInstruments.values()).map(({ exchange, instrumentId }) => ({ exchange, instrumentId }));
    const response = await axios.post(`${CONFIG.apiBaseUrl}/marketdata/marketquotes`, payload, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, timeout: 15000,
    });
    
    const results = Array.isArray(response.data?.result) ? response.data.result : [];
    if (!results.length) throw new Error(response.data?.message || 'The market quote response did not contain results.');
    
    const previous = new Map(session.quotes.map((quote) => [instrumentKey(quote), quote]));
    const resultsByKey = new Map(results.map((quote) => [instrumentKey({ exchange: quote.exchange || '', instrumentId: quote.instrumentId ?? quote.token }), quote]));
    
    // Update active watchlist quotes
    const nextQuotes = session.watchlist.map((instrument, index) => {
      const fallback = previous.get(instrumentKey(instrument)) || makeSimulationQuote(instrument, index);
      const raw = resultsByKey.get(instrumentKey(instrument)) || results.find((quote) => String(quote.instrumentId ?? quote.token) === String(instrument.instrumentId));
      return raw ? quoteFromPayload(raw, fallback, index) : fallback;
    });
    
    // Update Market Scanner map
    requestInstruments.forEach((info, key) => {
      if (!info.isWatchlist) {
        const raw = resultsByKey.get(key);
        if (raw) session.marketScannerQuotes.set(key, quoteFromPayload(raw, makeSimulationQuote({ exchange: info.exchange, instrumentId: info.instrumentId, symbol: info.symbol || raw.symbol || 'Unknown' }, 0), 0));
      }
    });

    // Compute top market-wide analytics
    const allMarketQuotes = Array.from(session.marketScannerQuotes.values());
    session.marketAnalysis.highs = [...allMarketQuotes].filter(q => q.week52High > 0 && ((q.week52High - q.lastPrice)/q.week52High)*100 <= 5).sort((a, b) => ((a.week52High - a.lastPrice)/a.week52High) - ((b.week52High - b.lastPrice)/b.week52High)).slice(0, 30);
    session.marketAnalysis.lows = [...allMarketQuotes].filter(q => q.week52Low > 0 && ((q.lastPrice - q.week52Low)/q.week52Low)*100 <= 5).sort((a, b) => ((a.lastPrice - a.week52Low)/a.week52Low) - ((b.lastPrice - b.week52Low)/b.week52Low)).slice(0, 30);
    session.marketAnalysis.gainers = [...allMarketQuotes].filter(q => q.pctChange > 0).sort((a, b) => b.pctChange - a.pctChange).slice(0, 30);
    session.marketAnalysis.losers = [...allMarketQuotes].filter(q => q.pctChange < 0).sort((a, b) => a.pctChange - b.pctChange).slice(0, 30);

    const events = updateActionWatch(session, session.quotes, nextQuotes);
    session.quotes = nextQuotes;
    return { success: true, events };
  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 403) clearSession(session, 'IIFL session expired. Sign in again to continue live data.');
    else session.lastError = 'IIFL market data request failed.';
    return { success: false, events: [] };
  }
}

// ---------------------------------------------------------------------------
// Enhanced simulation — generates visible action watch events
// ---------------------------------------------------------------------------
function advanceSimulation(session) {
  session.simCycle = (session.simCycle || 0) + 1;
  const previousQuotes = session.quotes;

  const nextQuotes = session.quotes.map((quote, index) => {
    // Every few cycles, some stocks get a bigger push to break their day range
    const isBigTick = (index + session.simCycle) % 3 === 0;
    // Occasionally simulate a gap-down recovery (pink + New High)
    const isGapDownRecovery = session.simCycle % 7 === 0 && index % 5 === 2;

    let drift;
    if (isBigTick) {
      // Force a breakout — push above high or below low
      const breakDirection = (index + session.simCycle) % 2 === 0 ? 1 : -1;
      drift = breakDirection * (0.004 + Math.random() * 0.006);
    } else {
      drift = (Math.random() - .48) * .005;
    }

    let lastPrice = +(quote.lastPrice * (1 + drift)).toFixed(2);
    if (lastPrice <= 0) lastPrice = quote.close > 0 ? quote.close : 100; // prevent zero/negative death spiral
    let close = quote.close;

    if (isGapDownRecovery && session.simCycle < 30) {
      // Simulate: stock opened below yesterday's close but is recovering upward
      // Set close higher than current price range to create "pink New High" scenario
      close = lastPrice * 1.015;
      lastPrice = +(lastPrice * 1.003).toFixed(2); // Push price up
    }

    const spread = Math.max(lastPrice * .00035, .05);
    const bestBidPrice = Math.max(0, +(lastPrice - spread).toFixed(2));
    const bestAskPrice = +(lastPrice + spread).toFixed(2);
    
    // Bounds must strictly encapsulate the Bid/Ask spread
    const high = Math.max(quote.high, lastPrice, bestAskPrice);
    const low = Math.min(quote.low || lastPrice, lastPrice, bestBidPrice);
    const pctChange = close > 0 ? +(((lastPrice - close) / close) * 100).toFixed(2) : 0;

    return {
      ...quote, lastPrice, pctChange, close, high, low,
      bestBidPrice,
      bestAskPrice,
      bestBidQty: Math.max(1, Math.round(quote.bestBidQty * (.96 + Math.random() * .08))),
      bestAskQty: Math.max(1, Math.round(quote.bestAskQty * (.96 + Math.random() * .08))),
      tradedVolume: quote.tradedVolume + Math.round(Math.random() * 2500),
      updatedAt: new Date().toISOString(),
    };
  });

  session.quotes = nextQuotes;

  // --- MARKET-WIDE SCANNER: simulate quotes for ALL known instruments, not just watchlist ---
  const watchlistKeys = new Set(nextQuotes.map(q => instrumentKey(q)));
  // Seed watchlist quotes into scanner map
  for (const q of nextQuotes) {
    session.marketScannerQuotes.set(instrumentKey(q), q);
  }
  // Simulate all catalog stocks that aren't already in the watchlist
  for (const inst of STATIC_CATALOG) {
    const key = instrumentKey(inst);
    if (watchlistKeys.has(key)) continue; // already covered by watchlist
    const existing = session.marketScannerQuotes.get(key);
    if (existing) {
      // Drift existing scanner quote
      const d = (Math.random() - 0.48) * 0.004;
      const ltp = +(existing.lastPrice * (1 + d)).toFixed(2);
      const cl = existing.close || ltp;
      const sp = Math.max(ltp * 0.00035, 0.05);
      session.marketScannerQuotes.set(key, {
        ...existing,
        lastPrice: ltp,
        pctChange: cl > 0 ? +(((ltp - cl) / cl) * 100).toFixed(2) : 0,
        high: Math.max(existing.high, ltp),
        low: Math.min(existing.low || ltp, ltp),
        bestBidPrice: Math.max(0, +(ltp - sp).toFixed(2)),
        bestAskPrice: +(ltp + sp).toFixed(2),
        tradedVolume: existing.tradedVolume + Math.round(Math.random() * 1500),
        // Keep 52W bounds realistic: if LTP exceeds old 52W high, update it; same for low
        week52High: Math.max(existing.week52High || ltp, ltp * (1 + Math.random() * 0.01)),
        week52Low: Math.min(existing.week52Low || ltp, ltp * (1 - Math.random() * 0.01)),
        updatedAt: new Date().toISOString(),
      });
    } else {
      // First time — create initial simulated quote for this scanner stock
      session.marketScannerQuotes.set(key, makeSimulationQuote(inst, inst.index || 0));
    }
  }

  // Compute market-wide analytics from the FULL scanner map (not just watchlist)
  const allMarketQuotes = Array.from(session.marketScannerQuotes.values());
  session.marketAnalysis.highs = [...allMarketQuotes].filter(q => q.week52High > 0 && ((q.week52High - q.lastPrice)/q.week52High)*100 <= 5).sort((a, b) => ((a.week52High - a.lastPrice)/a.week52High) - ((b.week52High - b.lastPrice)/b.week52High)).slice(0, 30);
  session.marketAnalysis.lows = [...allMarketQuotes].filter(q => q.week52Low > 0 && ((q.lastPrice - q.week52Low)/q.week52Low)*100 <= 5).sort((a, b) => ((a.lastPrice - a.week52Low)/a.week52Low) - ((b.lastPrice - b.week52Low)/b.week52Low)).slice(0, 30);
  session.marketAnalysis.gainers = [...allMarketQuotes].filter(q => q.pctChange > 0).sort((a, b) => b.pctChange - a.pctChange).slice(0, 30);
  session.marketAnalysis.losers = [...allMarketQuotes].filter(q => q.pctChange < 0).sort((a, b) => a.pctChange - b.pctChange).slice(0, 30);

  return updateActionWatch(session, previousQuotes, nextQuotes);
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
  for (const [, session] of browserSessions) {
    // Only poll if there are WebSocket clients listening OR if the session
    // was recently active (keep simulation running for responsiveness)
    // Always poll — even without WS clients — so REST /refresh picks up fresh data

    let newEvents = [];

    if (session.mode === 'LIVE') {
      const result = await refreshLiveQuotes(session);
      newEvents = result.events;
    } else {
      newEvents = advanceSimulation(session);
    }

    // Push updates to all connected WebSocket clients for this session
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
  
  // Persist state to disk after polling
  saveGlobalState();
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

app.get('/api/instruments', async (req, res) => {
  const exchange = String(req.query.exchange || 'NSE');
  const segment = String(req.query.segment || 'Equity');
  const query = String(req.query.q || '').slice(0, 48);
  const instruments = await searchInstruments(exchange, segment, query);
  res.json({ exchange, segment, instruments: instruments.map(publicInstrument) });
});

app.get('/api/watchlist', (req, res) => {
  const session = browserSession(req, res);
  res.json(terminalPayload(session));
});

app.post('/api/watchlist', async (req, res) => {
  const session = browserSession(req, res);
  const instrumentId = String(req.body?.instrumentId || '').trim();
  const exchange = exchangeCode(req.body?.exchange, req.body?.segment);
  const instrument = knownInstrument(exchange, instrumentId);
  if (!instrument) return res.status(422).json({ message: 'Choose a symbol from the search results before adding it.' });
  if (session.watchlist.some((item) => instrumentKey(item) === instrumentKey(instrument))) return res.status(409).json({ message: `${instrument.symbol} is already in this watchlist.` });
  if (session.watchlist.length >= MAX_WATCHLIST_SIZE) return res.status(409).json({ message: `This watchlist is full (${MAX_WATCHLIST_SIZE} scripts). Remove a scrip before adding another.` });
  const next = { ...instrument };
  session.watchlist.push(next);
  session.quotes.push(makeSimulationQuote(next, session.watchlist.length - 1));
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

app.get('/api/chart/:exchange/:instrumentId', async (req, res) => {
  const session = browserSession(req, res);
  const { exchange, instrumentId } = req.params;
  const { timeframe } = req.query; // '1D', '1M', '1Y', '10Y', '20Y'
  
  const end = new Date();
  const start = new Date();
  let compression = 60; // 1 min for intraday
  
  switch(timeframe) {
    case '1D': start.setDate(end.getDate() - 1); compression = 60; break;
    case '1M': start.setMonth(end.getMonth() - 1); compression = 86400; break; // 1 day in seconds
    case '1Y': start.setFullYear(end.getFullYear() - 1); compression = 86400; break;
    case '10Y': start.setFullYear(end.getFullYear() - 10); compression = 86400; break;
    case '20Y': start.setFullYear(end.getFullYear() - 20); compression = 86400; break;
    default: start.setDate(end.getDate() - 1); break;
  }

  const payload = {
    ExchangeSegment: exchange.includes('FO') ? 'NSEFO' : (exchange.startsWith('BSE') ? 'BSECM' : 'NSECM'),
    ExchangeInstrumentID: Number(instrumentId),
    StartTime: start.toISOString().split('.')[0],
    EndTime: end.toISOString().split('.')[0],
    CompressionValue: compression
  };

  try {
    if (!session.accessToken) throw new Error('Not authenticated');
    
    const response = await axios.post(`${CONFIG.apiBaseUrl}/marketdata/historicaldata`, payload, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, timeout: 15000,
    });
    
    if (response.data && response.data.result && response.data.result.length > 0) {
      // Map IIFL response to standard lightweight-charts format
      const isIntraday = timeframe === '1D';
      let formatted = response.data.result.map(c => {
        const d = new Date(c.time || c.Date || c.Timestamp);
        return {
          time: isIntraday ? Math.floor(d.getTime() / 1000) : d.toISOString().split('T')[0],
          open: Number(c.open || c.Open),
          high: Number(c.high || c.High),
          low: Number(c.low || c.Low),
          close: Number(c.close || c.Close)
        };
      });
      
      // TradingView demands strictly unique and ascending times
      const uniqueMap = new Map();
      formatted.forEach(item => uniqueMap.set(item.time, item));
      formatted = Array.from(uniqueMap.values()).sort((a, b) => a.time > b.time ? 1 : -1);
      
      return res.json({ success: true, data: formatted });
    }
    throw new Error('Empty or invalid response from IIFL');
  } catch (err) {
    console.warn('[CHART API] IIFL Historical Data failed, falling back to simulated data.', err.response?.data || err.message);
    
    // --- Look up actual LTP for this stock so the chart anchors to real prices ---
    const instKey = instrumentKey({ exchange, instrumentId });
    const liveQuote = session.quotes.find(q => instrumentKey(q) === instKey) || session.marketScannerQuotes.get(instKey);
    const knownInst = knownInstruments.get(instKey);
    // Use the actual current price, or fall back to the instrument's basePrice, or a default
    const currentLtp = liveQuote?.lastPrice || knownInst?.basePrice || 1000;

    // For longer timeframes, reverse-engineer a plausible starting price
    // (e.g. if 10Y ago price was ~40% of current, simulate growth toward current)
    let startingPrice;
    switch (timeframe) {
      case '1D':  startingPrice = currentLtp * (0.995 + Math.random() * 0.005); break;
      case '1M':  startingPrice = currentLtp * (0.90 + Math.random() * 0.05); break;
      case '1Y':  startingPrice = currentLtp * (0.65 + Math.random() * 0.15); break;
      case '10Y': startingPrice = currentLtp * (0.15 + Math.random() * 0.15); break;
      case '20Y': startingPrice = currentLtp * (0.05 + Math.random() * 0.10); break;
      default:    startingPrice = currentLtp * 0.99; break;
    }

    // Simulate beautiful chart data as fallback if IIFL restricts historical access
    let simulatedData = [];
    let currentPrice = startingPrice;
    let currentDate = new Date(start);
    
    // For 10Y/20Y we need monthly steps so we don't blow up the browser
    if (timeframe === '10Y' || timeframe === '20Y') {
      currentDate.setDate(1); // align to month start
    }
    
    // Calculate overall drift per step to reach the current LTP by the end
    let totalSteps = 0;
    const tmpDate = new Date(currentDate);
    while (tmpDate <= end) {
      totalSteps++;
      if (timeframe === '1D') tmpDate.setMinutes(tmpDate.getMinutes() + 5);
      else if (timeframe === '1M' || timeframe === '1Y') tmpDate.setDate(tmpDate.getDate() + 1);
      else tmpDate.setMonth(tmpDate.getMonth() + 1);
    }
    const overallGrowthRate = totalSteps > 1 ? Math.pow(currentLtp / startingPrice, 1 / totalSteps) : 1;
    
    let stepCount = 0;
    while (currentDate <= end) {
      stepCount++;
      // Skip weekends for daily data
      if (timeframe !== '1D' && (currentDate.getDay() === 0 || currentDate.getDay() === 6)) {
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }
      
      // For intraday, only generate bars during trading hours (9:15 AM - 3:30 PM IST = 3:45 - 10:00 UTC)
      if (timeframe === '1D') {
        const utcH = currentDate.getUTCHours();
        const utcM = currentDate.getUTCMinutes();
        const utcMinutes = utcH * 60 + utcM;
        // IST trading hours: 9:15-15:30 = UTC 3:45-10:00 = 225-600 minutes
        if (utcMinutes < 225 || utcMinutes > 600) {
          currentDate = new Date(currentDate.getTime() + 5 * 60000);
          continue;
        }
      }
      
      // Blend: trend-following growth + random noise
      const trendDrift = overallGrowthRate - 1;
      const noise = (Math.random() - 0.48) * (timeframe === '1D' ? 0.004 : 0.035);
      const drift = trendDrift + noise;
      
      const open = currentPrice;
      const close = +(currentPrice * (1 + drift)).toFixed(2);
      const high = +Math.max(open, close, open * (1 + Math.random() * (timeframe === '1D' ? 0.002 : 0.015))).toFixed(2);
      const low = +Math.min(open, close, open * (1 - Math.random() * (timeframe === '1D' ? 0.002 : 0.015))).toFixed(2);
      
      const timeVal = timeframe === '1D' ? Math.floor(currentDate.getTime() / 1000) : currentDate.toISOString().split('T')[0];
      simulatedData.push({
        time: timeVal,
        open: +open.toFixed(2),
        high,
        low,
        close
      });
      currentPrice = close;
      
      if (timeframe === '1D') currentDate = new Date(currentDate.getTime() + 5 * 60000);
      else if (timeframe === '1M' || timeframe === '1Y') currentDate.setDate(currentDate.getDate() + 1);
      else currentDate.setMonth(currentDate.getMonth() + 1); // 1 month steps for 10Y/20Y
    }
    
    // Deduplicate and sort fallback as well
    const uniqueMap = new Map();
    simulatedData.forEach(item => uniqueMap.set(item.time, item));
    simulatedData = Array.from(uniqueMap.values()).sort((a, b) => a.time > b.time ? 1 : -1);

    return res.json({ success: true, simulated: true, data: simulatedData });
  }
});

app.get('/auth/login', (req, res) => {
  browserSession(req, res);
  if (!configured()) return res.status(503).send('IIFL is not configured. Add IIFL_APP_KEY, IIFL_APP_SECRET, and IIFL_REDIRECT_URI to server/.env, then restart the server.');
  const authUrl = `${CONFIG.marketsUrl}/?v=1&appkey=${encodeURIComponent(CONFIG.appKey)}&redirecturl=${CONFIG.redirectUri}`;
  res.redirect(authUrl);
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

server.listen(CONFIG.port, () => {
  console.log(`Trader Terminal running at http://localhost:${CONFIG.port}`);
  console.log(`WebSocket endpoint: ws://localhost:${CONFIG.port}/ws`);
  console.log(configured() ? 'IIFL credentials detected; awaiting daily browser login.' : 'Simulation mode; add server/.env to enable IIFL login.');
  startPolling();
});
