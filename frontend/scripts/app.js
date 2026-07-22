'use strict';

// ─── Session & localStorage persistence ──────────────────────────────────────
const LS_SESSION_KEY   = 'tt_session_meta';
const LS_WATCHLIST_KEY = 'tt_watchlist_cache';
const LS_FILTER_KEY    = 'tt_filters';

function saveSessionMeta(session) {
  try { localStorage.setItem(LS_SESSION_KEY, JSON.stringify({ mode: session.mode, authenticated: session.authenticated, savedAt: new Date().toISOString() })); } catch (_) {}
}
function saveWatchlistCache(items) {
  try { localStorage.setItem(LS_WATCHLIST_KEY, JSON.stringify(items)); } catch (_) {}
}
function loadWatchlistCache() {
  try { const raw = localStorage.getItem(LS_WATCHLIST_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
function saveFilters(filters) {
  try { localStorage.setItem(LS_FILTER_KEY, JSON.stringify(filters)); } catch (_) {}
}
function loadFilters() {
  try { const raw = localStorage.getItem(LS_FILTER_KEY); const obj = raw ? JSON.parse(raw) : null; return (obj && typeof obj.exchange === 'string') ? obj : null; } catch (_) { return null; }
}

// ─── Application State ────────────────────────────────────────────────────────
const state = {
  quotes: [],
  selectedKey: null,
  analysisTab: 'action',
  session: { mode: 'SIMULATION' },
  watchlist: { count: 0, max: 400, items: [] },
  actionWatch: [],
  filters: loadFilters() || { exchange: 'ALL', segment: 'ALL' },
  suggestions: [],
  selectedSuggestion: null,
  searchTimer: null,
  searchRequest: 0,
  // Chart
  chart: { visible: false, symbol: null, exchange: null, instrumentId: null, period: '1m', candles: [], loading: false },
  // Polling
  pollTimer: null,
  currentPollMs: 4000,
};

// ─── Utilities ────────────────────────────────────────────────────────────────
const el        = (id) => document.getElementById(id);
const fmt       = (v, d = 2) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const qty       = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const keyFor    = (q) => `${q.exchange || 'NSEEQ'}:${q.instrumentId || q.id}`;
const esc       = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function quoteFromPrice(quote, index = 0, prevQuote = null) {
  const lastPrice  = Number(quote.lastPrice ?? quote.ltp ?? 0);
  const pctChange  = Number(quote.pctChange ?? quote.changePercent ?? 0);
  // pcClose: use explicit close field; if 0/missing, derive from lastPrice + pctChange
  let pcClose = Number(quote.close ?? quote.previousClose ?? 0);
  if (!pcClose && lastPrice && pctChange) pcClose = lastPrice / (1 + pctChange / 100);
  if (!pcClose) pcClose = lastPrice;
  const spread = Math.max(lastPrice * .001, .05);

  // Guard all numerical fields against 0 (not just null)
  const safeNum = (v, fallback) => { const n = Number(v ?? 0); return n > 0 ? n : fallback; };

  const open       = safeNum(quote.open,         pcClose * .998);
  const high       = safeNum(quote.high,         lastPrice * 1.013);
  const low        = safeNum(quote.low,          lastPrice * .988);
  const bidPrice   = safeNum(quote.bestBidPrice, lastPrice - spread);
  const offerPrice = safeNum(quote.bestAskPrice, lastPrice + spread);
  const bidQty     = safeNum(quote.bestBidQty  ?? quote.bestBidQuantity,  100 + index * 17);
  const offerQty   = safeNum(quote.bestAskQty  ?? quote.bestAskQuantity,  120 + index * 19);
  const totalQty   = safeNum(quote.tradedVolume ?? quote.totalQty,         80000 + index * 11457);
  const week52High = safeNum(quote.week52High,   lastPrice * (1.025 + (index % 3) * .02));
  const week52Low  = safeNum(quote.week52Low,    lastPrice * (.72  - (index % 3) * .02));

  // Tick direction: compare to previous quote's lastPrice
  const prevPrice = prevQuote?.lastPrice ?? null;
  const tickDir   = prevPrice === null ? 'flat'
                  : lastPrice > prevPrice ? 'up'
                  : lastPrice < prevPrice ? 'down'
                  : 'flat';

  return {
    id: quote.id || quote.instrumentId || String(index),
    instrumentId: String(quote.instrumentId || quote.id || index),
    symbol: quote.symbol || quote.tradingSymbol || `SCRIP${index + 1}`,
    exchange: quote.exchange || 'NSEEQ',
    segment: quote.segment || ((quote.exchange || '').endsWith('FO') ? 'F&O' : 'Equity'),
    lastPrice, pctChange, pcClose,
    bidPrice, bidQty, offerPrice, offerQty,
    open, high, low, totalQty,
    week52High, week52Low,
    tickDir,
    updatedAt: quote.updatedAt || new Date().toISOString(),
  };
}

function matchesFilters(quote) {
  const exchange = String(quote.exchange || '').toUpperCase();
  const segment  = quote.segment || (exchange.endsWith('FO') ? 'F&O' : 'Equity');
  return (state.filters.exchange === 'ALL' || exchange.startsWith(state.filters.exchange))
      && (state.filters.segment  === 'ALL' || segment === state.filters.segment);
}

// ─── Market Table Rendering ────────────────────────────────────────────────────
function renderWatchlistMeta() {
  const { count = state.quotes.length, max = 400 } = state.watchlist;
  const label    = `${count} / ${max} Scripts`;
  const capacity = el('watchlist-capacity');
  capacity.textContent = label;
  capacity.classList.toggle('full', count >= max);
  el('script-count').textContent = label;
  el('watch-scope').textContent  = `${state.filters.exchange === 'ALL' ? 'All Exchanges' : state.filters.exchange} · ${state.filters.segment}`;
}

function renderMarket() {
  const quotes = state.quotes.filter(matchesFilters);
  renderWatchlistMeta();
  el('market-body').innerHTML = quotes.map((quote) => {
    const move      = quote.pctChange >= 0 ? 'up' : 'down';
    const rateClass = Math.abs(quote.pctChange) > .25 ? `rate-${move}` : 'plain-rate';
    const selected  = keyFor(quote) === state.selectedKey ? ' selected' : '';
    return `<tr class="${selected}" data-key="${esc(keyFor(quote))}" data-exchange="${esc(quote.exchange)}" data-iid="${esc(quote.instrumentId)}" data-symbol="${esc(quote.symbol)}">
      <td>${esc(quote.exchange.slice(0,1))}</td><td>${esc(quote.exchange.includes('FO')?'F':'C')}</td><td>⌁</td><td class="${move}-arrow">${quote.pctChange>=0?'▲':'▼'}</td><td></td>
      <td class="symbol">${esc(quote.symbol)}</td><td class="${rateClass}">${fmt(quote.lastPrice)}</td><td class="${move==='up'?'positive-text':'negative-text'}">${quote.pctChange.toFixed(2)}</td>
      <td>${qty(quote.bidQty)}</td><td>${fmt(quote.bidPrice)}</td><td>${qty(quote.offerQty)}</td><td>${fmt(quote.offerPrice)}</td>
      <td>${fmt(quote.open)}</td><td>${fmt(quote.high)}</td><td>${fmt(quote.low)}</td><td>${fmt(quote.pcClose)}</td><td>${qty(quote.totalQty)}</td>
      <td class="find-cell"><button class="remove-scrip" data-key="${esc(keyFor(quote))}" title="Remove ${esc(quote.symbol)}" aria-label="Remove ${esc(quote.symbol)}">×</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="18" class="empty-watchlist">No scrips match these filters.</td></tr>';
}

// ─── Search / Symbol Lookup ────────────────────────────────────────────────────
function renderSearchResults() {
  const results = el('symbol-results');
  const items   = state.suggestions;
  results.classList.toggle('hidden', !items.length);
  el('symbol-search').setAttribute('aria-expanded', String(Boolean(items.length)));
  results.innerHTML = items.map((item, i) =>
    `<button class="symbol-result${state.selectedSuggestion === item ? ' active' : ''}" type="button" data-result-index="${i}" role="option" aria-selected="${state.selectedSuggestion === item}">
      <strong>${esc(item.symbol)}</strong><span>${esc(item.exchange)} · ${esc(item.segment || 'Equity')} · Token ${esc(item.instrumentId)}</span>
    </button>`
  ).join('');
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
    const params   = new URLSearchParams({ q: query, exchange: state.filters.exchange, segment: state.filters.segment });
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

// ─── Bottom Dock (News & Calls) ───────────────────────────────────────────────
function renderNews() {
  const items = [['DJ','12:21:00 PM','BBTC: Market breadth remains positive in early trade'],['DJ','12:27:00 PM','Shares move higher as banking stocks extend gains'],['DJ','12:35:00 PM','Global cues and commodity prices guide afternoon session'],['DL','12:42:00 PM','NSE market update: volume leaders refresh']];
  el('news-list').innerHTML = items.map(([s,t,x]) => `<div class="news-row"><span class="source">${s}</span><time>${t}</time><span>${x}</span></div>`).join('');
}
function renderCalls() {
  const calls = [['BUY','RELIANCE','Strength above day high · Target ₹3,200'],['BUY','INFY','Momentum watch · Target ₹1,800'],['SELL','TATASTEEL','Weak below support · Stop ₹155'],['BUY','HDFCBANK','Accumulation zone · Medium term']];
  el('calls-list').innerHTML = calls.map(([side,sym,note]) => `<div class="call-row"><span class="call-side ${side.toLowerCase()}">${side}</span><strong>${sym}</strong><span class="call-note">${note}</span></div>`).join('');
}

// ─── Analysis Window ──────────────────────────────────────────────────────────
function analysisOptions() {
  const en = (n) => document.querySelector(`[data-analysis-filter="${n}"]`)?.checked ?? false;
  return { nse: en('nse'), bse: en('bse'), cash: en('cash'), fo: en('fo'), high: en('high'), low: en('low') };
}

function highDistance(q) { return Math.max(0, ((q.week52High - q.lastPrice) / q.week52High) * 100); }
function lowDistance(q)  { return Math.max(0, ((q.lastPrice - q.week52Low)  / q.week52Low)  * 100); }

function analysisRows() {
  const opts = analysisOptions();
  if (state.analysisTab === 'action') {
    return state.actionWatch.filter((e) => {
      const ex = String(e.exchange || '').toUpperCase();
      const isFO = (e.segment || '').toUpperCase() === 'F&O' || ex.endsWith('FO');
      return (ex.startsWith('NSE') ? opts.nse : ex.startsWith('BSE') ? opts.bse : false)
          && (isFO ? opts.fo : opts.cash)
          && (e.status === 'New High' ? opts.high : opts.low);
    }).slice(0, 100);
  }
  let rows = state.quotes.filter((q) => {
    const ex = String(q.exchange || '').toUpperCase();
    const isFO = (q.segment || '').toUpperCase() === 'F&O' || ex.endsWith('FO');
    return (ex.startsWith('NSE') ? opts.nse : ex.startsWith('BSE') ? opts.bse : false)
        && (isFO ? opts.fo : opts.cash);
  });
  if (state.analysisTab === 'high')    { if (!opts.high) return []; rows = rows.filter(q => highDistance(q) <= 5).sort((a,b) => highDistance(a) - highDistance(b)); }
  else if (state.analysisTab === 'low')     { if (!opts.low)  return []; rows = rows.filter(q => lowDistance(q)  <= 5).sort((a,b) => lowDistance(a)  - lowDistance(b)); }
  else if (state.analysisTab === 'gainers') rows = rows.filter(q => q.pctChange > 0).sort((a,b) => b.pctChange - a.pctChange);
  else if (state.analysisTab === 'losers')  rows = rows.filter(q => q.pctChange < 0).sort((a,b) => a.pctChange - b.pctChange);
  else if (state.analysisTab === 'quantity' || state.analysisTab === 'traded') rows.sort((a,b) => b.totalQty - a.totalQty);
  else rows = rows.filter(q => (opts.high && highDistance(q) <= 5) || (opts.low && lowDistance(q) <= 5) || Math.abs(q.pctChange) >= 1).sort((a,b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));
  return rows.slice(0, 12);
}

function analysisStatus(q) {
  if (state.analysisTab === 'high')    return ['Near 52W High','new-high'];
  if (state.analysisTab === 'low')     return ['Near 52W Low','new-low'];
  if (state.analysisTab === 'gainers') return ['Gaining','new-high'];
  if (state.analysisTab === 'losers')  return ['Losing','new-low'];
  if (state.analysisTab === 'quantity' || state.analysisTab === 'traded') return ['High Volume','analysis-neutral'];
  if (highDistance(q) <= 5) return ['Near 52W High','new-high'];
  if (lowDistance(q)  <= 5) return ['Near 52W Low','new-low'];
  return q.pctChange >= 0 ? ['Gaining','new-high'] : ['Losing','new-low'];
}

// ─── 52-Week Full Market Screener ────────────────────────────────────────────────
// Client-side cache: exchange:type -> instrument array
const week52ClientCache = {};

function screenerExchange() {
  return (el('screener-exchange')?.value || 'NSEEQ').toUpperCase();
}
function screenerQuery() {
  return (el('screener-search')?.value || '').trim().toUpperCase();
}

/** Toggle between regular checkbox filters (other tabs) and screener bar (52W tabs) */
function setScreenerMode(on) {
  const fb = el('analysis-filters-bar');
  const sb = el('screener-bar');
  if (fb) fb.classList.toggle('is-hidden',  on);
  if (sb) sb.classList.toggle('is-hidden', !on);
}

async function load52WeekData(type, exchange) {
  const ex  = (exchange || screenerExchange()).toUpperCase();
  const key = `${ex}:${type}`;
  if (week52ClientCache[key]) return week52ClientCache[key]; // client cache hit
  try {
    const r = await fetch(`/api/52week?type=${type}&exchange=${ex}`);
    if (!r.ok) throw new Error('Server error');
    const data = await r.json();
    week52ClientCache[key] = Array.isArray(data.instruments) ? data.instruments : [];
    return week52ClientCache[key];
  } catch (_) { return []; }
}

/** Client-side symbol filter */
function filterByQuery(instruments) {
  const q = screenerQuery();
  return q ? instruments.filter((i) => i.symbol.toUpperCase().includes(q)) : instruments;
}

/**
 * Render the 52W screener table.
 * Limits DOM rows to 500 for performance; search narrows results further.
 */
function render52WeekTable(allInstruments, type) {
  const MAX_ROWS = 500;
  const isHigh   = type !== 'low';
  const filtered = filterByQuery(allInstruments);
  const rows     = filtered.slice(0, MAX_ROWS);

  // Update count badge
  const sc = el('screener-count');
  if (sc) {
    const total  = allInstruments.length;
    const shown  = rows.length;
    const more   = filtered.length > MAX_ROWS ? ` of ${filtered.length.toLocaleString('en-IN')} matches` : '';
    sc.textContent = `${total.toLocaleString('en-IN')} instruments · showing ${shown.toLocaleString('en-IN')}${more}`;
  }

  if (!filtered.length) {
    el('analysis-body').innerHTML = `<tr><td colspan="7" class="analysis-empty">No instruments match your search.</td></tr>`;
    return;
  }

  el('analysis-body').innerHTML = rows.map((item) => {
    const dist  = isHigh ? item.distanceFromHigh : item.distanceFromLow;
    const level = isHigh ? item.week52High        : item.week52Low;
    const cls   = isHigh ? 'new-high'              : 'new-low';
    const badge = dist <= 1
      ? (isHigh ? '🔴 AT 52W HIGH' : '🟢 AT 52W LOW')
      : `${dist.toFixed(2)}% ${isHigh ? 'below 52W High' : 'above 52W Low'}`;
    const chgCls = item.pctChange >= 0 ? 'positive-text' : 'negative-text';
    return `<tr>
      <td>${esc(item.exchange.slice(0,1))}</td>
      <td>${esc(item.exchange)}</td>
      <td>${esc(item.instrumentId)}</td>
      <td><strong>${esc(item.symbol)}</strong></td>
      <td class="${cls}">${badge}</td>
      <td class="analysis-rate">${fmt(item.lastPrice)}&thinsp;<span class="${chgCls}" style="font-size:9px">(${item.pctChange>=0?'+':''}${item.pctChange.toFixed(2)}%)</span></td>
      <td class="analysis-rate" style="color:#8fa8aa">${fmt(level)}</td>
    </tr>`;
  }).join('');
}

async function renderAnalysis() {
  const tabName = document.querySelector(`[data-analysis-tab="${state.analysisTab}"]`)?.textContent || 'Action Watch';
  el('analysis-summary').textContent = `${tabName} · ${state.session.mode === 'LIVE' ? 'live IIFL market conditions' : 'simulation market conditions'}`;

  // ── 52W Screener tabs: full-market fetch from server ───────────────────────────
  if (state.analysisTab === 'high' || state.analysisTab === 'low') {
    setScreenerMode(true);
    const type     = state.analysisTab;
    const exchange = screenerExchange();
    el('analysis-body').innerHTML = `<tr><td colspan="7" class="analysis-empty screener-loading">⏳ Fetching all ${exchange} instruments from IIFL market data…</td></tr>`;
    if (el('screener-count')) el('screener-count').textContent = '';
    const data = await load52WeekData(type, exchange);
    if (!data.length) {
      el('analysis-body').innerHTML = `<tr><td colspan="7" class="analysis-empty">No data available. In simulation mode only instruments in the contract file are shown.</td></tr>`;
      return;
    }
    render52WeekTable(data, type);
    return;
  }

  // ── All other tabs: watchlist-based ────────────────────────────────────────────
  setScreenerMode(false);
  const rows = analysisRows();
  // ── Action Watch tab ────────────────────────────────────────────────────────
  if (state.analysisTab === 'action') {
    if (!state.actionWatch.length) {
      el('analysis-body').innerHTML = '<tr><td colspan="7" class="analysis-empty">Monitoring market watch scrips for intraday new highs and lows. Alerts will appear here as prices breach their session levels.</td></tr>';
      return;
    }
    const opts = analysisOptions();
    const visible = state.actionWatch.filter((e) => {
      const ex   = String(e.exchange || '').toUpperCase();
      const isFO = (e.segment || '').toUpperCase() === 'F&O' || ex.endsWith('FO');
      return (ex.startsWith('NSE') ? opts.nse : ex.startsWith('BSE') ? opts.bse : true)
          && (isFO ? opts.fo : opts.cash)
          && (e.status === 'New High' ? opts.high : opts.low);
    }).slice(0, 200);

    if (!visible.length) {
      el('analysis-body').innerHTML = '<tr><td colspan="7" class="analysis-empty">No alerts match the selected filters.</td></tr>';
      return;
    }

    // Row color = TICK DIRECTION at the moment the alert fired
    // Green (analysis-tick-up)   = up-tick   / positive price movement
    // Pink  (analysis-tick-down) = down-tick  / negative price movement  
    // Dim   (analysis-tick-flat) = flat / neutral
    el('analysis-body').innerHTML = visible.map((e) => {
      const statusCls = e.status === 'New High' ? 'new-high' : 'new-low';
      const dir       = e.direction || 'flat';
      const ts        = new Date(e.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<tr class="action-row action-tick-${esc(dir)}">
        <td class="ac-ex">${esc(e.exchange.slice(0, 1))}</td>
        <td class="ac-seg">${esc(e.segment === 'F&O' ? 'F' : 'C')}</td>
        <td class="ac-tok">${esc(e.instrumentId)}</td>
        <td class="ac-sym">${esc(e.symbol)}</td>
        <td class="ac-status ${statusCls}">${esc(e.status)}</td>
        <td class="ac-rate analysis-rate">${fmt(e.lastPrice)}</td>
        <td class="ac-time">${ts}</td>
      </tr>`;
    }).join('');
    return;
  }
  el('analysis-body').innerHTML = rows.map((q) => {
    const [statusLabel, cls] = analysisStatus(q);
    return `<tr>
      <td>${esc(q.exchange.slice(0,1))}</td><td>${esc(q.exchange)}</td>
      <td>${esc(q.instrumentId)}</td><td>${esc(q.symbol)}</td>
      <td class="${cls}">${statusLabel}</td>
      <td class="analysis-rate">${fmt(q.lastPrice)}</td>
      <td>${new Date(q.updatedAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="analysis-empty">No scrips match the selected analysis filters.</td></tr>';
}

function showAnalysis() { el('analysis-window').classList.remove('is-hidden'); renderAnalysis(); }
function closeAnalysis() { el('analysis-window').classList.add('is-hidden'); }
function toast(message) {
  const target = el('toast');
  target.textContent = message;
  target.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove('show'), 2600);
}

// ─── Session / Payload ────────────────────────────────────────────────────────
function setSession(session) {
  state.session = session || state.session;
  const live   = state.session.mode === 'LIVE';
  const status = el('connection-status');
  status.classList.toggle('live',  live);
  status.classList.toggle('error', state.session.mode === 'ERROR');
  status.querySelector('span').textContent = live ? 'IIFL connected' : state.session.mode === 'ERROR' ? 'Connection error' : 'Simulation';
  const connect = el('connect-iifl');
  connect.textContent = live ? 'IIFL Connected' : 'Connect IIFL';
  connect.classList.toggle('connected', live);
  saveSessionMeta(session);
}

function updatePollInterval(session) {
  const desiredMs = (session?.pollIntervalMs) || (state.session.mode === 'LIVE' ? 2000 : 4000);
  if (desiredMs !== state.currentPollMs) {
    state.currentPollMs = desiredMs;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => refreshQuotes(true), state.currentPollMs);
    console.log(`[poll] Interval updated to ${state.currentPollMs}ms (${state.session.mode})`); 
  }
}

function applyTerminalPayload(data) {
  if (Array.isArray(data.quotes)) {
    // Build a map of previous quotes so we can compute per-tick direction
    const prevMap = new Map(state.quotes.map((q) => [keyFor(q), q]));
    state.quotes  = data.quotes.map((q, i) => {
      const key  = `${(q.exchange || 'NSEEQ')}:${(q.instrumentId || q.id || i)}`;
      return quoteFromPrice(q, i, prevMap.get(key) || null);
    });
  }
  if (data.watchlist) {
    state.watchlist = data.watchlist;
    if (Array.isArray(data.watchlist.items)) saveWatchlistCache(data.watchlist.items);
  }
  if (Array.isArray(data.actionWatch)) state.actionWatch = data.actionWatch;
  setSession(data.session);
  updatePollInterval(data.session); // Adapt poll speed if mode changed (e.g. just connected IIFL)
  if (state.selectedKey && !state.quotes.some((q) => keyFor(q) === state.selectedKey)) state.selectedKey = null;
  renderMarket();
  renderAnalysis();
}

async function getSession() {
  try { const r = await fetch('/api/session'); if (r.ok) setSession(await r.json()); } catch (_) {}
}

async function loadWatchlist() {
  const cached = loadWatchlistCache();
  if (cached && cached.length) {
    state.watchlist = { count: cached.length, max: 400, items: cached };
    state.quotes    = cached.map((item, i) => quoteFromPrice({ ...item, lastPrice: 100, pctChange: 0 }, i));
    renderMarket();
  }
  try {
    const r = await fetch('/api/watchlist');
    if (!r.ok) throw new Error('Unable to load watchlist');
    applyTerminalPayload(await r.json());
  } catch (_) { renderMarket(); }
}

async function refreshQuotes(silent = false) {
  try {
    const r = await fetch('/api/market-watch/refresh', { method: 'POST' });
    if (!r.ok) throw new Error('Unable to refresh quotes');
    const data = await r.json();
    applyTerminalPayload(data);
    if (!silent) toast(data.session?.mode === 'LIVE' ? 'Live IIFL quotes refreshed' : 'Simulation quotes refreshed');
  } catch (_) {
    // Offline fallback: advance locally with tick direction tracking
    state.quotes = state.quotes.map((q, i) => {
      const prev    = q; // current quote becomes the "previous" for tickDir
      const updated = { ...q,
        lastPrice: +(q.lastPrice * (1 + (Math.random() - .49) * .0015)).toFixed(2),
        pctChange: +(q.pctChange + (Math.random() - .5) * .08).toFixed(2),
      };
      return quoteFromPrice(updated, i, prev);
    });
    renderMarket(); renderAnalysis();
    if (!silent) toast('Showing local simulation quotes');
  }
}

async function addScrip() {
  const instrument = state.selectedSuggestion || state.suggestions[0];
  if (!instrument) { toast('Choose a symbol from the search results first.'); return; }
  try {
    const r    = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(instrument) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || data.error || 'Could not add scrip');
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
  const quote = state.quotes.find((q) => keyFor(q) === key);
  try {
    const r    = await fetch(`/api/watchlist/${encodeURIComponent(exchange)}/${encodeURIComponent(instrumentId)}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || data.error || 'Could not remove scrip');
    if (state.selectedKey === key) state.selectedKey = null;
    applyTerminalPayload(data);
    toast(`${quote?.symbol || 'Scrip'} removed from the watchlist.`);
  } catch (error) { toast(error.message); }
}

// ─── Chart Panel ──────────────────────────────────────────────────────────────

function chartPanelHtml() {
  return `
<section id="chart-panel" class="chart-panel is-hidden" role="dialog" aria-modal="true" aria-labelledby="chart-title">
  <header class="chart-header">
    <div class="chart-header-left">
      <span id="chart-title" class="chart-symbol-name">—</span>
      <span id="chart-mode-badge" class="chart-sim-badge"></span>
    </div>
    <div class="chart-period-tabs" role="tablist">
      <button class="chart-period-btn active" data-period="7d">7D</button>
      <button class="chart-period-btn" data-period="1m">1M</button>
      <button class="chart-period-btn" data-period="1y">1Y</button>
      <button class="chart-period-btn" data-period="lifetime">Lifetime</button>
    </div>
    <button id="chart-close" class="chart-close-btn" aria-label="Close chart">×</button>
  </header>
  <div class="chart-stats" id="chart-stats"></div>
  <div class="chart-canvas-wrap">
    <canvas id="chart-canvas" class="chart-canvas"></canvas>
    <div id="chart-loading" class="chart-loading">Loading chart data…</div>
    <div id="chart-tooltip" class="chart-tooltip" aria-live="polite"></div>
  </div>
</section>`;
}

function injectChartPanel() {
  const div = document.createElement('div');
  div.innerHTML = chartPanelHtml();
  document.body.appendChild(div.firstElementChild);
}

function openChart(exchange, instrumentId, symbol) {
  state.chart.exchange     = exchange;
  state.chart.instrumentId = instrumentId;
  state.chart.symbol       = symbol;
  state.chart.visible      = true;
  el('chart-panel').classList.remove('is-hidden');
  el('chart-title').textContent = symbol || instrumentId;
  loadChart(state.chart.period);
}

function closeChart() {
  state.chart.visible = false;
  el('chart-panel').classList.add('is-hidden');
}

async function loadChart(period) {
  state.chart.period = period;
  // Update active tab
  document.querySelectorAll('.chart-period-btn').forEach((b) => b.classList.toggle('active', b.dataset.period === period));

  const { exchange, instrumentId } = state.chart;
  if (!instrumentId) return;

  el('chart-loading').style.display = 'flex';
  el('chart-loading').textContent   = 'Loading chart data…';
  el('chart-tooltip').textContent   = '';
  el('chart-stats').innerHTML       = '';

  try {
    const r    = await fetch(`/api/chart/${encodeURIComponent(exchange)}/${encodeURIComponent(instrumentId)}?period=${period}`);
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      // Server returned an error (e.g. 503 when IIFL has no historical data for this scrip)
      const msg = data.message || `Chart data unavailable (HTTP ${r.status})`;
      el('chart-loading').textContent = msg;
      el('chart-loading').style.display = 'flex';
      el('chart-mode-badge').textContent = state.session.mode === 'LIVE' ? '(Live — no data)' : '(Error)';
      return;
    }

    state.chart.candles   = data.candles || [];
    state.chart.simulated = data.simulated || false;
    el('chart-mode-badge').textContent = data.simulated ? '⚠ Simulation' : '● Live';
    el('chart-mode-badge').style.color  = data.simulated ? '#c97a00' : '#22cc66';
    renderChart(data.candles, period);
    renderChartStats(data.candles);
  } catch (error) {
    el('chart-loading').textContent   = `Chart error: ${error.message}`;
    el('chart-loading').style.display = 'flex';
  }
}

function renderChartStats(candles) {
  if (!candles || !candles.length) { el('chart-stats').innerHTML = ''; return; }
  const opens  = candles.map(c => c.o);
  const highs  = candles.map(c => c.h);
  const lows   = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  const first  = closes[0];
  const last   = closes[closes.length - 1];
  const chg    = ((last - first) / first) * 100;
  const maxH   = Math.max(...highs);
  const minL   = Math.min(...lows);
  el('chart-stats').innerHTML =
    `<span class="cstat"><label>Open</label><b>${fmt(opens[0])}</b></span>` +
    `<span class="cstat"><label>High</label><b class="stat-green">${fmt(maxH)}</b></span>` +
    `<span class="cstat"><label>Low</label><b class="stat-red">${fmt(minL)}</b></span>` +
    `<span class="cstat"><label>Close</label><b>${fmt(last)}</b></span>` +
    `<span class="cstat"><label>Chg</label><b class="${chg>=0?'stat-green':'stat-red'}">${chg>=0?'+':''}${chg.toFixed(2)}%</b></span>`;
}

/**
 * Draw a candlestick chart on <canvas id="chart-canvas">.
 * Pure Canvas 2D — no external dependencies.
 */
function renderChart(candles, period) {
  const loading = el('chart-loading');
  const canvas  = el('chart-canvas');
  const tooltip = el('chart-tooltip');
  loading.style.display = 'none';

  if (!candles || candles.length === 0) {
    loading.textContent    = 'No chart data available.';
    loading.style.display  = 'flex';
    return;
  }

  // Size canvas to its CSS container
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth  || 800;
  canvas.height = wrap.clientHeight || 320;

  const ctx      = canvas.getContext('2d');
  const W        = canvas.width;
  const H        = canvas.height;
  const padL     = 8, padR = 60, padT = 16, padB = 40;
  const chartW   = W - padL - padR;
  const chartH   = H - padT - padB;

  const highs  = candles.map(c => c.h);
  const lows   = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  const maxP   = Math.max(...highs);
  const minP   = Math.min(...lows);
  const priceRange = maxP - minP || 1;

  const toX = (i) => padL + (i / (candles.length - 1 || 1)) * chartW;
  const toY = (p) => padT + chartH - ((p - minP) / priceRange) * chartH;

  // Background
  ctx.fillStyle = '#060b0c';
  ctx.fillRect(0, 0, W, H);

  // Grid lines (price axis)
  ctx.strokeStyle = '#1a2124';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 5; i++) {
    const y = padT + (chartH / 5) * i;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    const price = maxP - (priceRange / 5) * i;
    ctx.fillStyle = '#5a7070';
    ctx.font      = '10px Tahoma,Arial,sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(fmt(price), W - padR + 4, y + 4);
  }

  // Candle width
  const totalCandles = candles.length;
  const candleW = Math.max(2, Math.min(18, (chartW / totalCandles) * 0.7));
  const spacing = chartW / totalCandles;

  // Area under close-line fill
  const gradient = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  const isPositive = closes[closes.length - 1] >= closes[0];
  gradient.addColorStop(0, isPositive ? 'rgba(0,180,80,0.18)' : 'rgba(220,30,50,0.18)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(toX(0), padT + chartH);
  candles.forEach((c, i) => ctx.lineTo(toX(i), toY(c.c)));
  ctx.lineTo(toX(candles.length - 1), padT + chartH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Candles
  candles.forEach((c, i) => {
    const x      = padL + spacing * i + spacing / 2;
    const open   = toY(c.o);
    const close  = toY(c.c);
    const high   = toY(c.h);
    const low    = toY(c.l);
    const isUp   = c.c >= c.o;
    const color  = isUp ? '#19d166' : '#ff3040';

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, high);
    ctx.lineTo(x, low);
    ctx.stroke();

    // Body
    const bodyTop = Math.min(open, close);
    const bodyH   = Math.max(1, Math.abs(open - close));
    ctx.fillStyle = color;
    if (candleW < 3) {
      ctx.fillRect(x - 0.5, bodyTop, 1, bodyH);
    } else {
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
      if (isUp) {
        ctx.strokeStyle = '#0fa04a';
        ctx.lineWidth   = 0.5;
        ctx.strokeRect(x - candleW / 2, bodyTop, candleW, bodyH);
      }
    }
  });

  // Close line
  ctx.beginPath();
  ctx.strokeStyle = isPositive ? '#19d166' : '#ff3040';
  ctx.lineWidth   = 1.5;
  candles.forEach((c, i) => {
    const x = padL + spacing * i + spacing / 2;
    if (i === 0) ctx.moveTo(x, toY(c.c)); else ctx.lineTo(x, toY(c.c));
  });
  ctx.stroke();

  // Date labels (X axis)
  ctx.fillStyle = '#5a7070';
  ctx.font      = '10px Tahoma,Arial,sans-serif';
  ctx.textAlign = 'center';
  const labelStep = Math.ceil(totalCandles / 8);
  candles.forEach((c, i) => {
    if (i % labelStep !== 0 && i !== candles.length - 1) return;
    const x   = padL + spacing * i + spacing / 2;
    const dt  = new Date(c.t);
    const lbl = period === '7d' || period === '1m'
      ? dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
      : period === '1y'
      ? dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
      : dt.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    ctx.fillText(lbl, x, H - padB + 14);
  });

  // Crosshair tooltip on mouse move
  canvas.onmousemove = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const mx   = ev.clientX - rect.left;
    const idx  = Math.round((mx - padL - spacing / 2) / spacing);
    if (idx < 0 || idx >= candles.length) { tooltip.style.display = 'none'; return; }
    const c   = candles[idx];
    const dt  = new Date(c.t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    tooltip.style.display = 'block';
    tooltip.innerHTML =
      `<b>${dt}</b><br>O: ${fmt(c.o)} &nbsp; H: ${fmt(c.h)} &nbsp; L: ${fmt(c.l)} &nbsp; C: ${fmt(c.c)} &nbsp; Vol: ${qty(c.v)}`;
  };
  canvas.onmouseleave = () => { tooltip.style.display = 'none'; };
}

// Handle window resize
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.chart.visible && state.chart.candles.length) {
      renderChart(state.chart.candles, state.chart.period);
    }
  }, 200);
});

