/**
 * IIFL Markets API gateway for the trader-terminal UI.
 *
 * Credentials and access tokens remain server-side. Each browser receives an
 * isolated session containing its own active watchlist and token. Sessions are
 * persisted to disk so the watchlist survives server restarts.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const axios = require('axios');
const express = require('express');

loadDotEnv(path.join(__dirname, '.env'));

const CONFIG = {
  port: Number(process.env.PORT || 3001),
  apiBaseUrl: (process.env.IIFL_API_BASE_URL || 'https://api.iiflcapital.com/v1').replace(/\/$/, ''),
  marketsUrl: (process.env.IIFL_MARKETS_URL || 'https://markets.iiflcapital.com').replace(/\/$/, ''),
  appKey: process.env.IIFL_APP_KEY || '',
  appSecret: process.env.IIFL_APP_SECRET || '',
  redirectUri: process.env.IIFL_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/auth/callback`,
  quotePollMs: Math.max(Number(process.env.IIFL_QUOTE_POLL_MS || 3500), 1000),
};

const MAX_WATCHLIST_SIZE = 400;
const ACTION_WATCH_LIMIT = 120;
const SESSION_COOKIE = 'tt_session';
const CONTRACT_CACHE_MS = 30 * 60 * 1000;

// Directory where per-session watchlists are persisted across server restarts.
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Pre-defined watchlist of 74 scrips ──────────────────────────────────────
// Format: [symbol, instrumentId, basePrice]
// instrumentId values are NSE Equity token IDs for the listed symbols.
// If a live token lookup resolves a different ID the instrument search will
// still work because the server also queries the IIFL contract files.
const DEFAULT_SPECS = [
  ['ABCAPITAL',    '1',      200.00],
  ['AKSHOPTFBR',   '2',       50.00],
  ['ATGL',         '3',      800.00],
  ['BAJAJHCARE',   '4',      600.00],
  ['BAJAJHFL',     '5',       80.00],
  ['BAJAJHIND',    '317',    200.00],
  ['BEML',         '438',   4500.00],
  ['BHARATCOAL',   '7',      300.00],
  ['BPCL',         '526',    285.60],
  ['CONCOR',       '694',   1000.00],
  ['CYIENTDLM',    '10',     600.00],
  ['DALMIASUG',    '11',     500.00],
  ['DIACABS',      '12',     200.00],
  ['DCXINDIA',     '13',     350.00],
  ['EMSLIMITED',   '14',     800.00],
  ['EPACK',        '15',     300.00],
  ['EXIDEIND',     '500086', 460.00],
  ['FEDERALBNK',   '1023',   190.00],
  ['GANDHAR',      '17',     200.00],
  ['GMDCLTD',      '18',     350.00],
  ['GUJENERGY',    '19',     700.00],
  ['HARSHA',       '20',     600.00],
  ['HDFCAMC',      '4306',  3950.00],
  ['HUDCO',        '22',     250.00],
  ['ICIL',         '23',     300.00],
  ['IFL-EQ',       '24',     100.00],
  ['INDUSINDBK',   '5258',  1560.00],
  ['IONEXCHANG',   '26',     450.00],
  ['IOCLP',        '27',     150.00],
  ['IRB',          '28',     900.00],
  ['JINDWORLD',    '29',    1500.00],
  ['JKTYRE',       '30',     300.00],
  ['KITEX',        '31',     400.00],
  ['KNRCON',       '32',     350.00],
  ['LXCHEM',       '33',     500.00],
  ['MANAPPURAM',   '34',     200.00],
  ['NATIONALUM',   '35',     220.00],
  ['NESTLEIND',    '17963', 2200.00],
  ['NEWGEN',       '37',    1200.00],
  ['NFL',          '38',     100.00],
  ['NOCIL',        '39',     300.00],
  ['NYKAA',        '40',     200.00],
  ['OLAELEC',      '41',     100.00],
  ['ORIENTTECH',   '42',     400.00],
  ['OSWALPUMPS',   '43',     200.00],
  ['PCBL',         '44',     350.00],
  ['PCJEWELLER',   '45',     100.00],
  ['PRAJIND',      '46',     700.00],
  ['QUESS',        '47',     800.00],
  ['QUICKHEAL-BE', '48',     250.00],
  ['RAIN',         '49',     200.00],
  ['RAJSREESUG',   '50',     150.00],
  ['RCF',          '51',     150.00],
  ['RUPA',         '52',     350.00],
  ['SAKSOFT',      '53',     900.00],
  ['SDBL',         '54',     200.00],
  ['SHAKTIPUMP',   '55',     900.00],
  ['SHAREINDIA',   '56',     350.00],
  ['SPIC',         '57',     100.00],
  ['SUBEXLTD-BE',  '58',     100.00],
  ['SWSOLAR',      '59',     400.00],
  ['TALBROAUTO',   '60',     100.00],
  ['TANLA',        '61',     900.00],
  ['TATAINVEST',   '62',    1200.00],
  ['TATASTEEL',    '3499',   153.00],
  ['TEJASNET',     '64',     800.00],
  ['TEXRAIL',      '65',     200.00],
  ['TTML',         '66',      80.00],
  ['VEDL',         '67',     400.00],
  ['VEDPOWER',     '68',     150.00],
  ['VISL',         '69',     100.00],
  ['VOGL',         '70',     200.00],
  ['VPRPL-BE',     '71',     100.00],
  ['ZENSARTECH',   '72',     700.00],
];

const EXTRA_NSE_SPECS = [
  ['ABB', '13', 687.55], ['ACC', '22', 1345.15], ['SBILIFE', '21808', 3160.55],
  ['BHEL', '438', 832.05], ['BPCL', '526', 285.60], ['RELIANCE', '2885', 561.00],
  ['GRASIM', '1232', 96.70], ['AMBUJACEM', '1270', 313.90], ['HDFCBANK', '1333', 1299.00],
  ['HEROMOTOCO', '1348', 160.30], ['HINDALCO', '1363', 306.00], ['HINDUNILVR', '1394', 418.00],
  ['INFY', '1594', 669.00], ['ITC', '1660', 65.00], ['M&M', '2031', 720.00],
  ['ONGC', '2475', 720.00], ['TCS', '11536', 3802.40], ['ICICIBANK', '4963', 1270.70],
  ['TATAMOTORS', '3456', 760.15], ['SUNPHARMA', '3351', 1680.80],
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

const DEFAULT_WATCHLIST = []; // Users build their own watchlist via the Add Scrip menu
const STATIC_CATALOG = [...DEFAULT_SPECS, ...EXTRA_NSE_SPECS].map(makeInstrument);
const knownInstruments = new Map(STATIC_CATALOG.map((instrument) => [instrumentKey(instrument), instrument]));
const contractCache  = new Map();
const screenerCache  = new Map(); // exchange -> { at, data }  (10-min TTL)
const browserSessions = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: 'index.html' }));

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

function makeSimulationQuote(instrument, position = 0) {
  const direction = [-.44, 1.43, .51, -1.11, -.83, 1.82, -2.85, .21, .32, .06, .35, 1.01, -.21, 2.14, 1.08, .82, .53, -.47, .16, .72][position % 20] || .1;
  const basePrice = number(instrument.basePrice, 100 + ((position + 1) * 41));
  const close = basePrice / (1 + direction / 100);
  const spread = Math.max(basePrice * .00035, .05);
  return {
    instrumentId: String(instrument.instrumentId), symbol: instrument.symbol, exchange: instrument.exchange, segment: instrument.segment || segmentLabel(instrument.exchange),
    lastPrice: basePrice, pctChange: direction, close,
    open: close * (1 + ((position % 5) - 2) / 1000), high: basePrice * 1.013,
    low: basePrice * .988, bestBidPrice: basePrice - spread,
    bestBidQty: 80 + position * 53, bestAskPrice: basePrice + spread,
    bestAskQty: 100 + position * 61, tradedVolume: 70000 + position * 12431,
    week52High: basePrice * (1.035 + (position % 3) * .02),
    week52Low: basePrice * (.70 + (position % 4) * .025), updatedAt: new Date().toISOString(),
  };
}

function quoteFromPayload(raw, fallback, position) {
  // safeNum: returns the parsed value only when it is a positive finite number.
  // Price fields that IIFL returns as 0 when unavailable must NOT overwrite the
  // previous good value stored in `fallback`.
  const safeNum = (v, fb) => {
    const n = Number(v ?? -1);
    return (Number.isFinite(n) && n > 0) ? n : (Number.isFinite(Number(fb)) && Number(fb) > 0 ? Number(fb) : 0);
  };

  const ltp   = safeNum(raw.ltp ?? raw.lastPrice ?? raw.lastTradedPrice, fallback.lastPrice);
  const close = safeNum(raw.close ?? raw.previousClose ?? raw.pcClose, fallback.close ?? fallback.lastPrice);

  // Prefer the API's own pctChange; derive from ltp/close only as last resort
  const pctChange = (raw.pctChange != null && Number.isFinite(Number(raw.pctChange)))
    ? Number(raw.pctChange)
    : (raw.changePercent != null && Number.isFinite(Number(raw.changePercent)))
      ? Number(raw.changePercent)
      : (close > 0 ? ((ltp - close) / close) * 100 : 0);

  return {
    ...fallback,
    instrumentId:  String(raw.instrumentId ?? raw.token ?? fallback.instrumentId),
    symbol:        raw.symbol ?? raw.tradingSymbol ?? fallback.symbol,
    exchange:      raw.exchange ?? fallback.exchange,
    lastPrice:     ltp,
    pctChange,
    close,
    open:          safeNum(raw.open,                              fallback.open),
    high:          safeNum(raw.high,                              fallback.high),
    low:           safeNum(raw.low,                               fallback.low),
    bestBidPrice:  safeNum(raw.bestBidPrice,                      fallback.bestBidPrice),
    bestBidQty:    number(raw.bestBidQty ?? raw.bestBidQuantity,   fallback.bestBidQty),
    bestAskPrice:  safeNum(raw.bestAskPrice ?? raw.bestAskRate,    fallback.bestAskPrice),
    bestAskQty:    number(raw.bestAskQty ?? raw.bestAskQuantity,   fallback.bestAskQty),
    tradedVolume:  number(raw.tradedVolume ?? raw.totalQty ?? raw.totalTradedQuantity, fallback.tradedVolume),
    week52High:    safeNum(raw.week52High,                         fallback.week52High),
    week52Low:     safeNum(raw.week52Low,                          fallback.week52Low),
    updatedAt:     new Date().toISOString(),
    position,
  };
}

// ─── Session persistence helpers ─────────────────────────────────────────────

function sessionFilePath(sessionId) {
  return path.join(DATA_DIR, `session_${sessionId}.json`);
}

/** Persist the mutable parts of a session that should survive server restarts. */
function saveSession(session) {
  try {
    const record = {
      id: session.id,
      watchlist: session.watchlist,
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      authenticatedAt: session.authenticatedAt,
      mode: session.mode,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(sessionFilePath(session.id), JSON.stringify(record, null, 2), 'utf8');
  } catch (_) { /* Non-fatal – in-memory session continues to work */ }
}

/** Load a persisted session record from disk, or null if not found / corrupt. */
function loadSessionRecord(sessionId) {
  try {
    const filePath = sessionFilePath(sessionId);
    if (!fs.existsSync(filePath)) return null;
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!record || record.id !== sessionId) return null;
    return record;
  } catch (_) { return null; }
}

