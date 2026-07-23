'use strict';

const DEMO_QUOTES = [
  ['ABB', 687.55, .44], ['ACC', 1345.15, 1.43], ['SBILIFE', 3160.55, .51],
  ['BHEL', 832.05, -1.11], ['BPCL', 285.60, -.83], ['RELIANCE', 561.00, 1.82],
  ['GRASIM', 96.70, -2.85], ['AMBUJACEM', 313.90, .21], ['HDFC', 1299.00, .32],
  ['HEROMOTOCO', 160.30, .06], ['HINDALCO', 306.00, .35], ['HINDUNILVR', 418.00, 1.01],
  ['INFY', 669.00, -.21], ['ITC', 65.00, 2.14], ['M&M', 720.00, 1.08],
  ['ONGC', 720.00, .82], ['RANBAXY', 724.00, .27], ['RELCAPITAL', 706.00, -.31],
  ['TCS', 3802.40, .53], ['ICICIBANK', 1270.70, -.47],
].map(([symbol, lastPrice, pctChange], index) => quoteFromPrice({ symbol, lastPrice, pctChange, id: String(1000 + index) }, index));

const state = {
  quotes: DEMO_QUOTES,
  selectedKey: null,
  analysisTab: 'action',
  session: { mode: 'SIMULATION' },
  watchlist: { count: DEMO_QUOTES.length, max: 400, items: [] },
  actionWatch: [],
  marketAnalysis: { highs: [], lows: [], gainers: [], losers: [] },
  filters: { exchange: 'ALL', segment: 'ALL' },
  suggestions: [],
  selectedSuggestion: null,
  searchTimer: null,
  searchRequest: 0,
  // WebSocket state
  ws: null,
  wsReconnectTimer: null,
  wsReconnectDelay: 1000,
  wsConnected: false,
  // Action watch alert flash tracking
  lastAlertCount: 0,
};

let chartInstance = null;
let candleSeries = null;
let activeChartQuote = null;
let activeTimeframe = '1D';

const el = (id) => document.getElementById(id);
const fmt = (value, digits = 2) => (!value || value <= 0) ? '-' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const qty = (value) => (!value || value <= 0) ? '-' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const keyFor = (quote) => `${quote.exchange || 'NSEEQ'}:${quote.instrumentId || quote.id}`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function quoteFromPrice(quote, index = 0) {
  const lastPrice = Number(quote.lastPrice ?? quote.ltp ?? 0);
  const pctChange = Number(quote.pctChange ?? quote.changePercent ?? 0);
  const pcClose = Number((quote.close ?? quote.previousClose ?? (lastPrice / (1 + pctChange / 100))) || lastPrice);
  const spread = Math.max(lastPrice * .001, .05);
  return {
    id: quote.id || quote.instrumentId || String(index), instrumentId: String(quote.instrumentId || quote.id || index),
    symbol: quote.symbol || quote.tradingSymbol || `SCRIP${index + 1}`,
    exchange: quote.exchange || 'NSEEQ', segment: quote.segment || ((quote.exchange || '').endsWith('FO') ? 'F&O' : 'Equity'),
    lastPrice, pctChange, pcClose,
    bidPrice: quote.bestBidPrice === 0 ? 0 : Number(quote.bestBidPrice ?? Math.max(0, lastPrice - spread)), 
    bidQty: Number(quote.bestBidQty ?? quote.bestBidQuantity ?? 100 + index * 17),
    offerPrice: quote.bestAskPrice === 0 ? 0 : Number(quote.bestAskPrice ?? lastPrice + spread), 
    offerQty: Number(quote.bestAskQty ?? quote.bestAskQuantity ?? 120 + index * 19),
    open: Number(quote.open ?? pcClose * .996), high: Number(quote.high ?? lastPrice * 1.013), low: Number(quote.low ?? lastPrice * .988),
    totalQty: Number(quote.tradedVolume ?? quote.totalQty ?? 80000 + index * 11457),
    week52High: Number(quote.week52High ?? lastPrice * (1.02 + (index % 3) * .025)),
    week52Low: Number(quote.week52Low ?? lastPrice * (.72 - (index % 3) * .02)),
    updatedAt: quote.updatedAt || new Date().toISOString(),
  };
}

