/**
 * IIFL Markets API gateway for the trader-terminal UI.
 *
 * IIFL credentials and access tokens are deliberately confined to this process.
 * The browser only receives normalised quote data from /api/market-watch.
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

const WATCHLIST = [
  ['ABB', '13', 687.55], ['ACC', '22', 1345.15], ['SBILIFE', '21808', 3160.55],
  ['BHEL', '438', 832.05], ['BPCL', '526', 285.60], ['RELIANCE', '2885', 561.00],
  ['GRASIM', '1232', 96.70], ['AMBUJACEM', '1270', 313.90], ['HDFCBANK', '1333', 1299.00],
  ['HEROMOTOCO', '1348', 160.30], ['HINDALCO', '1363', 306.00], ['HINDUNILVR', '1394', 418.00],
  ['INFY', '1594', 669.00], ['ITC', '1660', 65.00], ['M&M', '2031', 720.00],
  ['ONGC', '2475', 720.00], ['TCS', '11536', 3802.40], ['ICICIBANK', '4963', 1270.70],
  ['TATAMOTORS', '3456', 760.15], ['SUNPHARMA', '3351', 1680.80],
].map(([symbol, instrumentId, basePrice], index) => ({ symbol, instrumentId, exchange: 'NSEEQ', basePrice, index }));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: 'index.html' }));

const browserSessions = new Map();
const SESSION_COOKIE = 'tt_session';
let quotes = WATCHLIST.map(makeSimulationQuote);

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

function quoteFromPayload(raw, fallback) {
  const ltp = number(raw.ltp ?? raw.lastPrice ?? raw.lastTradedPrice, fallback.lastPrice);
  const close = number(raw.close ?? raw.previousClose ?? raw.pcClose, fallback.pcClose);
  const pctChange = close ? ((ltp - close) / close) * 100 : 0;
  return {
    instrumentId: String(raw.instrumentId ?? raw.token ?? fallback.instrumentId),
    symbol: raw.symbol ?? raw.tradingSymbol ?? fallback.symbol,
    exchange: raw.exchange ?? fallback.exchange,
    lastPrice: ltp,
    pctChange: number(raw.pctChange ?? raw.changePercent, pctChange),
    close,
    open: number(raw.open, fallback.open),
    high: number(raw.high, fallback.high),
    low: number(raw.low, fallback.low),
    bestBidPrice: number(raw.bestBidPrice, fallback.bestBidPrice),
    bestBidQty: number(raw.bestBidQty ?? raw.bestBidQuantity, fallback.bestBidQty),
    bestAskPrice: number(raw.bestAskPrice ?? raw.bestAskRate, fallback.bestAskPrice),
    bestAskQty: number(raw.bestAskQty ?? raw.bestAskQuantity, fallback.bestAskQty),
    tradedVolume: number(raw.tradedVolume ?? raw.totalQty ?? raw.totalTradedQuantity, fallback.tradedVolume),
    week52High: number(raw.week52High, fallback.week52High),
    week52Low: number(raw.week52Low, fallback.week52Low),
    updatedAt: new Date().toISOString(),
  };
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function makeSimulationQuote(item) {
  const direction = [-.44, 1.43, .51, -1.11, -.83, 1.82, -2.85, .21, .32, .06, .35, 1.01, -.21, 2.14, 1.08, .82, .53, -.47, .16, .72][item.index] || .1;
  const close = item.basePrice / (1 + direction / 100);
  const spread = Math.max(item.basePrice * .00035, .05);
  return {
    instrumentId: item.instrumentId, symbol: item.symbol, exchange: item.exchange,
    lastPrice: item.basePrice, pctChange: direction, close,
    open: close * (1 + ((item.index % 5) - 2) / 1000), high: item.basePrice * 1.013,
    low: item.basePrice * .988, bestBidPrice: item.basePrice - spread,
    bestBidQty: 80 + item.index * 53, bestAskPrice: item.basePrice + spread,
    bestAskQty: 100 + item.index * 61, tradedVolume: 70000 + item.index * 12431,
    week52High: item.basePrice * (1.035 + (item.index % 3) * .02),
    week52Low: item.basePrice * (.70 + (item.index % 4) * .025), updatedAt: new Date().toISOString(),
  };
}

function advanceSimulation() {
  quotes = quotes.map((quote) => {
    const drift = (Math.random() - .497) * .0018;
    const lastPrice = +(quote.lastPrice * (1 + drift)).toFixed(2);
    const pctChange = +(((lastPrice - quote.close) / quote.close) * 100).toFixed(2);
    const spread = Math.max(lastPrice * .00035, .05);
    return { ...quote, lastPrice, pctChange, high: Math.max(quote.high, lastPrice), low: Math.min(quote.low, lastPrice), bestBidPrice: +(lastPrice - spread).toFixed(2), bestAskPrice: +(lastPrice + spread).toFixed(2), bestBidQty: Math.max(1, Math.round(quote.bestBidQty * (.96 + Math.random() * .08))), bestAskQty: Math.max(1, Math.round(quote.bestAskQty * (.96 + Math.random() * .08))), tradedVolume: quote.tradedVolume + Math.round(Math.random() * 2500), updatedAt: new Date().toISOString() };
  });
}

function publicSession(session) {
  return { mode: session.mode, authenticated: Boolean(session.accessToken), configured: configured(), expiresAt: session.expiresAt, pollIntervalMs: CONFIG.quotePollMs };
}

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
  const value = req.query.clientId || req.query.clientCode || req.query.clientcode || req.query.client_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function exchangeAuthorizationCode(code, clientId, session) {
  if (!clientId) {
    throw new Error('The IIFL callback did not include a client ID. Confirm the current /getusersession request schema with IIFL before enabling live login.');
  }
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
  if (!session.accessToken) return false;
  const instruments = WATCHLIST.map(({ exchange, instrumentId }) => ({ exchange, instrumentId }));
  try {
    const response = await axios.post(`${CONFIG.apiBaseUrl}/marketdata/marketquotes`, instruments, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, timeout: 15000,
    });
    const results = response.data?.result;
    if (!Array.isArray(results)) throw new Error(response.data?.message || 'The market quote response did not contain results.');
    const byInstrument = new Map(quotes.map((quote) => [String(quote.instrumentId), quote]));
    quotes = results.map((result, index) => quoteFromPayload(result, byInstrument.get(String(result.instrumentId ?? result.token)) || quotes[index] || makeSimulationQuote(WATCHLIST[index])));
    return true;
  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 403) clearSession(session, 'IIFL session expired. Sign in again to continue live data.');
    else session.lastError = 'IIFL market data request failed.';
    return false;
  }
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
  const session = { id: crypto.randomUUID(), accessToken: null, expiresAt: null, authenticatedAt: null, mode: 'SIMULATION', lastError: null };
  browserSessions.set(session.id, session);
  const secure = CONFIG.redirectUri.startsWith('https://') ? '; Secure' : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  return session;
}

function sendTerminal(_req, res) { res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')); }

app.get('/api/session', (req, res) => {
  const session = browserSession(req, res);
  res.json(publicSession(session));
});
app.get('/api/market-watch', (req, res) => {
  const session = browserSession(req, res);
  res.json({ quotes, session: publicSession(session) });
});
app.post('/api/market-watch/refresh', async (req, res) => {
  const session = browserSession(req, res);
  if (session.mode === 'LIVE') await refreshLiveQuotes(session);
  if (session.mode !== 'LIVE') advanceSimulation();
  res.json({ quotes, session: publicSession(session) });
});

app.get('/auth/login', (req, res) => {
  browserSession(req, res);
  if (!configured()) return res.status(503).send('IIFL is not configured. Add IIFL_APP_KEY, IIFL_APP_SECRET, and IIFL_REDIRECT_URI to server/.env, then restart the server.');
  const url = new URL(`${CONFIG.marketsUrl}/`);
  url.searchParams.set('v', '1');
  url.searchParams.set('appkey', CONFIG.appKey);
  url.searchParams.set('redirecturl', CONFIG.redirectUri);
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const session = browserSession(req, res);
  const code = req.query.code || req.query.authCode;
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

const server = http.createServer(app);
server.listen(CONFIG.port, () => {
  console.log(`Trader Terminal running at http://localhost:${CONFIG.port}`);
  console.log(configured() ? 'IIFL credentials detected; awaiting daily browser login.' : 'Simulation mode; add server/.env to enable IIFL login.');
});