// ─── Event Binding ────────────────────────────────────────────────────────────
function bindEvents() {
  // Restore filter dropdowns from localStorage
  el('exchange-filter').value = state.filters.exchange;
  el('segment-filter').value  = state.filters.segment;

  el('terminal-clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
  setInterval(() => { el('terminal-clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false }); }, 1000);

  for (const f of ['exchange-filter', 'segment-filter']) {
    el(f).addEventListener('change', () => {
      state.filters.exchange = el('exchange-filter').value;
      state.filters.segment  = el('segment-filter').value;
      saveFilters(state.filters);
      renderMarket();
      if (el('symbol-search').value.trim().length >= 2) searchInstruments();
    });
  }

  el('symbol-search').addEventListener('input', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(searchInstruments, 180); });
  el('symbol-search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')  { ev.preventDefault(); addScrip(); }
    if (ev.key === 'Escape') { state.suggestions = []; renderSearchResults(); }
  });
  el('symbol-results').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-result-index]');
    if (btn) chooseSuggestion(state.suggestions[Number(btn.dataset.resultIndex)]);
  });
  el('add-scrip').addEventListener('click', addScrip);

  // Market table: single click → select row (CSS only, no re-render) + open chart
  // Remove button (×) still removes the scrip.
  el('market-body').addEventListener('click', (ev) => {
    const remove = ev.target.closest('.remove-scrip');
    if (remove) { removeScrip(remove.dataset.key); return; }
    const row = ev.target.closest('tr[data-key]');
    if (!row) return;
    // Toggle selected highlight WITHOUT rebuilding the whole table (avoids dblclick race)
    el('market-body').querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    state.selectedKey = row.dataset.key;
    // Single click opens the chart panel
    openChart(row.dataset.exchange, row.dataset.iid, row.dataset.symbol);
  });

  // Chart panel events
  el('chart-close').addEventListener('click', closeChart);
  document.querySelectorAll('.chart-period-btn').forEach((btn) =>
    btn.addEventListener('click', () => loadChart(btn.dataset.period))
  );
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeAnalysis(); closeChart(); }
    if (ev.key === 'F7')     { ev.preventDefault(); showAnalysis(); }
  });

  el('remove-selected').addEventListener('click', () => removeScrip(state.selectedKey));
  el('open-action-watch').addEventListener('click', showAnalysis);
  el('open-action-watch-secondary').addEventListener('click', showAnalysis);
  el('close-analysis').addEventListener('click', closeAnalysis);
  el('refresh-quotes').addEventListener('click', () => refreshQuotes());
  el('analysis-refresh').addEventListener('click', () => {
    // On 52W tabs, bust client cache to force a server re-fetch
    if (state.analysisTab === 'high' || state.analysisTab === 'low') {
      const ex  = screenerExchange();
      delete week52ClientCache[`${ex}:high`];
      delete week52ClientCache[`${ex}:low`];
      renderAnalysis();
    } else {
      refreshQuotes();
    }
  });
  el('news-refresh').addEventListener('click', () => { renderNews(); toast('News wire refreshed'); });
  el('connect-iifl').addEventListener('click', () => { if (state.session.mode !== 'LIVE') window.location.assign('/auth/login'); });

  document.querySelectorAll('[data-analysis-tab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.analysisTab = btn.dataset.analysisTab;
      document.querySelectorAll('[data-analysis-tab]').forEach((t) => t.classList.toggle('active', t === btn));
      renderAnalysis();
    })
  );
  document.querySelectorAll('[data-analysis-filter]').forEach((cb) => cb.addEventListener('change', renderAnalysis));

  // Screener bar — exchange selector & symbol search (for 52W tabs)
  el('screener-exchange')?.addEventListener('change', () => {
    const ex = screenerExchange();
    // Bust client cache for this exchange so we fetch fresh data
    delete week52ClientCache[`${ex}:high`];
    delete week52ClientCache[`${ex}:low`];
    renderAnalysis();
  });
  let screenerSearchTimer = null;
  el('screener-search')?.addEventListener('input', () => {
    clearTimeout(screenerSearchTimer);
    screenerSearchTimer = setTimeout(() => {
      // Re-render using already-fetched data (client-side filter only)
      const cached = week52ClientCache[`${screenerExchange()}:${state.analysisTab}`];
      if (cached) render52WeekTable(cached, state.analysisTab);
    }, 120);
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function initialize() {
  injectChartPanel();
  renderNews();
  renderCalls();
  renderWatchlistMeta();
  bindEvents();
  await getSession();
  await loadWatchlist();
  await refreshQuotes(true);
  // Start polling at the rate appropriate for the current mode.
  // updatePollInterval() will keep adjusting this whenever the mode changes.
  const initMs = state.session.mode === 'LIVE' ? 2000 : 4000;
  state.currentPollMs = initMs;
  state.pollTimer = setInterval(() => refreshQuotes(true), initMs);
}

initialize();