function createBrowserSession(savedRecord) {
  // Restore watchlist from disk if a saved record exists, otherwise use defaults.
  let watchlist;
  if (savedRecord && Array.isArray(savedRecord.watchlist) && savedRecord.watchlist.length) {
    // ── Migration: wipe sessions that contain ONLY old placeholder IDs (1–100) ──
    // These were the fake default IDs assigned before real IIFL token resolution
    // was implemented. Wiping them is safe — the user will re-add scrips from the
    // Add Scrip menu and get correct real IDs from the IIFL contract file.
    const allPlaceholder = savedRecord.watchlist.every(
      (item) => Number(item.instrumentId) > 0 && Number(item.instrumentId) <= 100
    );
    if (allPlaceholder) {
      console.log('[session] Detected old placeholder watchlist — resetting to empty for clean start');
      watchlist = [];
    } else {
      watchlist = savedRecord.watchlist.map((item) => ({ ...item }));
      // Re-register any saved instruments into the known-instruments map so that
      // add/remove operations continue to work after a server restart.
      watchlist.forEach((instrument) => knownInstruments.set(instrumentKey(instrument), instrument));
    }
  } else {
    watchlist = []; // Always start empty; users add scrips manually
  }
  const quotes = watchlist.map(makeSimulationQuote);

  // Restore authentication state from the saved record (tokens may be expired,
  // that is resolved when a live refresh attempt fails with 401/403).
  const mode = savedRecord?.mode === 'LIVE' ? 'LIVE' : 'SIMULATION';
  const accessToken = savedRecord?.accessToken || null;
  const expiresAt = savedRecord?.expiresAt || null;
  const authenticatedAt = savedRecord?.authenticatedAt || null;

  return {
    id: savedRecord?.id || crypto.randomUUID(),
    accessToken, expiresAt, authenticatedAt,
    mode, lastError: null,
    watchlist, quotes, actionWatch: [],
    actionWatchDate: indiaTradingDate(),
    idsResolved: false,
    // Initialise intraday ranges from the CURRENT PRICE, not the wide simulation high/low.
    // This ensures any genuine price movement from the opening price triggers an alert.
    intradayRanges: new Map(quotes.map((quote) => [instrumentKey(quote), { high: quote.lastPrice, low: quote.lastPrice }])),
  };
}

