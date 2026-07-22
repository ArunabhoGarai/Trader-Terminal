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
  watchlist: { count: DEMO_QUOTES.length, max: 20, items: [] },
  filters: { exchange: 'ALL', segment: 'ALL' },
  suggestions: [],
  selectedSuggestion: null,
  searchTimer: null,
  searchRequest: 0,
};

const el = (id) => document.getElementById(id);
const fmt = (value, digits = 2) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
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
    bidPrice: Number(quote.bestBidPrice ?? lastPrice - spread), bidQty: Number(quote.bestBidQty ?? quote.bestBidQuantity ?? 100 + index * 17),
    offerPrice: Number(quote.bestAskPrice ?? lastPrice + spread), offerQty: Number(quote.bestAskQty ?? quote.bestAskQuantity ?? 120 + index * 19),
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
    return `<tr class="${selected}" data-key="${escapeHtml(keyFor(quote))}">
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

function analysisRows() {
  const rows = [...state.quotes];
  if (state.analysisTab === 'high' || state.analysisTab === 'action') rows.sort((a, b) => (b.lastPrice / b.week52High) - (a.lastPrice / a.week52High));
  if (state.analysisTab === 'low') rows.sort((a, b) => (a.lastPrice / a.week52Low) - (b.lastPrice / b.week52Low));
  if (state.analysisTab === 'gainers') rows.sort((a, b) => b.pctChange - a.pctChange);
  if (state.analysisTab === 'losers') rows.sort((a, b) => a.pctChange - b.pctChange);
  if (state.analysisTab === 'quantity' || state.analysisTab === 'traded') rows.sort((a, b) => b.totalQty - a.totalQty);
  return rows.slice(0, 12);
}

function renderAnalysis() {
  const tabName = document.querySelector(`[data-analysis-tab="${state.analysisTab}"]`)?.textContent || 'Action Watch';
  el('analysis-summary').textContent = `${tabName} · ${state.session.mode === 'LIVE' ? 'live IIFL market conditions' : 'simulation market conditions'}`;
  el('analysis-body').innerHTML = analysisRows().map((quote) => {
    const highDistance = ((quote.week52High - quote.lastPrice) / quote.week52High) * 100;
    const lowDistance = ((quote.lastPrice - quote.week52Low) / quote.week52Low) * 100;
    const status = highDistance < 3 ? ['New High', 'new-high'] : lowDistance < 3 ? ['New Low', 'new-low'] : [quote.pctChange >= 0 ? 'Gaining' : 'Losing', quote.pctChange >= 0 ? 'new-high' : 'new-low'];
    return `<tr><td>${escapeHtml(quote.exchange.slice(0, 1))}</td><td>${escapeHtml(quote.exchange)}</td><td>${escapeHtml(quote.instrumentId)}</td><td>${escapeHtml(quote.symbol)}</td><td class="${status[1]}">${status[0]}</td><td class="analysis-rate">${fmt(quote.lastPrice)}</td><td>${new Date(quote.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td></tr>`;
  }).join('');
}

function showAnalysis() { el('analysis-window').classList.remove('is-hidden'); renderAnalysis(); }
function closeAnalysis() { el('analysis-window').classList.add('is-hidden'); }
function toast(message) { const target = el('toast'); target.textContent = message; target.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => target.classList.remove('show'), 2600); }

function setSession(session) {
  state.session = session || state.session;
  const live = state.session.mode === 'LIVE';
  const status = el('connection-status');
  status.classList.toggle('live', live); status.classList.toggle('error', state.session.mode === 'ERROR');
  status.querySelector('span').textContent = live ? 'IIFL connected' : state.session.mode === 'ERROR' ? 'Connection error' : 'Simulation';
  const connect = el('connect-iifl');
  connect.textContent = live ? 'IIFL Connected' : 'Connect IIFL';
  connect.classList.toggle('connected', live);
}

function applyTerminalPayload(data) {
  if (Array.isArray(data.quotes)) state.quotes = data.quotes.map(quoteFromPrice);
  if (data.watchlist) state.watchlist = data.watchlist;
  setSession(data.session);
  if (state.selectedKey && !state.quotes.some((quote) => keyFor(quote) === state.selectedKey)) state.selectedKey = null;
  renderMarket();
  renderAnalysis();
}

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

async function refreshQuotes(silent = false) {
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
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAnalysis(); if (event.key === 'F7') { event.preventDefault(); showAnalysis(); } });
}

async function initialize() {
  renderMarket(); renderNews(); renderCalls(); renderAnalysis(); bindEvents();
  await getSession();
  await loadWatchlist();
  await refreshQuotes(true);
  setInterval(() => refreshQuotes(true), 4000);
}

initialize();
