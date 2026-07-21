'use strict';

const DEMO_QUOTES = [
  ['ABB', 687.55, .44], ['ACC', 1345.15, 1.43], ['SBILIFE', 3160.55, .51],
  ['BHEL', 832.05, -1.11], ['BPCL', 285.60, -.83], ['RELIANCE', 561.00, 1.82],
  ['GRASIM', 96.70, -2.85], ['AMBUJACEM', 313.90, .21], ['HDFC', 1299.00, .32],
  ['HEROMOTOCO', 160.30, .06], ['HINDALCO', 306.00, .35], ['HINDUNILVR', 418.00, 1.01],
  ['INFY', 669.00, -.21], ['ITC', 65.00, 2.14], ['M&M', 720.00, 1.08],
  ['ONGC', 720.00, .82], ['RANBAXY', 724.00, .27], ['RELCAPITAL', 706.00, -.31],
  ['TCS', 3802.40, .53], ['ICICIBANK', 1270.70, -.47],
].map(([symbol, lastPrice, pctChange], i) => quoteFromPrice({ symbol, lastPrice, pctChange, id: String(1000 + i) }, i));

const state = { quotes: DEMO_QUOTES, selectedSymbol: null, analysisTab: 'action', session: { mode: 'SIMULATION' } };
const el = (id) => document.getElementById(id);
const fmt = (value, digits = 2) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

function quoteFromPrice(quote, index = 0) {
  const lastPrice = Number(quote.lastPrice ?? quote.ltp ?? 0);
  const pctChange = Number(quote.pctChange ?? quote.changePercent ?? 0);
  const pcClose = Number((quote.close ?? quote.previousClose ?? (lastPrice / (1 + pctChange / 100))) || lastPrice);
  const spread = Math.max(lastPrice * .001, .05);
  return {
    id: quote.id || quote.instrumentId || String(index), symbol: quote.symbol || quote.tradingSymbol || `SCRIP${index + 1}`,
    exchange: quote.exchange || 'NSEEQ', lastPrice, pctChange, pcClose,
    bidPrice: Number(quote.bestBidPrice ?? lastPrice - spread), bidQty: Number(quote.bestBidQty ?? quote.bestBidQuantity ?? 100 + index * 17),
    offerPrice: Number(quote.bestAskPrice ?? lastPrice + spread), offerQty: Number(quote.bestAskQty ?? quote.bestAskQuantity ?? 120 + index * 19),
    open: Number(quote.open ?? pcClose * .996), high: Number(quote.high ?? lastPrice * 1.013), low: Number(quote.low ?? lastPrice * .988),
    totalQty: Number(quote.tradedVolume ?? quote.totalQty ?? 80000 + index * 11457),
    week52High: Number(quote.week52High ?? lastPrice * (1.02 + (index % 3) * .025)),
    week52Low: Number(quote.week52Low ?? lastPrice * (.72 - (index % 3) * .02)),
    updatedAt: quote.updatedAt || new Date().toISOString(),
  };
}

function renderMarket() {
  const query = el('symbol-search').value.trim().toUpperCase();
  const quotes = state.quotes.filter((quote) => quote.symbol.includes(query));
  el('script-count').textContent = `${state.quotes.length} Scripts`;
  el('market-body').innerHTML = quotes.map((q, index) => {
    const move = q.pctChange >= 0 ? 'up' : 'down';
    const rateClass = Math.abs(q.pctChange) > .25 ? `rate-${move}` : 'plain-rate';
    return `<tr data-symbol="${q.symbol}">
      <td>N</td><td>C</td><td>⌁</td><td class="${move}-arrow">${q.pctChange >= 0 ? '▲' : '▼'}</td><td></td>
      <td class="symbol">${q.symbol}</td><td class="${rateClass}">${fmt(q.lastPrice)}</td><td class="${move === 'up' ? 'positive-text' : 'negative-text'}">${q.pctChange >= 0 ? '' : ''}${q.pctChange.toFixed(2)}</td>
      <td>${qty(q.bidQty)}</td><td>${fmt(q.bidPrice)}</td><td>${qty(q.offerQty)}</td><td>${fmt(q.offerPrice)}</td>
      <td>${fmt(q.open)}</td><td>${fmt(q.high)}</td><td>${fmt(q.low)}</td><td>${fmt(q.pcClose)}</td><td>${qty(q.totalQty)}</td><td class="find-cell">▦</td>
    </tr>`;
  }).join('');
}

function renderNews() {
  const items = [
    ['DJ', '12:21:00 PM', 'BBTC: Market breadth remains positive in early trade'],
    ['DJ', '12:27:00 PM', 'Shares move higher as banking stocks extend gains'],
    ['DJ', '12:35:00 PM', 'Global cues and commodity prices guide afternoon session'],
    ['DL', '12:42:00 PM', 'NSE market update: volume leaders refresh'],
  ];
  el('news-list').innerHTML = items.map(([source, time, text]) => `<div class="news-row"><span class="source">${source}</span><time>${time}</time><span>${text}</span></div>`).join('');
}