// ─── Cookie & session management ─────────────────────────────────────────────

function readCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((pair) => {
    const index = pair.indexOf('=');
    return [pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function browserSession(req, res) {
  const id = readCookies(req)[SESSION_COOKIE];

  // 1. In-memory hit (fastest path – no disk I/O)
  if (id && browserSessions.has(id)) return browserSessions.get(id);

  // 2. Restore from disk (survives server restarts)
  const savedRecord = id ? loadSessionRecord(id) : null;
  const session = createBrowserSession(savedRecord);

  // If the saved record had an ID, keep it so the browser cookie stays valid.
  if (savedRecord?.id) session.id = savedRecord.id;

  browserSessions.set(session.id, session);
  const secure = CONFIG.redirectUri.startsWith('https://') ? '; Secure' : '';
  // maxAge = 30 days so the cookie outlives browser restarts
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);

  // Persist so it is available on the next server start even if the browser
  // never modifies the watchlist.
  saveSession(session);

  return session;
}

function publicSession(session) {
  // Use faster polling in LIVE mode (2 s) so the market watch feels real-time.
  // In simulation mode 4 s is fine — no external API calls are needed.
  const pollIntervalMs = session.mode === 'LIVE' ? 2000 : 4000;
  return {
    mode: session.mode,
    authenticated: Boolean(session.accessToken),
    configured: configured(),
    expiresAt: session.expiresAt,
    pollIntervalMs,
  };
}

function publicWatchlist(session) {
  return { count: session.watchlist.length, max: MAX_WATCHLIST_SIZE, items: session.watchlist.map(publicInstrument) };
}

function terminalPayload(session) {
  return { quotes: session.quotes, session: publicSession(session), watchlist: publicWatchlist(session), actionWatch: session.actionWatch };
}

function indiaTradingDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function updateActionWatch(session, previousQuotes, nextQuotes) {
  const today = indiaTradingDate();
  if (session.actionWatchDate !== today) {
    session.actionWatchDate = today;
    session.actionWatch = [];
    session.intradayRanges.clear();
  }
  const previous = new Map(previousQuotes.map((quote) => [instrumentKey(quote), quote]));
  for (const quote of nextQuotes) {
    const key        = instrumentKey(quote);
    const priorQuote = previous.get(key);
    const priorRange = session.intradayRanges.get(key);

    if (!priorRange) {
      // First time we see this instrument — set the baseline from the current price
      session.intradayRanges.set(key, { high: quote.lastPrice, low: quote.lastPrice });
      continue;
    }

    // Compare lastPrice directly against the running intraday high/low so that
    // genuine price breaches (not just the wide initial simulation range) fire alerts.
    const isNewHigh = quote.lastPrice > priorRange.high;
    const isNewLow  = quote.lastPrice < priorRange.low;

    // Tick direction: is the last price higher or lower than the previous tick?
    const prevLtp  = number(priorQuote?.lastPrice, quote.lastPrice);
    const direction = quote.lastPrice > prevLtp ? 'up' : quote.lastPrice < prevLtp ? 'down' : 'flat';

    if (isNewHigh || isNewLow) {
      const entry = {
        instrumentId: String(quote.instrumentId),
        symbol:       quote.symbol,
        exchange:     quote.exchange,
        segment:      quote.segment || segmentLabel(quote.exchange),
        status:       isNewHigh ? 'New High' : 'New Low',
        lastPrice:    quote.lastPrice,
        direction,
        timestamp:    quote.updatedAt || new Date().toISOString(),
      };
      // Deduplicate: if the same scrip already has an entry for the same status at the top,
      // update it in-place instead of prepending a duplicate.
      const topIdx = session.actionWatch.findIndex(
        (e) => e.instrumentId === entry.instrumentId && e.exchange === entry.exchange && e.status === entry.status
      );
      if (topIdx >= 0) {
        session.actionWatch[topIdx] = entry; // update price + timestamp in place
      } else {
        session.actionWatch.unshift(entry);
        if (session.actionWatch.length > ACTION_WATCH_LIMIT) session.actionWatch.length = ACTION_WATCH_LIMIT;
      }
    }

    // Update the running intraday range
    session.intradayRanges.set(key, {
      high: Math.max(priorRange.high, quote.lastPrice),
      low:  Math.min(priorRange.low,  quote.lastPrice),
    });
  }
}

function clearSession(session, message) {
  session.accessToken = null;
  session.expiresAt = null;
  session.authenticatedAt = null;
  session.mode = 'SIMULATION';
  session.lastError = message || null;
  saveSession(session);
}

function advanceSimulation(session) {
  const previousQuotes = session.quotes;
  const nextQuotes = session.quotes.map((quote) => {
    const drift = (Math.random() - .497) * .0018;
    const lastPrice = +(quote.lastPrice * (1 + drift)).toFixed(2);
    const pctChange = +(((lastPrice - quote.close) / quote.close) * 100).toFixed(2);
    const spread = Math.max(lastPrice * .00035, .05);
    return { ...quote, lastPrice, pctChange, high: Math.max(quote.high, lastPrice), low: Math.min(quote.low, lastPrice), bestBidPrice: +(lastPrice - spread).toFixed(2), bestAskPrice: +(lastPrice + spread).toFixed(2), bestBidQty: Math.max(1, Math.round(quote.bestBidQty * (.96 + Math.random() * .08))), bestAskQty: Math.max(1, Math.round(quote.bestAskQty * (.96 + Math.random() * .08))), tradedVolume: quote.tradedVolume + Math.round(Math.random() * 2500), updatedAt: new Date().toISOString() };
  });
  session.quotes = nextQuotes;
  updateActionWatch(session, previousQuotes, nextQuotes);
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
  session.actionWatch = [];
  session.actionWatchDate = indiaTradingDate();
  session.intradayRanges.clear();
  // Reset so real instrument IDs get re-resolved on the next live refresh
  session.idsResolved = false;
  saveSession(session);
}

async function refreshLiveQuotes(session) {
  if (!session.accessToken || !session.watchlist.length) return false;

  // On the first live refresh (or after re-auth), resolve real IIFL instrument IDs
  // for any watchlist item that has a placeholder / incorrect token.
  if (!session.idsResolved) {
    session.idsResolved = true; // Set early to avoid concurrent duplicate resolution
    await resolveWatchlistIds(session);
  }

  const instruments = session.watchlist.map(({ exchange, instrumentId }) => ({ exchange, instrumentId }));
  try {
    const response = await axios.post(`${CONFIG.apiBaseUrl}/marketdata/marketquotes`, instruments, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, timeout: 15000,
    });
    const results = Array.isArray(response.data?.result) ? response.data.result : [];
    if (!results.length) throw new Error(response.data?.message || 'The market quote response did not contain results.');
    const previous = new Map(session.quotes.map((quote) => [instrumentKey(quote), quote]));
    // Build lookup by token key (exchange:instrumentId)
    const resultsByKey = new Map(results.map((q) => [
      instrumentKey({ exchange: q.exchange || '', instrumentId: q.instrumentId ?? q.token }), q,
    ]));
    const nextQuotes = session.watchlist.map((instrument, index) => {
      const fallback = previous.get(instrumentKey(instrument)) || makeSimulationQuote(instrument, index);
      // Match: 1) by exchange+token, 2) by token alone, 3) by symbol name
      const raw = resultsByKey.get(instrumentKey(instrument))
        || results.find((q) => String(q.instrumentId ?? q.token) === String(instrument.instrumentId))
        || results.find((q) => (q.symbol ?? q.tradingSymbol ?? '').toUpperCase() === instrument.symbol.toUpperCase());
      return raw ? quoteFromPayload(raw, fallback, index) : fallback;
    });
    updateActionWatch(session, session.quotes, nextQuotes);
    session.quotes = nextQuotes;
    return true;
  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      clearSession(session, 'IIFL session expired. Sign in again to continue live data.');
    } else {
      session.lastError = `IIFL market data request failed: ${error.message}`;
      console.error('[live quotes]', error.message);
    }
    return false;
  }
}

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

