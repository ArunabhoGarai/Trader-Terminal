/**
 * IIFL Markets API gateway for the trader-terminal UI.
 *
 * Credentials and access tokens remain server-side. Each browser receives an
 * isolated in-memory session containing its own active watchlist and token.
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

const MAX_WATCHLIST_SIZE = 20;
const SESSION_COOKIE = 'tt_session';
const CONTRACT_CACHE_MS = 30 * 60 * 1000;

// Built-in NSE Equity symbols keep the terminal immediately useful and provide
// a verified fallback if the public contract-file endpoint is unavailable.
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
  const ltp = number(raw.ltp ?? raw.lastPrice ?? raw.lastTradedPrice, fallback.lastPrice);
  const close = number(raw.close ?? raw.previousClose ?? raw.pcClose, fallback.close);
  const pctChange = close ? ((ltp - close) / close) * 100 : 0;
  return {
    ...fallback,
    instrumentId: String(raw.instrumentId ?? raw.token ?? fallback.instrumentId),
    symbol: raw.symbol ?? raw.tradingSymbol ?? fallback.symbol,
    exchange: raw.exchange ?? fallback.exchange,
    lastPrice: ltp,
    pctChange: number(raw.pctChange ?? raw.changePercent, pctChange),
    close,
    open: number(raw.open, fallback.open), high: number(raw.high, fallback.high), low: number(raw.low, fallback.low),
    bestBidPrice: number(raw.bestBidPrice, fallback.bestBidPrice), bestBidQty: number(raw.bestBidQty ?? raw.bestBidQuantity, fallback.bestBidQty),
    bestAskPrice: number(raw.bestAskPrice ?? raw.bestAskRate, fallback.bestAskPrice), bestAskQty: number(raw.bestAskQty ?? raw.bestAskQuantity, fallback.bestAskQty),
    tradedVolume: number(raw.tradedVolume ?? raw.totalQty ?? raw.totalTradedQuantity, fallback.tradedVolume),
    week52High: number(raw.week52High, fallback.week52High), week52Low: number(raw.week52Low, fallback.week52Low),
    updatedAt: new Date().toISOString(), position,
  };
}

function createBrowserSession() {
  const watchlist = DEFAULT_WATCHLIST.map((instrument) => ({ ...instrument }));
  return {
    id: crypto.randomUUID(), accessToken: null, expiresAt: null, authenticatedAt: null, mode: 'SIMULATION', lastError: null,
    watchlist, quotes: watchlist.map(makeSimulationQuote),
  };
}

function readCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((pair) => {
    const index = pair.indexOf('=');
    return [pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function browserSession(req, res) {
  const id = readCookies(req)[SESSION_COOKIE];
  if (id && browserSessions.has(id)) return browserSessions.get(id);
  const session = createBrowserSession();
  browserSessions.set(session.id, session);
  const secure = CONFIG.redirectUri.startsWith('https://') ? '; Secure' : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  return session;
}

function publicSession(session) {
  return { mode: session.mode, authenticated: Boolean(session.accessToken), configured: configured(), expiresAt: session.expiresAt, pollIntervalMs: CONFIG.quotePollMs };
}

function publicWatchlist(session) {
  return { count: session.watchlist.length, max: MAX_WATCHLIST_SIZE, items: session.watchlist.map(publicInstrument) };
}

function terminalPayload(session) {
  return { quotes: session.quotes, session: publicSession(session), watchlist: publicWatchlist(session) };
}

function clearSession(session, message) {
  session.accessToken = null;
  session.expiresAt = null;
  session.authenticatedAt = null;
  session.mode = 'SIMULATION';
  session.lastError = message || null;
}

function advanceSimulation(session) {
  session.quotes = session.quotes.map((quote) => {
    const drift = (Math.random() - .497) * .0018;
    const lastPrice = +(quote.lastPrice * (1 + drift)).toFixed(2);
    const pctChange = +(((lastPrice - quote.close) / quote.close) * 100).toFixed(2);
    const spread = Math.max(lastPrice * .00035, .05);
    return { ...quote, lastPrice, pctChange, high: Math.max(quote.high, lastPrice), low: Math.min(quote.low, lastPrice), bestBidPrice: +(lastPrice - spread).toFixed(2), bestAskPrice: +(lastPrice + spread).toFixed(2), bestBidQty: Math.max(1, Math.round(quote.bestBidQty * (.96 + Math.random() * .08))), bestAskQty: Math.max(1, Math.round(quote.bestAskQty * (.96 + Math.random() * .08))), tradedVolume: quote.tradedVolume + Math.round(Math.random() * 2500), updatedAt: new Date().toISOString() };
  });
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
}

async function refreshLiveQuotes(session) {
  if (!session.accessToken || !session.watchlist.length) return false;
  const instruments = session.watchlist.map(({ exchange, instrumentId }) => ({ exchange, instrumentId }));
  try {
    const response = await axios.post(`${CONFIG.apiBaseUrl}/marketdata/marketquotes`, instruments, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, timeout: 15000,
    });
    const results = Array.isArray(response.data?.result) ? response.data.result : [];
    if (!results.length) throw new Error(response.data?.message || 'The market quote response did not contain results.');
    const previous = new Map(session.quotes.map((quote) => [instrumentKey(quote), quote]));
    const resultsByKey = new Map(results.map((quote) => [instrumentKey({ exchange: quote.exchange || '', instrumentId: quote.instrumentId ?? quote.token }), quote]));
    session.quotes = session.watchlist.map((instrument, index) => {
      const fallback = previous.get(instrumentKey(instrument)) || makeSimulationQuote(instrument, index);
      const raw = resultsByKey.get(instrumentKey(instrument)) || results.find((quote) => String(quote.instrumentId ?? quote.token) === String(instrument.instrumentId));
      return raw ? quoteFromPayload(raw, fallback, index) : fallback;
    });
    return true;
  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 403) clearSession(session, 'IIFL session expired. Sign in again to continue live data.');
    else session.lastError = 'IIFL market data request failed.';
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
  // BSE and F&O identifiers are resolved from IIFL's public contract files.
  // Defer these larger files until the user enters at least two search letters.
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
  res.status(201).json(terminalPayload(session));
});

app.delete('/api/watchlist/:exchange/:instrumentId', (req, res) => {
  const session = browserSession(req, res);
  const key = instrumentKey({ exchange: req.params.exchange, instrumentId: req.params.instrumentId });
  const index = session.watchlist.findIndex((instrument) => instrumentKey(instrument) === key);
  if (index < 0) return res.status(404).json({ message: 'That scrip is not in this watchlist.' });
  session.watchlist.splice(index, 1);
  session.quotes.splice(index, 1);
  res.json(terminalPayload(session));
});

app.get('/auth/login', (req, res) => {
  browserSession(req, res);
  if (!configured()) return res.status(503).send('IIFL is not configured. Add IIFL_APP_KEY, IIFL_APP_SECRET, and IIFL_REDIRECT_URI to server/.env, then restart the server.');
  // IIFL expects the callback URI as a literal query value. Encoding it makes
  // it a relative path on markets.iiflcapital.com after login.
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

http.createServer(app).listen(CONFIG.port, () => {
  console.log(`Trader Terminal running at http://localhost:${CONFIG.port}`);
  console.log(configured() ? 'IIFL credentials detected; awaiting daily browser login.' : 'Simulation mode; add server/.env to enable IIFL login.');
});