function renderCalls() {
  const calls = [
    ['BUY', 'RELIANCE', 'Strength above day high · Target ₹3,200'],
    ['BUY', 'INFY', 'Momentum watch · Target ₹1,800'],
    ['SELL', 'TATASTEEL', 'Weak below support · Stop ₹155'],
    ['BUY', 'HDFCBANK', 'Accumulation zone · Medium term'],
  ];
  el('calls-list').innerHTML = calls.map(([side, symbol, note]) => `<div class="call-row"><span class="call-side ${side.toLowerCase()}">${side}</span><strong>${symbol}</strong><span class="call-note">${note}</span></div>`).join('');
}

function analysisRows() {
  let rows = [...state.quotes];
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
  el('analysis-body').innerHTML = analysisRows().map((q) => {
    const highDistance = ((q.week52High - q.lastPrice) / q.week52High) * 100;
    const lowDistance = ((q.lastPrice - q.week52Low) / q.week52Low) * 100;
    const status = highDistance < 3 ? ['New High', 'new-high'] : lowDistance < 3 ? ['New Low', 'new-low'] : [q.pctChange >= 0 ? 'Gaining' : 'Losing', q.pctChange >= 0 ? 'new-high' : 'new-low'];
    return `<tr><td>N</td><td>C</td><td>${q.id}</td><td>${q.symbol}</td><td class="${status[1]}">${status[0]}</td><td class="analysis-rate">${fmt(q.lastPrice)}</td><td>${new Date(q.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td></tr>`;
  }).join('');
}

function showAnalysis() { el('analysis-window').classList.remove('is-hidden'); renderAnalysis(); }
function closeAnalysis() { el('analysis-window').classList.add('is-hidden'); }
function toast(message) { const target = el('toast'); target.textContent = message; target.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => target.classList.remove('show'), 2600); }

function setSession(session) {
  state.session = session || state.session;
  const live = session?.mode === 'LIVE';
  const status = el('connection-status');
  status.classList.toggle('live', live); status.classList.toggle('error', session?.mode === 'ERROR');
  status.querySelector('span').textContent = live ? 'IIFL connected' : session?.mode === 'ERROR' ? 'Connection error' : 'Simulation';
  const connect = el('connect-iifl');
  connect.textContent = live ? 'IIFL Connected' : 'Connect IIFL'; connect.classList.toggle('connected', live);
}

async function getSession() {
  try { const response = await fetch('/api/session'); if (response.ok) setSession(await response.json()); } catch (_) { /* the visual demo remains usable without the server */ }
}

async function refreshQuotes(silent = false) {
  try {
    const response = await fetch('/api/market-watch/refresh', { method: 'POST' });
    if (!response.ok) throw new Error('Unable to refresh quotes');
    const data = await response.json();
    if (Array.isArray(data.quotes) && data.quotes.length) state.quotes = data.quotes.map(quoteFromPrice);
    setSession(data.session); renderMarket(); renderAnalysis();
    if (!silent) toast(data.session?.mode === 'LIVE' ? 'Live IIFL quotes refreshed' : 'Simulation quotes refreshed');
  } catch (_) {
    state.quotes = state.quotes.map((q) => quoteFromPrice({ ...q, lastPrice: +(q.lastPrice * (1 + (Math.random() - .49) * .0015)).toFixed(2), pctChange: q.pctChange + (Math.random() - .5) * .08 }));
    renderMarket(); renderAnalysis(); if (!silent) toast('Showing local simulation quotes');
  }
}

function bindEvents() {
  el('terminal-clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
  setInterval(() => { el('terminal-clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false }); }, 1000);
  el('symbol-search').addEventListener('input', renderMarket);
  el('open-action-watch').addEventListener('click', showAnalysis);
  el('open-action-watch-secondary').addEventListener('click', showAnalysis);
  el('close-analysis').addEventListener('click', closeAnalysis);
  el('refresh-quotes').addEventListener('click', () => refreshQuotes());
  el('analysis-refresh').addEventListener('click', () => refreshQuotes());
  el('news-refresh').addEventListener('click', () => { renderNews(); toast('News wire refreshed'); });
  el('add-scrip').addEventListener('click', () => toast('Use the symbol search to locate a scrip in this watch.'));
  el('connect-iifl').addEventListener('click', () => { if (state.session.mode !== 'LIVE') window.location.assign('/auth/login'); });
  document.querySelectorAll('[data-analysis-tab]').forEach((button) => button.addEventListener('click', () => {
    state.analysisTab = button.dataset.analysisTab;
    document.querySelectorAll('[data-analysis-tab]').forEach((tab) => tab.classList.toggle('active', tab === button));
    renderAnalysis();
  }));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAnalysis(); if (event.key === 'F7') { event.preventDefault(); showAnalysis(); } });
}

async function initialize() {
  renderMarket(); renderNews(); renderCalls(); renderAnalysis(); bindEvents();
  await getSession();
  await refreshQuotes(true);
  setInterval(() => refreshQuotes(true), 4000);
}
initialize();