async function contractsFor(code, accessToken = null) {
  const cached = contractCache.get(code);
  if (cached && Date.now() - cached.at < CONTRACT_CACHE_MS) return cached.instruments;
  try {
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    const response = await axios.get(`${CONFIG.apiBaseUrl}/contractfiles/${code}.json`, { headers, timeout: 20000 });
    const instruments = contractRows(response.data).map((row, index) => normaliseContract(row, code, index)).filter(Boolean);
    contractCache.set(code, { at: Date.now(), instruments });
    return instruments;
  } catch (error) {
    return [];
  }
}

/**
 * Resolve real IIFL instrument IDs for all watchlist items by looking them up
 * in the official IIFL contract files (downloaded with auth).
 *
 * Many default-watchlist items were initialised with placeholder IDs (1–74).
 * This function replaces those with the actual exchange tokens so that live
 * marketquotes and historicaldata calls work correctly.
 *
 * Called once per LIVE session (flag: session.idsResolved).
 */
async function resolveWatchlistIds(session) {
  // Group watchlist items by exchange code
  const codeSet = new Set(session.watchlist.map((i) => i.exchange));
  let resolvedCount = 0;

  for (const code of codeSet) {
    // Use auth token so contract files requiring auth are accessible
    const contracts = await contractsFor(code, session.accessToken);
    if (!contracts.length) {
      console.warn(`[live] No contract data for ${code} – instrument IDs may be incorrect`);
      continue;
    }
    const bySymbol = new Map(contracts.map((c) => [c.symbol.toUpperCase(), c]));

    for (let idx = 0; idx < session.watchlist.length; idx++) {
      const item = session.watchlist[idx];
      if (item.exchange !== code) continue;
      const real = bySymbol.get(item.symbol.toUpperCase());
      if (!real || real.instrumentId === item.instrumentId) continue;

      const oldKey = instrumentKey(item);
      const oldId  = item.instrumentId;
      item.instrumentId = real.instrumentId;
      item.basePrice    = number(real.basePrice, item.basePrice);
      item.displayName  = real.displayName || item.displayName || item.symbol;
      knownInstruments.set(instrumentKey(item), item);

      // Update the matching quote object so key-based lookups keep working
      const qIdx = session.quotes.findIndex(
        (q) => q.symbol === item.symbol && q.exchange === item.exchange
      );
      if (qIdx >= 0) {
        session.quotes[qIdx] = { ...session.quotes[qIdx], instrumentId: item.instrumentId };
        // Re-key the intraday range entry
        const range = session.intradayRanges.get(oldKey);
        if (range) {
          session.intradayRanges.delete(oldKey);
          session.intradayRanges.set(instrumentKey(item), range);
        }
      }
      resolvedCount++;
      console.log(`[live] ${item.symbol}: ID ${oldId} → ${item.instrumentId}`);
    }
  }

  if (resolvedCount > 0) {
    console.log(`[live] ✓ Resolved ${resolvedCount} instrument IDs from IIFL contract files`);
    saveSession(session); // Persist corrected IDs so they survive server restarts
  } else {
    console.log('[live] Instrument ID resolution complete – all IDs already current');
  }
  return resolvedCount;
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
  instruments.forEach((instrument) => unique.set(instrumentKey(instrument), instrument));
  return [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)).slice(0, 15);
}