function matchesFilters(quote) {
  const exchange = String(quote.exchange || '').toUpperCase();
  const segment = quote.segment || (exchange.endsWith('FO') ? 'F&O' : 'Equity');
  return (state.filters.exchange === 'ALL' || exchange.startsWith(state.filters.exchange))
    && (state.filters.segment === 'ALL' || segment === state.filters.segment);
}

function renderWatchlistMeta() {
  const { count = state.quotes.length, max = 20 } = state.watchlist;
  const label = `${count} / ${max} Scripts`;
  const capacity = el('watchlist-capacity');
  capacity.textContent = label;
  capacity.classList.toggle('full', count >= max);
  el('script-count').textContent = label;
  el('watch-scope').textContent = `${state.filters.exchange === 'ALL' ? 'All Exchanges' : state.filters.exchange} · ${state.filters.segment}`;
}

function renderMarket() {
  const quotes = state.quotes.filter(matchesFilters);
  renderWatchlistMeta();
  el('market-body').innerHTML = quotes.map((quote) => {
    const move = quote.pctChange >= 0 ? 'up' : 'down';
    const rateClass = Math.abs(quote.pctChange) > .25 ? `rate-${move}` : 'plain-rate';
    const selected = keyFor(quote) === state.selectedKey ? ' selected' : '';
    return `<tr class="${selected}" data-key="${escapeHtml(keyFor(quote))}" draggable="true">
      <td>${escapeHtml(quote.exchange.slice(0, 1))}</td><td>${escapeHtml(quote.exchange.includes('FO') ? 'F' : 'C')}</td><td>⌁</td><td class="${move}-arrow">${quote.pctChange >= 0 ? '▲' : '▼'}</td><td></td>
      <td class="symbol">${escapeHtml(quote.symbol)}</td><td class="${rateClass}">${fmt(quote.lastPrice)}</td><td class="${move === 'up' ? 'positive-text' : 'negative-text'}">${quote.pctChange.toFixed(2)}</td>
      <td>${qty(quote.bidQty)}</td><td>${fmt(quote.bidPrice)}</td><td>${qty(quote.offerQty)}</td><td>${fmt(quote.offerPrice)}</td>
      <td>${fmt(quote.open)}</td><td>${fmt(quote.high)}</td><td>${fmt(quote.low)}</td><td>${fmt(quote.pcClose)}</td><td>${qty(quote.totalQty)}</td>
      <td class="find-cell"><button class="remove-scrip" data-key="${escapeHtml(keyFor(quote))}" title="Remove ${escapeHtml(quote.symbol)}" aria-label="Remove ${escapeHtml(quote.symbol)}">×</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="18" class="empty-watchlist">No scrips match these filters.</td></tr>';
}

function renderSearchResults() {
  const results = el('symbol-results');
  const items = state.suggestions;
  results.classList.toggle('hidden', !items.length);
  el('symbol-search').setAttribute('aria-expanded', String(Boolean(items.length)));
  results.innerHTML = items.map((item, index) => `<button class="symbol-result${state.selectedSuggestion === item ? ' active' : ''}" type="button" data-result-index="${index}" role="option" aria-selected="${state.selectedSuggestion === item}">
    <strong>${escapeHtml(item.symbol)}</strong><span>${escapeHtml(item.exchange)} · ${escapeHtml(item.segment || 'Equity')} · Token ${escapeHtml(item.instrumentId)}</span>
  </button>`).join('');
}

function chooseSuggestion(item) {
  state.selectedSuggestion = item;
  el('symbol-search').value = item.symbol;
  state.suggestions = [];
  renderSearchResults();
}

async function searchInstruments() {
  const query = el('symbol-search').value.trim();
  state.selectedSuggestion = null;
  if (query.length < 2) { state.suggestions = []; renderSearchResults(); return; }
  const request = ++state.searchRequest;
  try {
    const params = new URLSearchParams({ q: query, exchange: state.filters.exchange, segment: state.filters.segment });
    const response = await fetch(`/api/instruments?${params}`);
    if (!response.ok) throw new Error('Search unavailable');
    const data = await response.json();
    if (request !== state.searchRequest) return;
    state.suggestions = Array.isArray(data.instruments) ? data.instruments.slice(0, 12) : [];
    renderSearchResults();
  } catch (_) {
    if (request !== state.searchRequest) return;
    state.suggestions = [];
    renderSearchResults();
  }
}

function renderNews() {
  const items = [['DJ', '12:21:00 PM', 'BBTC: Market breadth remains positive in early trade'], ['DJ', '12:27:00 PM', 'Shares move higher as banking stocks extend gains'], ['DJ', '12:35:00 PM', 'Global cues and commodity prices guide afternoon session'], ['DL', '12:42:00 PM', 'NSE market update: volume leaders refresh']];
  el('news-list').innerHTML = items.map(([source, time, text]) => `<div class="news-row"><span class="source">${source}</span><time>${time}</time><span>${text}</span></div>`).join('');
}

function renderCalls() {
  const calls = [['BUY', 'RELIANCE', 'Strength above day high · Target ₹3,200'], ['BUY', 'INFY', 'Momentum watch · Target ₹1,800'], ['SELL', 'TATASTEEL', 'Weak below support · Stop ₹155'], ['BUY', 'HDFCBANK', 'Accumulation zone · Medium term']];
  el('calls-list').innerHTML = calls.map(([side, symbol, note]) => `<div class="call-row"><span class="call-side ${side.toLowerCase()}">${side}</span><strong>${symbol}</strong><span class="call-note">${note}</span></div>`).join('');
}

function analysisOptions() {
  const enabled = (name) => document.querySelector(`[data-analysis-filter="${name}"]`)?.checked ?? false;
  return { nse: enabled('nse'), bse: enabled('bse'), cash: enabled('cash'), fo: enabled('fo'), high: enabled('high'), low: enabled('low') };
}

function highDistance(quote) { return Math.max(0, ((quote.week52High - quote.lastPrice) / quote.week52High) * 100); }
function lowDistance(quote) { return Math.max(0, ((quote.lastPrice - quote.week52Low) / quote.week52Low) * 100); }

function analysisRows() {
  const options = analysisOptions();
  if (state.analysisTab === 'action') {
    return state.actionWatch.filter((event) => {
      const exchange = String(event.exchange || '').toUpperCase();
      const isFutureOption = (event.segment || '').toUpperCase() === 'F&O' || exchange.endsWith('FO');
      const exchangeAllowed = exchange.startsWith('NSE') ? options.nse : exchange.startsWith('BSE') ? options.bse : false;
      const typeAllowed = isFutureOption ? options.fo : options.cash;
      const triggerAllowed = event.status === 'New High' ? options.high : options.low;
      return exchangeAllowed && typeAllowed && triggerAllowed;
    }).slice(0, 200);
  }
  const filterRows = (sourceRows) => sourceRows.filter((quote) => {
    const exchange = String(quote.exchange || '').toUpperCase();
    const isFutureOption = (quote.segment || '').toUpperCase() === 'F&O' || exchange.endsWith('FO');
    const exchangeAllowed = exchange.startsWith('NSE') ? options.nse : exchange.startsWith('BSE') ? options.bse : false;
    return exchangeAllowed && (isFutureOption ? options.fo : options.cash);
  });

  if (state.analysisTab === 'high') {
    if (!options.high) return [];
    return filterRows(state.marketAnalysis?.highs || []).slice(0, 15);
  } else if (state.analysisTab === 'low') {
    if (!options.low) return [];
    return filterRows(state.marketAnalysis?.lows || []).slice(0, 15);
  } else if (state.analysisTab === 'gainers') {
    return filterRows(state.marketAnalysis?.gainers || []).slice(0, 15);
  } else if (state.analysisTab === 'losers') {
    return filterRows(state.marketAnalysis?.losers || []).slice(0, 15);
  } else if (state.analysisTab === 'quantity' || state.analysisTab === 'traded') {
    return filterRows(state.quotes).sort((a, b) => b.totalQty - a.totalQty).slice(0, 12);
  } else {
    return filterRows(state.quotes).filter((quote) => (options.high && highDistance(quote) <= 5) || (options.low && lowDistance(quote) <= 5) || Math.abs(quote.pctChange) >= 1).sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange)).slice(0, 12);
  }
}

function analysisStatus(quote) {
  if (state.analysisTab === 'high') return ['Near 52W High', 'new-high'];
  if (state.analysisTab === 'low') return ['Near 52W Low', 'new-low'];
  if (state.analysisTab === 'gainers') return ['Gaining', 'new-high'];
  if (state.analysisTab === 'losers') return ['Losing', 'new-low'];
  if (state.analysisTab === 'quantity' || state.analysisTab === 'traded') return ['High Volume', 'analysis-neutral'];
  if (highDistance(quote) <= 5) return ['Near 52W High', 'new-high'];
  if (lowDistance(quote) <= 5) return ['Near 52W Low', 'new-low'];
  return quote.pctChange >= 0 ? ['Gaining', 'new-high'] : ['Losing', 'new-low'];
}

function formatEventTime(event) {
  // Use server-provided time string if available, otherwise format from timestamp
  if (event.time) return event.time;
  try {
    return new Date(event.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch (_) {
    return '--:--:--';
  }
}

function renderAnalysis() {
  const tabName = document.querySelector(`[data-analysis-tab="${state.analysisTab}"]`)?.textContent || 'Action Watch';
  const modeLabel = state.session?.mode === 'LIVE' ? 'live IIFL market data' : 'simulation data';
  const wsLabel = state.wsConnected ? '· WebSocket connected' : '· polling';
  el('analysis-summary').textContent = `${tabName} · ${modeLabel} ${wsLabel}`;

  const rows = analysisRows();
  if (state.analysisTab === 'action') {
    el('analysis-body').innerHTML = rows.map((event) => {
      const dirClass = event.direction === 'up' ? 'analysis-tick-up' : event.direction === 'down' ? 'analysis-tick-down' : 'analysis-tick-flat';
      return `<tr class="${dirClass}">
        <td>${escapeHtml((event.exchange || 'N').slice(0, 1))}</td>
        <td>${escapeHtml(event.segment === 'F&O' ? 'F' : 'C')}</td>
        <td>${escapeHtml(event.instrumentId)}</td>
        <td>${escapeHtml(event.symbol)}</td>
        <td class="analysis-status-cell">${escapeHtml(event.status)}</td>
        <td class="analysis-rate">${fmt(event.lastPrice)}</td>
        <td>${formatEventTime(event)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="analysis-empty">No new intraday highs or lows yet. Alerts appear when an active Market Watch scrip makes a new day high or low.</td></tr>';

    // Update alert count badge
    updateAlertBadge(rows.length);
    return;
  }

  el('analysis-body').innerHTML = rows.map((quote) => {
    const status = analysisStatus(quote);
    return `<tr><td>${escapeHtml(quote.exchange.slice(0, 1))}</td><td>${escapeHtml(quote.exchange)}</td><td>${escapeHtml(quote.instrumentId)}</td><td>${escapeHtml(quote.symbol)}</td><td class="${status[1]}">${status[0]}</td><td class="analysis-rate">${fmt(quote.lastPrice)}</td><td>${new Date(quote.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="analysis-empty">No scrips match the selected analysis filters.</td></tr>';
}

function updateAlertBadge(alertCount) {
  const badge = el('alert-badge');
  if (!badge) return;
  if (alertCount > 0) {
    badge.textContent = alertCount > 99 ? '99+' : String(alertCount);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function showAnalysis() { el('analysis-window').classList.remove('is-hidden'); renderAnalysis(); }
function closeAnalysis() { el('analysis-window').classList.add('is-hidden'); }
function toast(message) { const target = el('toast'); target.textContent = message; target.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => target.classList.remove('show'), 2600); }

function setSession(session) {
  state.session = session || state.session;
  const live = state.session.mode === 'LIVE';
  const status = el('connection-status');
  status.classList.toggle('live', live || state.wsConnected);
  status.classList.toggle('error', state.session.mode === 'ERROR');
  status.querySelector('span').textContent = live ? 'IIFL Live' : state.session.mode === 'ERROR' ? 'Connection error' : state.wsConnected ? 'Real-time' : 'Simulation';
  const connect = el('connect-iifl');
  connect.textContent = live ? 'IIFL Connected' : 'Connect IIFL';
  connect.classList.toggle('connected', live);
}

function applyTerminalPayload(data) {
  if (Array.isArray(data.quotes)) state.quotes = data.quotes.map(quoteFromPrice);
  if (data.watchlist) state.watchlist = data.watchlist;
  if (Array.isArray(data.actionWatch)) state.actionWatch = data.actionWatch;
  if (data.marketAnalysis) state.marketAnalysis = data.marketAnalysis;
  setSession(data.session);
  if (state.selectedKey && !state.quotes.some((quote) => keyFor(quote) === state.selectedKey)) state.selectedKey = null;
  renderMarket();
  renderAnalysis();
}

// ---------------------------------------------------------------------------
// WebSocket client — real-time push from server
// ---------------------------------------------------------------------------
function connectWebSocket() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    state.ws = new WebSocket(wsUrl);
  } catch (err) {
    console.warn('[WS] Failed to create WebSocket:', err);
    scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    console.log('[WS] Connected');
    state.wsConnected = true;
    state.wsReconnectDelay = 1000;
    setSession(state.session);
    toast('Real-time feed connected');
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWebSocketMessage(data);
    } catch (err) {
      console.warn('[WS] Failed to parse message:', err);
    }
  };

  state.ws.onclose = (event) => {
    console.log('[WS] Disconnected:', event.code, event.reason);
    state.wsConnected = false;
    state.ws = null;
    setSession(state.session);
    scheduleReconnect();
  };

  state.ws.onerror = (err) => {
    console.warn('[WS] Error:', err);
    state.wsConnected = false;
  };
}

function scheduleReconnect() {
  if (state.wsReconnectTimer) return;
  state.wsReconnectTimer = setTimeout(() => {
    state.wsReconnectTimer = null;
    connectWebSocket();
  }, state.wsReconnectDelay);
  // Exponential backoff capped at 15 seconds
  state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 1.5, 15000);
}

function handleWebSocketMessage(data) {
  switch (data.type) {
    case 'init':
    case 'tick':
    case 'watchlist':
      // Apply full payload update
      if (Array.isArray(data.quotes)) state.quotes = data.quotes.map(quoteFromPrice);
      if (data.watchlist) state.watchlist = data.watchlist;
      if (Array.isArray(data.actionWatch)) state.actionWatch = data.actionWatch;
      if (data.marketAnalysis) state.marketAnalysis = data.marketAnalysis;
      if (data.session) setSession(data.session);

      // Check for new action watch events and flash
      if (data.type === 'tick' && Array.isArray(data.newEvents) && data.newEvents.length > 0) {
        flashNewAlerts(data.newEvents);
      }

      if (state.selectedKey && !state.quotes.some((quote) => keyFor(quote) === state.selectedKey)) state.selectedKey = null;
      renderMarket();
      renderAnalysis();
      break;

    case 'pong':
      // Heartbeat response, no action needed
      break;

    default:
      console.log('[WS] Unknown message type:', data.type);
  }
}

function flashNewAlerts(events) {
  // Flash the Market Analysis button to draw attention to new alerts
  const btn = el('open-action-watch');
  if (btn && !el('analysis-window').classList.contains('is-hidden') === false) {
    btn.classList.add('alert-flash');
    setTimeout(() => btn.classList.remove('alert-flash'), 1500);
  }
}

// Keep WebSocket alive with periodic pings
function startHeartbeat() {
  setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25000);
}

// ---------------------------------------------------------------------------
// REST API calls (fallback when WebSocket unavailable)
// ---------------------------------------------------------------------------
async function getSession() {
  try { const response = await fetch('/api/session'); if (response.ok) setSession(await response.json()); } catch (_) { /* static UI remains available */ }
}

async function loadWatchlist() {
  try {
    const response = await fetch('/api/watchlist');
    if (!response.ok) throw new Error('Unable to load watchlist');
    applyTerminalPayload(await response.json());
  } catch (_) { renderMarket(); }
}

async function reorderWatchlist(keys) {
  try {
    const res = await fetch('/api/watchlist/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    if (res.ok) {
      applyTerminalPayload(await res.json());
    }
  } catch (err) {
    console.error('Failed to reorder', err);
  }
}

async function openChart(key) {
  const quote = state.quotes.find(q => keyFor(q) === key) || state.marketAnalysis?.highs?.find(q => keyFor(q) === key);
  if (!quote) return;
  activeChartQuote = quote;
  el('chart-title').textContent = `${quote.symbol} - Historical Data`;
  el('chart-window').classList.remove('is-hidden');
  
  if (!chartInstance) {
    chartInstance = LightweightCharts.createChart(el('chart-container'), {
      layout: { background: { color: '#000' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#2b2b43' }, horzLines: { color: '#2b2b43' } },
      timeScale: { timeVisible: true, secondsVisible: false }
    });
    candleSeries = chartInstance.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350'
    });
    
    new ResizeObserver(entries => {
      if (entries.length === 0 || entries[0].target !== el('chart-container')) return;
      const newRect = entries[0].contentRect;
      chartInstance.applyOptions({ width: newRect.width, height: newRect.height });
    }).observe(el('chart-container'));
  }
  
  loadChartData();
}

async function loadChartData() {
  if (!activeChartQuote) return;
  el('chart-loader').style.display = 'block';
  try {
    const res = await fetch(`/api/chart/${activeChartQuote.exchange}/${activeChartQuote.instrumentId}?timeframe=${activeTimeframe}`);
    const result = await res.json();
    if (result.success && result.data) {
      candleSeries.setData(result.data);
      chartInstance.timeScale().fitContent();
    } else {
      toast('Failed to load chart data');
    }
  } catch (err) {
    console.error(err);
    toast('Error loading chart');
  } finally {
    el('chart-loader').style.display = 'none';
  }
}

async function refreshQuotes(silent = false) {
  // Always poll via REST — this keeps the server-side simulation ticking
  // and ensures data flows even if WebSocket is connected (server deduplicates)
  try {
    const response = await fetch('/api/market-watch/refresh', { method: 'POST' });
    if (!response.ok) throw new Error('Unable to refresh quotes');
    const data = await response.json();
    applyTerminalPayload(data);
    if (!silent) toast(data.session?.mode === 'LIVE' ? 'Live IIFL quotes refreshed' : 'Simulation quotes refreshed');
  } catch (_) {
    state.quotes = state.quotes.map((quote) => quoteFromPrice({ ...quote, lastPrice: +(quote.lastPrice * (1 + (Math.random() - .49) * .0015)).toFixed(2), pctChange: quote.pctChange + (Math.random() - .5) * .08 }));
    renderMarket(); renderAnalysis(); if (!silent) toast('Showing local simulation quotes');
  }
}

async function addScrip() {
  const instrument = state.selectedSuggestion || state.suggestions[0];
  if (!instrument) { toast('Choose a symbol from the search results first.'); return; }
  try {
    const response = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(instrument) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || 'Could not add scrip');
    state.selectedKey = `${instrument.exchange}:${instrument.instrumentId}`;
    applyTerminalPayload(data);
    el('symbol-search').value = '';
    state.suggestions = []; state.selectedSuggestion = null; renderSearchResults();
    toast(`${instrument.symbol} added to the watchlist.`);
  } catch (error) { toast(error.message); }
}

async function removeScrip(key) {
  if (!key) { toast('Select a scrip to remove.'); return; }
  const [exchange, instrumentId] = key.split(':');
  const quote = state.quotes.find((item) => keyFor(item) === key);
  try {
    const response = await fetch(`/api/watchlist/${encodeURIComponent(exchange)}/${encodeURIComponent(instrumentId)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || 'Could not remove scrip');
    if (state.selectedKey === key) state.selectedKey = null;
    applyTerminalPayload(data);
    toast(`${quote?.symbol || 'Scrip'} removed from the watchlist.`);
  } catch (error) { toast(error.message); }
}

function bindEvents() {
  el('terminal-clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
  setInterval(() => { el('terminal-clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false }); }, 1000);
  for (const filter of ['exchange-filter', 'segment-filter']) {
    el(filter).addEventListener('change', () => {
      state.filters.exchange = el('exchange-filter').value;
      state.filters.segment = el('segment-filter').value;
      renderMarket();
      if (el('symbol-search').value.trim().length >= 2) searchInstruments();
    });
  }
  el('symbol-search').addEventListener('input', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(searchInstruments, 180); });
  el('symbol-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addScrip(); } if (event.key === 'Escape') { state.suggestions = []; renderSearchResults(); } });
  el('symbol-results').addEventListener('click', (event) => { const button = event.target.closest('[data-result-index]'); if (button) chooseSuggestion(state.suggestions[Number(button.dataset.resultIndex)]); });
  el('add-scrip').addEventListener('click', addScrip);
  el('market-body').addEventListener('click', (event) => {
    const remove = event.target.closest('.remove-scrip');
    if (remove) { removeScrip(remove.dataset.key); return; }
    
    const symbolCell = event.target.closest('.symbol');
    if (symbolCell) {
      const row = event.target.closest('tr[data-key]');
      if (row) openChart(row.dataset.key);
      return;
    }

    const row = event.target.closest('tr[data-key]');
    if (row) { state.selectedKey = row.dataset.key; renderMarket(); }
  });
  el('remove-selected').addEventListener('click', () => removeScrip(state.selectedKey));
  el('open-action-watch').addEventListener('click', showAnalysis);
  el('open-action-watch-secondary').addEventListener('click', showAnalysis);
  el('close-analysis').addEventListener('click', closeAnalysis);
  el('refresh-quotes').addEventListener('click', () => refreshQuotes());
  el('analysis-refresh').addEventListener('click', () => refreshQuotes());
  el('news-refresh').addEventListener('click', () => { renderNews(); toast('News wire refreshed'); });
  el('connect-iifl').addEventListener('click', () => { if (state.session.mode !== 'LIVE') window.location.assign('/auth/login'); });
  document.querySelectorAll('[data-analysis-tab]').forEach((button) => button.addEventListener('click', () => { state.analysisTab = button.dataset.analysisTab; document.querySelectorAll('[data-analysis-tab]').forEach((tab) => tab.classList.toggle('active', tab === button)); renderAnalysis(); }));
  document.querySelectorAll('[data-analysis-filter]').forEach((checkbox) => checkbox.addEventListener('change', renderAnalysis));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAnalysis(); if (event.key === 'F7') { event.preventDefault(); showAnalysis(); } });
  
  // Drag and Drop ordering
  const tbody = el('market-body');
  let dragKey = null;
  
  tbody.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    dragKey = tr.dataset.key;
    e.dataTransfer.effectAllowed = 'move';
    tr.classList.add('dragging');
  });
  
  tbody.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tr = e.target.closest('tr');
    const dragging = document.querySelector('.dragging');
    if (tr && dragging && tr.dataset.key !== dragKey) {
      const rect = tr.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        tr.parentNode.insertBefore(dragging, tr);
      } else {
        tr.parentNode.insertBefore(dragging, tr.nextSibling);
      }
    }
  });
  
  tbody.addEventListener('dragend', (e) => {
    const tr = e.target.closest('tr');
    if (tr) tr.classList.remove('dragging');
    dragKey = null;
    
    // Save new order
    const newKeys = Array.from(tbody.querySelectorAll('tr[data-key]')).map(row => row.dataset.key);
    if (newKeys.length > 0) reorderWatchlist(newKeys);
  });
  
  el('close-chart').addEventListener('click', () => { el('chart-window').classList.add('is-hidden'); activeChartQuote = null; });
  document.querySelectorAll('.chart-timeframes button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.chart-timeframes button').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      activeTimeframe = e.target.dataset.tf;
      loadChartData();
    });
  });
}

async function initialize() {
  renderMarket(); renderNews(); renderCalls(); renderAnalysis(); bindEvents();
  await getSession();
  await loadWatchlist();

  // Connect WebSocket for real-time push
  connectWebSocket();
  startHeartbeat();

  // Always poll via REST to keep server simulation ticking + fetch fresh data
  await refreshQuotes(true);
  setInterval(() => refreshQuotes(true), 2500);
}

initialize();