function knownInstrument(exchange, instrumentId) {
  return knownInstruments.get(instrumentKey({ exchange, instrumentId }));
}

function sendTerminal(_req, res) {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
}

// ─── Helpers for chart / 52W routes ─────────────────────────────────────────

/**
 * Format a Date as "DD-Mon-YYYY" which IIFL historicaldata expects.
 * e.g. "19-Sep-2024"
 */
function iiflDateStr(date) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = date instanceof Date ? date : new Date(date);
  return `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

/**
 * Map a period label (7d, 1m, 1y, lifetime) to IIFL interval + fromDate/toDate.
 */
function chartRange(period) {
  const now = new Date();
  const toDate = iiflDateStr(now);
  const map = {
    '7d':       { interval: '1 day',    fromDate: iiflDateStr(new Date(now - 7 * 864e5)) },
    '1m':       { interval: '1 day',    fromDate: iiflDateStr(new Date(now - 30 * 864e5)) },
    '1y':       { interval: '1 week',   fromDate: iiflDateStr(new Date(now - 365 * 864e5)) },
    'lifetime': { interval: '1 month',  fromDate: iiflDateStr(new Date(now - 3650 * 864e5)) },
  };
  const { interval, fromDate } = map[period] || map['1m'];
  return { interval, fromDate, toDate };
}

/**
 * Parse the IIFL historicaldata response into an array of candle objects.
 *
 * IIFL response shapes observed in the wild:
 *   A) { result: "[[ts,o,h,l,c,v],...]" }  ← result is a JSON *string*
 *   B) { result: [[ts,o,h,l,c,v],...] }     ← result is already an array
 *   C) { data:   [[ts,o,h,l,c,v],...] }
 *   D) [[ts,o,h,l,c,v],...]                 ← top-level array
 *   E) { result: { data: [...] } }           ← nested object
 *
 * Each row element may be:
 *   - Array: [timestamp, open, high, low, close, volume]
 *   - Object: { timestamp/time/date, open/o, high/h, low/l, close/c, volume/v }
 */
function parseHistoricalResponse(raw) {
  try {
    // Step 1: If the entire response body was a string, parse it.
    let data = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // Step 2: Unwrap the result / data envelope.
    let rows;
    if (Array.isArray(data)) {
      rows = data;
    } else if (typeof data?.result === 'string') {
      // Double-encoded: result is a JSON string containing the array
      rows = JSON.parse(data.result);
    } else if (Array.isArray(data?.result)) {
      rows = data.result;
    } else if (Array.isArray(data?.result?.data)) {
      rows = data.result.data;
    } else if (Array.isArray(data?.data)) {
      rows = data.data;
    } else if (Array.isArray(data?.candles)) {
      rows = data.candles;
    } else {
      console.warn('[parseHistoricalResponse] Unrecognised shape:', JSON.stringify(data).slice(0, 200));
      rows = [];
    }

    return rows.map((row) => {
      if (Array.isArray(row)) {
        // ts can be epoch-ms number or ISO/IIFL date string
        const ts = typeof row[0] === 'number' ? new Date(row[0]).toISOString() : String(row[0]);
        return { t: ts, o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5] || 0) };
      }
      return {
        t: row.timestamp ?? row.time ?? row.t ?? row.date ?? '',
        o: Number(row.open  ?? row.o ?? 0),
        h: Number(row.high  ?? row.h ?? 0),
        l: Number(row.low   ?? row.l ?? 0),
        c: Number(row.close ?? row.c ?? 0),
        v: Number(row.volume ?? row.v ?? 0),
      };
    }).filter((c) => c.o > 0 || c.h > 0);
  } catch (err) {
    console.error('[parseHistoricalResponse] Parse error:', err.message);
    return [];
  }
}

/**
 * Generate synthetic OHLCV candles for simulation mode.
 * Uses a seeded random walk anchored to the instrument's basePrice.
 */
function syntheticCandles(instrument, period) {
  const seed = instrument.symbol.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  let price = number(instrument.basePrice, 200);
  const prng = (n) => { let x = Math.sin(seed + n) * 10000; return x - Math.floor(x); };

  const now = Date.now();
  const periodMs = {
    '7d': 864e5, '1m': 864e5, '1y': 7 * 864e5, 'lifetime': 30 * 864e5,
  }[period] || 864e5;
  const count = { '7d': 7, '1m': 30, '1y': 52, 'lifetime': 120 }[period] || 30;
  const from = now - count * periodMs;

  const candles = [];
  for (let i = 0; i < count; i++) {
    const drift = (prng(i * 3) - 0.48) * 0.025;
    const volatility = 0.012 + prng(i * 3 + 1) * 0.018;
    const open = price;
    const close = +(open * (1 + drift)).toFixed(2);
    const high = +(Math.max(open, close) * (1 + prng(i * 3 + 2) * volatility)).toFixed(2);
    const low = +(Math.min(open, close) * (1 - prng(i * 3 + 1) * volatility)).toFixed(2);
    const volume = Math.round(50000 + prng(i * 5) * 800000);
    candles.push({ t: new Date(from + i * periodMs).toISOString(), o: open, h: high, l: low, c: close, v: volume });
    price = close;
  }
  return candles;
}

/**
 * Fetch 52W high/low data for EVERY instrument listed on the given exchange.
 *
 * Strategy:
 *  1. Load all instruments from the IIFL contract file (the full market list).
 *  2. If the contract file is unavailable fall back to DEFAULT_WATCHLIST.
 *  3. LIVE  : batch-POST /marketdata/marketquotes in chunks of 50,
 *             up to 5 chunks in parallel, to stay within rate limits.
 *  4. SIM   : generate synthetic data using the same seeded PRNG as the chart.
 *  5. Cache results per exchange for 10 minutes.
 */
async function fetchMarket52Week(session, exchange) {
  const code     = String(exchange || 'NSEEQ').toUpperCase();
  const cacheKey = `${code}:${session.mode}`;
  const cached   = screenerCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;

  // ── Step 1: full instrument list for the exchange ──────────────────────────
  let instruments = await contractsFor(code);

  // Fallback: contract file unreachable (e.g. no network, or auth required)
  if (!instruments.length) {
    console.warn(`[52week] Contract file empty for ${code}; falling back to STATIC_CATALOG`);
    instruments = STATIC_CATALOG.filter((i) => i.exchange === code);
  }
  if (!instruments.length) instruments = DEFAULT_WATCHLIST;

  // ── Step 2: fetch quotes ───────────────────────────────────────────────────
  let data;
  if (session.mode === 'LIVE' && session.accessToken) {
    const CHUNK  = 50;
    const CONCUR = 5;
    const chunks = [];
    for (let i = 0; i < instruments.length; i += CHUNK) chunks.push(instruments.slice(i, i + CHUNK));

    const allRaw = [];
    for (let i = 0; i < chunks.length; i += CONCUR) {
      const group   = chunks.slice(i, i + CONCUR);
      const results = await Promise.all(group.map(async (chunk) => {
        try {
          const res = await axios.post(
            `${CONFIG.apiBaseUrl}/marketdata/marketquotes`,
            chunk.map(({ exchange: ex, instrumentId }) => ({ exchange: ex, instrumentId })),
            { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, timeout: 15000 }
          );
          return Array.isArray(res.data?.result) ? res.data.result : [];
        } catch (_) { return []; }
      }));
      allRaw.push(...results.flat());
    }

    const rawMap = new Map(allRaw.map((r) => [
      instrumentKey({ exchange: r.exchange || code, instrumentId: String(r.instrumentId ?? r.token ?? '') }), r,
    ]));

    data = instruments.map((inst) => {
      const raw  = rawMap.get(instrumentKey(inst)) || {};
      const ltp  = number(raw.ltp ?? raw.lastPrice, number(inst.basePrice, 100));
      const w52h = number(raw.week52High ?? raw.yearHigh, ltp * 1.35);
      const w52l = number(raw.week52Low  ?? raw.yearLow,  ltp * 0.72);
      return {
        symbol: inst.symbol, instrumentId: inst.instrumentId, exchange: inst.exchange,
        lastPrice: ltp, week52High: w52h, week52Low: w52l,
        pctChange: number(raw.pctChange ?? raw.changePercent, 0),
        distanceFromHigh: w52h > 0 ? ((w52h - ltp) / w52h) * 100 : 100,
        distanceFromLow:  w52l > 0 ? ((ltp - w52l) / w52l) * 100 : 100,
      };
    });
  } else {
    // Simulation: deterministic seeded data for every instrument in the list
    data = instruments.map((inst, i) => {
      const sim  = makeSimulationQuote(inst, i);
      return {
        symbol: inst.symbol, instrumentId: inst.instrumentId, exchange: inst.exchange,
        lastPrice: sim.lastPrice, week52High: sim.week52High, week52Low: sim.week52Low,
        pctChange: sim.pctChange,
        distanceFromHigh: ((sim.week52High - sim.lastPrice) / sim.week52High) * 100,
        distanceFromLow:  ((sim.lastPrice - sim.week52Low)  / sim.week52Low)  * 100,
      };
    });
  }

  screenerCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

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
  saveSession(session);
  res.status(201).json(terminalPayload(session));
});

app.delete('/api/watchlist/:exchange/:instrumentId', (req, res) => {
  const session = browserSession(req, res);
  const key = instrumentKey({ exchange: req.params.exchange, instrumentId: req.params.instrumentId });
  const index = session.watchlist.findIndex((instrument) => instrumentKey(instrument) === key);
  if (index < 0) return res.status(404).json({ message: 'That scrip is not in this watchlist.' });
  session.watchlist.splice(index, 1);
  session.quotes.splice(index, 1);
  saveSession(session);
  res.json(terminalPayload(session));
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

// ─── 52-Week High / Low — FULL MARKET (all exchange instruments) ─────────────
// exchange: NSEEQ | BSEEQ | NSEFO | BSEFO  (default NSEEQ)
// type    : high | low
// The server fetches the complete contract file for the exchange, then
// batch-queries marketquotes in chunks of 50 (up to 5 concurrent) to get
// live 52W data. In simulation mode it returns synthetic data for every
// listed instrument.
app.get('/api/52week', async (req, res) => {
  const session  = browserSession(req, res);
  const type     = String(req.query.type     || 'high').toLowerCase(); // 'high' | 'low'
  const exchange = String(req.query.exchange || 'NSEEQ').toUpperCase();
  try {
    const data   = await fetchMarket52Week(session, exchange);
    const sorted = type === 'low'
      ? data.slice().sort((a, b) => a.distanceFromLow  - b.distanceFromLow)
      : data.slice().sort((a, b) => a.distanceFromHigh - b.distanceFromHigh);
    res.json({ type, exchange, total: sorted.length, instruments: sorted });
  } catch (error) {
    console.error('[52week]', error.message);
    res.status(500).json({ message: 'Unable to fetch 52-week screener data.' });
  }
});

// ─── Historical Chart Data ────────────────────────────────────────────────────
app.get('/api/chart/:exchange/:instrumentId', async (req, res) => {
  const session = browserSession(req, res);
  const exchange = String(req.params.exchange || 'NSEEQ').toUpperCase();
  const instrumentId = String(req.params.instrumentId || '');
  const period = String(req.query.period || '1m'); // 7d | 1m | 1y | lifetime

  if (!instrumentId) return res.status(400).json({ message: 'instrumentId is required.' });

  const instrument = knownInstrument(exchange, instrumentId) || { symbol: instrumentId, instrumentId, exchange, basePrice: 100 };

  // ── LIVE mode: fetch real historical candles from IIFL ─────────────────────
  if (session.mode === 'LIVE' && session.accessToken) {
    const { interval, fromDate, toDate } = chartRange(period);
    try {
      const response = await axios.post(`${CONFIG.apiBaseUrl}/marketdata/historicaldata`, {
        exchange, instrumentId, interval, fromDate, toDate,
      }, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
        timeout: 20000,
      });
      const candles = parseHistoricalResponse(response.data);
      if (candles.length) {
        return res.json({ symbol: instrument.symbol, exchange, instrumentId, period, candles, simulated: false });
      }
      // IIFL returned a response but no candles – this instrument may not have
      // historical data on the API (e.g., illiquid/unlisted). Report it clearly.
      console.warn(`[chart] No candles for ${exchange}:${instrumentId} (${instrument.symbol}) period=${period}`);
      return res.status(503).json({
        message: `IIFL did not return chart data for ${instrument.symbol} (${period}). The instrument may be unlisted, illiquid, or unsupported by the historicaldata endpoint.`,
        simulated: false,
      });
    } catch (err) {
      console.error(`[chart] historicaldata error for ${exchange}:${instrumentId}:`, err.response?.status || err.message);
      if (err.response?.status === 401 || err.response?.status === 403) {
        clearSession(session, 'IIFL session expired.');
      }
      return res.status(503).json({
        message: `Chart data unavailable: ${err.response?.data?.message || err.message}`,
        simulated: false,
      });
    }
  }

  // ── Simulation / offline fallback (only when NOT in LIVE mode) ────────────
  const candles = syntheticCandles(instrument, period);
  res.json({ symbol: instrument.symbol, exchange, instrumentId, period, candles, simulated: true });
});

app.get('*', sendTerminal);

http.createServer(app).listen(CONFIG.port, () => {
  console.log(`Trader Terminal running at http://localhost:${CONFIG.port}`);
  console.log(configured() ? 'IIFL credentials detected; awaiting daily browser login.' : 'Simulation mode; add server/.env to enable IIFL login.');
});
