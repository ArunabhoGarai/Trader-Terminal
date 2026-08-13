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
  localSearch: '',
  sortByPctDesc: false,
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
  isEditMode: false,
};

let chartInstance = null;
let candleSeries = null;
let areaSeries = null;
let activeChartQuote = null;
let activeTimeframe = 'advanced';
let currentLiveCandle = null;
let sortableInstance = null;

const el = (id) => document.getElementById(id);
const fmt = (value, digits = 2) => (value === null || value === undefined || isNaN(Number(value)) || value === '' || Number(value) === 0) ? '-' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
  if (state.filters.exchange !== 'ALL' && quote.exchange !== state.filters.exchange && !quote.exchange.includes(state.filters.exchange)) return false;
  if (state.filters.segment !== 'ALL' && quote.segment !== state.filters.segment) return false;
  if (state.localSearch && !quote.symbol.toLowerCase().startsWith(state.localSearch.toLowerCase())) return false;
  return true;
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
  if (state.isEditMode) return;
  const searchInput = el('local-search');
  if (searchInput && state.localSearch !== searchInput.value.toLowerCase()) {
    state.localSearch = searchInput.value.toLowerCase();
  }
  let quotes = state.quotes.filter(matchesFilters);
  if (state.sortByPctDesc) {
    quotes.sort((a, b) => b.pctChange - a.pctChange);
  }
  renderWatchlistMeta();
  el('market-body').innerHTML = quotes.map((quote) => {
    const move = quote.pctChange >= 0 ? 'up' : 'down';
    const rateClass = quote.pctChange > 0 ? 'rate-up' : (quote.pctChange < 0 ? 'rate-down' : 'plain-rate');
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
    const exchange = String(quote.exchange || 'NSEEQ').toUpperCase();
    const isFutureOption = (quote.segment || '').toUpperCase() === 'F&O' || exchange.endsWith('FO');
    const exchangeAllowed = (exchange.startsWith('NSE') || !quote.exchange) ? options.nse : exchange.startsWith('BSE') ? options.bse : true;
    return exchangeAllowed && (isFutureOption ? options.fo : options.cash);
  });

  let list = [];
  if (state.analysisTab === 'high') {
    if (!options.high) return [];
    list = filterRows(state.marketAnalysis?.highs || []);
  } else if (state.analysisTab === 'low') {
    if (!options.low) return [];
    list = filterRows(state.marketAnalysis?.lows || []);
  } else if (state.analysisTab === 'gainers') {
    list = filterRows(state.marketAnalysis?.gainers || []);
  } else if (state.analysisTab === 'losers') {
    list = filterRows(state.marketAnalysis?.losers || []);
  } else if (state.analysisTab === 'quantity') {
    list = filterRows(state.marketAnalysis?.volume || []);
  } else if (state.analysisTab === 'traded') {
    list = filterRows(state.marketAnalysis?.value || []);
  } else {
    return filterRows(state.quotes).filter((quote) => (options.high && highDistance(quote) <= 5) || (options.low && lowDistance(quote) <= 5) || Math.abs(quote.pctChange) >= 1).sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange)).slice(0, 12);
  }

  const mergeLiveQuote = (item) => {
    const cleanSym = String(item.nseSymbol || item.symbol || '').replace(/-(EQ|BE|SM|ST|BZ|E1|E2|N[1-9]|RR)$/i, '').toUpperCase().trim();
    const live = state.quotes.find((q) => {
      const qSym = String(q.symbol || '').replace(/-(EQ|BE|SM|ST|BZ|E1|E2|N[1-9]|RR)$/i, '').toUpperCase().trim();
      return qSym === cleanSym;
    });
    if (!live) return { ...item, isIIFLRealtime: false };
    return {
      ...item,
      isIIFLRealtime: true,
      lastPrice: live.lastPrice ?? item.lastPrice,
      pctChange: live.pctChange ?? item.pctChange,
      prevClose: live.prevClose ?? item.prevClose,
      high: (live.high && live.high > 0) ? live.high : item.high,
      low: (live.low && live.low > 0) ? live.low : item.low,
      open: (live.open && live.open > 0) ? live.open : item.open,
      tradedVolume: live.tradedVolume || live.volume || item.tradedVolume || item.volume || 0,
      week52High: live.week52High || item.week52High || item.new52WHL || 0,
      week52Low: live.week52Low || item.week52Low || item.new52WHL || 0,
    };
  };

  list = list.map(mergeLiveQuote);

  // Exclude scrips not receiving realtime IIFL data during any sort
  if (state.analysisSortBy) {
    list = list.filter((item) => item.isIIFLRealtime && Number(item.lastPrice) > 0);
  }

  // Column sorting for 52W High, 52W Low, Top Gainers, Top Losers
  if (state.analysisSortBy === 'pct') {
    list.sort((a, b) => (Number(b.pctChange) || 0) - (Number(a.pctChange) || 0));
  } else if (state.analysisSortBy === 'pct_asc') {
    list.sort((a, b) => (Number(a.pctChange) || 0) - (Number(b.pctChange) || 0));
  } else if (state.analysisSortBy === 'vol_asc') {
    list.sort((a, b) => (Number(a.tradedVolume || a.volume || 0)) - (Number(b.tradedVolume || b.volume || 0)));
  } else if (state.analysisSortBy === 'vol') {
    list.sort((a, b) => (Number(b.tradedVolume || b.volume || 0)) - (Number(a.tradedVolume || a.volume || 0)));
  } else if (state.analysisSortBy === 'high') {
    list.sort((a, b) => (Number(b.high || b.week52High) || 0) - (Number(a.high || a.week52High) || 0));
  } else if (state.analysisSortBy === 'high_asc') {
    list.sort((a, b) => (Number(a.high || a.week52High) || 0) - (Number(b.high || b.week52High) || 0));
  } else if (state.analysisSortBy === 'low') {
    list.sort((a, b) => (Number(b.low || b.week52Low) || 0) - (Number(a.low || a.week52Low) || 0));
  } else if (state.analysisSortBy === 'low_asc') {
    list.sort((a, b) => (Number(a.low || a.week52Low) || 0) - (Number(b.low || b.week52Low) || 0));
  }

  return list;
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

  const isActionTab = state.analysisTab === 'action';
  
  const thead = el('analysis-head');
  if (thead) {
    const chgIcon = state.analysisSortBy === 'pct' ? ' ▼' : state.analysisSortBy === 'pct_asc' ? ' ▲' : '';
    const volIcon = state.analysisSortBy === 'vol' ? ' ▼' : state.analysisSortBy === 'vol_asc' ? ' ▲' : '';
    const highIcon = state.analysisSortBy === 'high' ? ' ▼' : state.analysisSortBy === 'high_asc' ? ' ▲' : '';
    const lowIcon = state.analysisSortBy === 'low' ? ' ▼' : state.analysisSortBy === 'low_asc' ? ' ▲' : '';

    const highHeader = `<th id="analysis-sort-high" style="cursor:pointer; user-select:none; color:${state.analysisSortBy?.startsWith('high') ? '#1a73e8' : 'inherit'}">Day High${highIcon}</th>`;
    const lowHeader = `<th id="analysis-sort-low" style="cursor:pointer; user-select:none; color:${state.analysisSortBy?.startsWith('low') ? '#1a73e8' : 'inherit'}">Day Low${lowIcon}</th>`;

    if (isActionTab) {
      thead.innerHTML = `<tr><th>E...</th><th>Exch Type</th><th>Token</th><th>Scrip Name</th><th>Status</th><th>Last Rate</th><th>Time</th></tr>`;
    } else if (state.analysisTab === 'high') {
      thead.innerHTML = `<tr><th>Symbol</th><th>Company Name</th><th>Price</th><th id="analysis-sort-chg" style="cursor:pointer; user-select:none; color:${state.analysisSortBy?.startsWith('pct') ? '#1a73e8' : 'inherit'}">Chg (%Chg)${chgIcon}</th><th>Prev Close</th><th id="analysis-sort-vol" style="cursor:pointer; user-select:none; color:${state.analysisSortBy?.startsWith('vol') ? '#1a73e8' : 'inherit'}">Realtime Volume${volIcon}</th><th>52 Wk High</th>${highHeader}${lowHeader}<th>Open</th></tr>`;
    } else if (state.analysisTab === 'low') {
      thead.innerHTML = `<tr><th>Symbol</th><th>Company Name</th><th>Price</th><th id="analysis-sort-chg" style="cursor:pointer; user-select:none; color:${state.analysisSortBy?.startsWith('pct') ? '#1a73e8' : 'inherit'}">Chg (%Chg)${chgIcon}</th><th>Prev Close</th><th id="analysis-sort-vol" style="cursor:pointer; user-select:none; color:${state.analysisSortBy?.startsWith('vol') ? '#1a73e8' : 'inherit'}">Realtime Volume${volIcon}</th><th>52 Wk Low</th>${highHeader}${lowHeader}<th>Open</th></tr>`;
    } else if (state.analysisTab === 'gainers' || state.analysisTab === 'losers') {
      thead.innerHTML = `<tr><th>Symbol</th><th>Company Name</th><th>Price</th><th id="analysis-sort-chg" style="cursor:pointer; user-select:none; color:${state.analysisSortBy?.startsWith('pct') ? '#1a73e8' : 'inherit'}">Chg (%Chg)${chgIcon}</th><th>Prev Close</th><th id="analysis-sort-vol" style="cursor:pointer; user-select:none; color:${state.analysisSortBy?.startsWith('vol') ? '#1a73e8' : 'inherit'}">Realtime Volume${volIcon}</th>${highHeader}${lowHeader}<th>Open</th></tr>`;
    } else if (state.analysisTab === 'quantity') {
      thead.innerHTML = `<tr><th>Symbol</th><th>Series</th><th>LTP</th><th>Chg (%Chg)</th><th>Total Traded Vol</th><th>Turnover (Cr)</th></tr>`;
    } else if (state.analysisTab === 'traded') {
      thead.innerHTML = `<tr><th>Symbol</th><th>Series</th><th>LTP</th><th>Chg (%Chg)</th><th>Total Traded Vol</th><th>Turnover (Cr)</th></tr>`;
    } else {
      thead.innerHTML = `<tr><th>E...</th><th>Exch Type</th><th>Token</th><th>Scrip Name</th><th>Status</th><th>Last Rate</th><th>52W High</th><th>52W Low</th><th>Time</th></tr>`;
    }
  }

  const rows = analysisRows();
  if (isActionTab) {
    el('analysis-body').innerHTML = rows.map((event) => {
      const dirClass = event.direction === 'up' ? 'analysis-tick-up' : event.direction === 'down' ? 'analysis-tick-down' : 'analysis-tick-flat';
      return `<tr class="${dirClass}">
        <td>${escapeHtml((event.exchange || 'N').slice(0, 1))}</td>
        <td>${escapeHtml(event.segment === 'F&O' ? 'F' : 'C')}</td>
        <td>${escapeHtml(event.instrumentId)}</td>
        <td>${escapeHtml(event.symbol)}</td>
        <td class="analysis-status-cell">${escapeHtml(event.status)}</td>
        <td class="analysis-rate">${fmt(event.lastPrice)}</td>
        <td class="analysis-time">${formatEventTime(event)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="analysis-empty">No new intraday highs or lows yet. Alerts appear when an active Market Watch scrip makes a new day high or low.</td></tr>';

    // Update alert count badge
    updateAlertBadge(rows.length);
    return;
  }

  const fmtChgFull = (quote) => {
    const ltp = Number(quote.lastPrice) || 0;
    const close = Number(quote.prevClose || quote.lastPrice) || ltp;
    const diff = ltp - close;
    const pct = close > 0 ? (diff / close) * 100 : (Number(quote.pctChange) || 0);
    const sign = diff > 0 ? '+' : '';
    const formattedDiff = `${sign}${diff.toFixed(2)}`;
    const formattedPct = `${sign}${pct.toFixed(2)}%`;
    return `${formattedDiff} (${formattedPct})`;
  };

  el('analysis-body').innerHTML = rows.map((quote) => {
    const status = analysisStatus(quote);
    const qKey = `${quote.exchange || 'NSEEQ'}:${quote.instrumentId}`;
    
    const ltp = Number(quote.lastPrice) || 0;
    const close = Number(quote.prevClose || quote.lastPrice) || ltp;
    const diff = ltp - close;
    const chgClass = diff > 0 ? 'chg-fill-pos' : diff < 0 ? 'chg-fill-neg' : 'chg-fill-flat';
    const chgText = fmtChgFull(quote);

    const dayHigh = Number(quote.high) || 0;
    const dayLow = Number(quote.low) || 0;
    const w52High = Number(quote.week52High || quote.new52WHL) || 0;
    const w52Low = Number(quote.week52Low || quote.new52WHL) || 0;

    const isAtDayHigh = ltp > 0 && dayHigh > 0 && ltp >= dayHigh;
    const isAtDayLow = ltp > 0 && dayLow > 0 && ltp <= dayLow;
    const rowClass = isAtDayHigh ? 'row-surpass-high' : isAtDayLow ? 'row-surpass-low' : '';

    const dayHighContent = isAtDayHigh ? `<span class="hit-high-badge">${fmt(dayHigh)} 🔥</span>` : fmt(dayHigh || 0);
    const dayLowContent = isAtDayLow ? `<span class="hit-low-badge">${fmt(dayLow)} 📉</span>` : fmt(dayLow || 0);

    if (state.analysisTab === 'high' || state.analysisTab === 'low') {
      const isHigh = state.analysisTab === 'high';
      const w52Val = isHigh ? w52High : w52Low;
      const isAt52W = isHigh ? (ltp > 0 && w52High > 0 && ltp >= w52High) : (ltp > 0 && w52Low > 0 && ltp <= w52Low);
      const w52BadgeClass = isHigh ? 'hit-high-badge' : 'hit-low-badge';
      const w52Content = isAt52W ? `<span class="${w52BadgeClass}">${fmt(w52Val)} ⭐</span>` : fmt(w52Val || 0);

      const vol = quote.tradedVolume || quote.volume || 0;
      const volFormatted = vol ? Number(vol).toLocaleString('en-IN') : '-';
      return `<tr data-key="${escapeHtml(qKey)}" class="${rowClass}" style="cursor:pointer">
        <td class="scrip-sym">${escapeHtml(quote.symbol || quote.companyName)}</td>
        <td class="scrip-name">${escapeHtml(quote.companyName || quote.symbol)}</td>
        <td class="analysis-rate" style="font-weight:bold">${fmt(quote.lastPrice)}</td>
        <td class="${chgClass}">${escapeHtml(chgText)}</td>
        <td class="analysis-rate">${fmt(close)}</td>
        <td class="analysis-rate" style="font-weight:bold; color:#107c41">${volFormatted}</td>
        <td class="analysis-rate">${w52Content}</td>
        <td class="analysis-rate">${dayHighContent}</td>
        <td class="analysis-rate">${dayLowContent}</td>
        <td class="analysis-rate">${fmt(quote.open || 0)}</td>
      </tr>`;
    } else if (state.analysisTab === 'gainers' || state.analysisTab === 'losers') {
      const vol = quote.tradedVolume || quote.volume || 0;
      const volFormatted = vol ? Number(vol).toLocaleString('en-IN') : '-';
      return `<tr data-key="${escapeHtml(qKey)}" class="${rowClass}" style="cursor:pointer">
        <td class="scrip-sym">${escapeHtml(quote.symbol || quote.companyName)}</td>
        <td class="scrip-name">${escapeHtml(quote.companyName || quote.symbol)}</td>
        <td class="analysis-rate" style="font-weight:bold">${fmt(quote.lastPrice)}</td>
        <td class="${chgClass}">${escapeHtml(chgText)}</td>
        <td class="analysis-rate">${fmt(close)}</td>
        <td class="analysis-rate" style="font-weight:bold; color:#107c41">${volFormatted}</td>
        <td class="analysis-rate">${dayHighContent}</td>
        <td class="analysis-rate">${dayLowContent}</td>
        <td class="analysis-rate">${fmt(quote.open || 0)}</td>
      </tr>`;
    } else if (state.analysisTab === 'quantity' || state.analysisTab === 'traded') {
      return `<tr data-key="${escapeHtml(qKey)}" style="cursor:pointer">
        <td style="font-weight:bold">${escapeHtml(quote.symbol)}</td>
        <td>${escapeHtml(quote.series || 'EQ')}</td>
        <td class="analysis-rate" style="font-weight:bold">${fmt(quote.lastPrice)}</td>
        <td class="${quote.pctChange >= 0 ? 'positive' : 'negative'}">${fmt(quote.pctChange)}%</td>
        <td class="analysis-rate">${quote.volume ? quote.volume.toLocaleString('en-IN') : '-'}</td>
        <td class="analysis-rate">${quote.turnover ? (quote.turnover / 100000).toLocaleString('en-IN', {maximumFractionDigits: 2}) : '-'}</td>
      </tr>`;
    }

    return `<tr data-key="${escapeHtml(qKey)}" style="cursor:pointer">
      <td>${escapeHtml(quote.exchange.slice(0, 1))}</td>
      <td>${escapeHtml(quote.exchange)}</td>
      <td>${escapeHtml(quote.instrumentId)}</td>
      <td>${escapeHtml(quote.symbol)}</td>
      <td class="${status[1]}">${status[0]}</td>
      <td class="analysis-rate">${fmt(quote.lastPrice)}</td>
      <td class="analysis-rate" style="color: #149339">${fmt(quote.week52High)}</td>
      <td class="analysis-rate" style="color: #bf1019">${fmt(quote.week52Low)}</td>
      <td class="analysis-time">${new Date(quote.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="analysis-empty">No scrips match the selected analysis filters.</td></tr>';
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

function showAnalysis() {
  el('analysis-window').classList.remove('is-hidden');
  startAnalysisPolling();
  renderAnalysis();
}
function closeAnalysis() { 
  el('analysis-window').classList.add('is-hidden'); 
  stopAnalysisPolling();
}
function toast(message) { const target = el('toast'); target.textContent = message; target.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => target.classList.remove('show'), 2600); }

function setSession(session) {
  state.session = session || state.session;
  const live = state.session.mode === 'LIVE';
  const status = el('connection-status');
  status.classList.toggle('live', live || state.wsConnected);
  status.classList.toggle('error', state.session.mode === 'ERROR' || !!state.session.lastError);
  status.querySelector('span').textContent = state.session.lastError ? state.session.lastError : (live ? 'IIFL Live' : state.session.mode === 'ERROR' ? 'Connection error' : state.wsConnected ? 'Real-time' : 'Simulation');
  const connect = el('connect-iifl');
  const logout = el('logout-iifl');
  
  if (live) {
    connect.textContent = 'IIFL Connected';
    connect.classList.add('connected');
    connect.style.display = 'inline-block';
    if (logout) logout.style.display = 'inline-block';
  } else {
    connect.textContent = 'Connect IIFL';
    connect.classList.remove('connected');
    connect.style.display = 'inline-block';
    if (logout) logout.style.display = 'none';
  }
}

const CACHE_KEY = 'TT_TERMINAL_STATE_CACHE';
let lastCacheSave = 0;

function saveStateToCache() {
  const now = Date.now();
  if (now - lastCacheSave < 1000) return; // Throttle disk saves to max 1 per sec
  lastCacheSave = now;

  try {
    const payload = {
      quotes: state.quotes,
      watchlist: state.watchlist,
      marketAnalysis: state.marketAnalysis,
      timestamp: now
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch (_) { /* ignore quota errors */ }
}

function loadStateFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const cache = JSON.parse(raw);
    let loaded = false;
    if (Array.isArray(cache.quotes) && cache.quotes.length > 0) {
      state.quotes = cache.quotes.map(quoteFromPrice);
      loaded = true;
    }
    if (cache.watchlist && cache.watchlist.items) {
      state.watchlist = cache.watchlist;
      loaded = true;
    }
    if (cache.marketAnalysis) {
      state.marketAnalysis = cache.marketAnalysis;
      loaded = true;
    }
    return loaded;
  } catch (_) {
    return false;
  }
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
  saveStateToCache();
}

// ---------------------------------------------------------------------------
// WebSocket client — real-time push from server
// ---------------------------------------------------------------------------
function connectWebSocket() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // If running on a dev server (e.g. Live Server on port 5500/5501), target Node backend port 3001
  let host = window.location.host;
  if (window.location.port && window.location.port !== '3001') {
    host = `${window.location.hostname}:3001`;
  }
  const wsUrl = `${protocol}//${host}/ws`;

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
      saveStateToCache();
      
      // Update real-time interactive chart
      if (data.quotes) updateLiveChartTick(state.quotes);
      
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

// Keep WebSocket alive with periodic pings (every 5s to prevent proxy/firewall timeouts)
function startHeartbeat() {
  setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 5000);
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
  const quote = state.quotes.find(q => keyFor(q) === key)
    || state.marketAnalysis?.highs?.find(q => keyFor(q) === key)
    || state.marketAnalysis?.lows?.find(q => keyFor(q) === key)
    || state.marketAnalysis?.gainers?.find(q => keyFor(q) === key)
    || state.marketAnalysis?.losers?.find(q => keyFor(q) === key);
  showChart(quote);
}

function showChart(quote) {
  if (!quote) return;
  activeChartQuote = quote;
  el('chart-title').textContent = `${quote.symbol} - ${quote.exchange}`;
  el('chart-window').classList.remove('is-hidden');
  
  if (activeTimeframe === 'advanced') {
    el('chart-container').style.display = 'none';
    el('tv_chart_container').style.display = 'block';
  } else {
    el('chart-container').style.display = 'block';
    el('tv_chart_container').style.display = 'none';
  }
  
  if (!chartInstance && activeTimeframe !== 'advanced') {
    try {
      const container = el('chart-container');
        chartInstance = LightweightCharts.createChart(container, {
          layout: { background: { color: '#000' }, textColor: '#d1d4dc' },
          grid: { vertLines: { color: '#2b2b43' }, horzLines: { color: '#2b2b43' } },
          timeScale: { timeVisible: true, secondsVisible: true },
          width: container.clientWidth || 760,
        height: container.clientHeight || 420,
      });
      // v3 API: addCandlestickSeries(); v4 API: addSeries(type)
      if (typeof chartInstance.addCandlestickSeries === 'function') {
        candleSeries = chartInstance.addCandlestickSeries({
          upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
          wickUpColor: '#26a69a', wickDownColor: '#ef5350'
        });
        areaSeries = chartInstance.addAreaSeries({
          lineColor: '#2962FF', topColor: 'rgba(41, 98, 255, 0.5)', bottomColor: 'rgba(41, 98, 255, 0.05)',
          lineWidth: 2,
        });
      } else if (typeof chartInstance.addSeries === 'function' && LightweightCharts.CandlestickSeries) {
        candleSeries = chartInstance.addSeries(LightweightCharts.CandlestickSeries, {
          upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
          wickUpColor: '#26a69a', wickDownColor: '#ef5350'
        });
        areaSeries = chartInstance.addSeries(LightweightCharts.AreaSeries, {
          lineColor: '#2962FF', topColor: 'rgba(41, 98, 255, 0.5)', bottomColor: 'rgba(41, 98, 255, 0.05)',
          lineWidth: 2,
        });
      } else {
        console.error('LightweightCharts API not compatible');
        toast('Chart library error — please refresh');
        return;
      }
      
      new ResizeObserver(entries => {
        if (entries.length === 0 || entries[0].target !== container) return;
        const newRect = entries[0].contentRect;
        if (newRect.width > 0 && newRect.height > 0) {
          chartInstance.applyOptions({ width: newRect.width, height: newRect.height });
        }
      }).observe(container);
    } catch (err) {
      console.error('Chart creation failed:', err);
      toast('Chart initialization error');
      chartInstance = null;
      candleSeries = null;
      return;
    }
  }

  setTimeout(() => {
    if (chartInstance && el('chart-container')) {
      const w = el('chart-container').clientWidth || 760;
      const h = el('chart-container').clientHeight || 420;
      chartInstance.applyOptions({ width: w, height: h });
    }
  }, 50);

  loadChartData();
}

async function loadChartData() {
  if (!activeChartQuote) return;
  
  if (activeTimeframe === 'advanced') {
    el('chart-container').style.display = 'none';
    el('tv_chart_container').style.display = 'block';
    
    const cleanSymbol = activeChartQuote.symbol.replace(/-(EQ|BE|BZ|SM|ST|IL|IV|N1|N2|N3|N4|N5|N6|N7|N8)$/i, '').trim();
    const exchangePrefix = (activeChartQuote.exchange.startsWith('BSE') || activeChartQuote.exchange === 'BSEEQ') ? 'BSE' : 'NSE';
    const tvSymbol = `${exchangePrefix}:${cleanSymbol}`;

    el('tv_chart_container').innerHTML = ''; // clear old chart
    if (typeof TradingView !== 'undefined') {
      new TradingView.widget({
        "container_id": "tv_chart_container",
        "width": "100%",
        "height": "100%",
        "symbol": tvSymbol,
        "interval": "D",
        "timezone": "Asia/Kolkata",
        "theme": "light",
        "style": "1",
        "toolbar_bg": "#f1f3f6",
        "range": "120M",
        "withdateranges": true,
        "hide_side_toolbar": false,
        "allow_symbol_change": true,
        "save_image": false,
        "locale": "en"
      });
    } else {
      toast('TradingView library failed to load');
    }
    return;
  }
  
  el('chart-container').style.display = 'block';
  el('tv_chart_container').style.display = 'none';
  if (!candleSeries || !areaSeries) return;
  el('chart-loader').style.display = 'block';
  
  // Toggle visibility
  if (activeTimeframe === 'live') {
    candleSeries.applyOptions({ visible: false });
    areaSeries.applyOptions({ visible: true });
  } else {
    areaSeries.applyOptions({ visible: false });
    candleSeries.applyOptions({ visible: true });
  }

  try {
    // If 'live', fetch '1D' to seed the area chart with today's history
    const tfToFetch = activeTimeframe === 'live' ? '1D' : activeTimeframe;
    const res = await fetch(`/api/chart/${activeChartQuote.exchange}/${activeChartQuote.instrumentId}?timeframe=${tfToFetch}`);
    const result = await res.json();
    if (result.success && Array.isArray(result.data) && result.data.length > 0) {
      if (activeTimeframe === 'live') {
        const areaData = result.data.map(d => ({ time: d.time, value: d.close }));
        areaSeries.setData(areaData);
      } else {
        candleSeries.setData(result.data);
      }
      currentLiveCandle = { ...result.data[result.data.length - 1] };
      chartInstance.timeScale().fitContent();
    } else {
      toast('No chart data available for this timeframe');
    }
  } catch (err) {
    console.error('Chart data load error:', err);
    toast('Error loading chart data');
  } finally {
    el('chart-loader').style.display = 'none';
  }
}

function updateLiveChartTick(quotes) {
    if (!chartInstance || !activeChartQuote) return;
    if (el('chart-window').classList.contains('is-hidden')) return;
  
    const tickQuote = quotes.find(q => keyFor(q) === keyFor(activeChartQuote));
    if (!tickQuote) return;
  
    activeChartQuote = tickQuote;
    
    const d = tickQuote.updatedAt ? new Date(tickQuote.updatedAt) : new Date();
    
    if (activeTimeframe === 'live' && areaSeries) {
    // Area Chart: Simple { time, value } update with exact timestamp to draw new segments continuously
    const exactTime = Math.floor(d.getTime() / 1000);
    areaSeries.update({ time: exactTime, value: tickQuote.lastPrice });
    return;
  }
  
  if (!candleSeries) return;

  let timeParam;
  const isIntraday = activeTimeframe === '1D';
  
  if (isIntraday) {
    // Round down to current minute timestamp for 1D (minute bars)
    timeParam = Math.floor(d.getTime() / 1000);
    timeParam = timeParam - (timeParam % 60); 
  } else {
    // Format YYYY-MM-DD for daily historical
    timeParam = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // If current bucket ended (e.g. minute rolled over), start a new candle
  if (!currentLiveCandle || currentLiveCandle.time !== timeParam) {
    currentLiveCandle = {
      time: timeParam,
      open: tickQuote.lastPrice,
      high: tickQuote.lastPrice,
      low: tickQuote.lastPrice,
      close: tickQuote.lastPrice
    };
  } else {
    // Dynamically expand the highs and lows of the current candle in real-time
    currentLiveCandle.high = Math.max(currentLiveCandle.high, tickQuote.lastPrice);
    currentLiveCandle.low = Math.min(currentLiveCandle.low, tickQuote.lastPrice);
    currentLiveCandle.close = tickQuote.lastPrice;
  }

  // Pushes the tick directly into the charting engine without HTTP requests
  candleSeries.update(currentLiveCandle);
}

async function refreshQuotes(silent = false) {
  try {
    const response = await fetch('/api/market-watch/refresh', { method: 'POST' });
    if (!response.ok) throw new Error('Unable to refresh quotes');
    const data = await response.json();
    applyTerminalPayload(data);
    if (!silent) toast(data.session?.mode === 'LIVE' ? 'Live IIFL quotes refreshed' : 'Simulation quotes refreshed');
  } catch (err) {
    if (!silent) console.warn('Refresh failed:', err.message);
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

// ---------------------------------------------------------------------------
// INDICES — real-time Nifty 50, Sensex, Bank Nifty
// ---------------------------------------------------------------------------
function fmtIdx(value) {
  return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function updateIndices() {
  try {
    const res = await fetch('/api/indices');
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.indices)) return;
    for (const idx of data.indices) {
      const v = el(`${idx.name}-value`);
      const c = el(`${idx.name}-change`);
      if (!v || !c) continue;

      if (idx.error) {
        v.textContent = 'API ERR';
        c.textContent = (idx.errorReason || 'Failed').substring(0, 40);
        c.className = 'negative';
        c.title = idx.errorBody || idx.errorReason || 'API Error';
      } else {
        const positive = idx.change >= 0;
        const sign = positive ? '+' : '';
        const cls = positive ? 'positive' : 'negative';
        v.textContent = fmtIdx(idx.ltp);
        c.textContent = `${sign}${fmtIdx(idx.change)} (${sign}${idx.pct}%)`;
        c.className = cls;
        c.removeAttribute('title');
      }
    }
  } catch (_) { /* non-critical */ }
}

function startIndicesPoll() {
  updateIndices();
  setInterval(updateIndices, 3000);
}

// ---------------------------------------------------------------------------
// JIT Analysis Fetching
// ---------------------------------------------------------------------------
let analysisPollTimer = null;

async function fetchAnalysisData() {
  if (el('analysis-window').classList.contains('is-hidden')) return; 
  
  const tab = state.analysisTab || 'high';
  try {
    const res = await fetch(`/api/analysis/refresh?tab=${tab}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!state.marketAnalysis) state.marketAnalysis = {};
    if (Array.isArray(data.highs) && data.highs.length > 0) state.marketAnalysis.highs = data.highs;
    if (Array.isArray(data.lows) && data.lows.length > 0) state.marketAnalysis.lows = data.lows;
    if (Array.isArray(data.highs_mc) && data.highs_mc.length > 0) state.marketAnalysis.highs_mc = data.highs_mc;
    if (Array.isArray(data.lows_mc) && data.lows_mc.length > 0) state.marketAnalysis.lows_mc = data.lows_mc;
    if (Array.isArray(data.gainers) && data.gainers.length > 0) state.marketAnalysis.gainers = data.gainers;
    if (Array.isArray(data.losers) && data.losers.length > 0) state.marketAnalysis.losers = data.losers;
    if (Array.isArray(data.volume) && data.volume.length > 0) state.marketAnalysis.volume = data.volume;
    if (Array.isArray(data.value) && data.value.length > 0) state.marketAnalysis.value = data.value;
    
    if (!el('analysis-window').classList.contains('is-hidden')) renderAnalysis();
  } catch (_) { /* non-critical */ }
}

function startAnalysisPolling() {
  stopAnalysisPolling();
  fetchAnalysisData();
  analysisPollTimer = setInterval(fetchAnalysisData, 30000); 
}

function stopAnalysisPolling() {
  if (analysisPollTimer) {
    clearInterval(analysisPollTimer);
    analysisPollTimer = null;
  }
}

function startClock() {
  function tick() {
    const t = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const clockEl = el('terminal-clock');
    if (clockEl) clockEl.textContent = t;
  }
  tick();
  setInterval(tick, 1000);
}

function bindEvents() {
  el('exchange-filter').addEventListener('change', () => {
    state.filters.exchange = el('exchange-filter').value;
    renderMarket();
  });
  el('segment-filter').addEventListener('change', () => {
    state.filters.segment = el('segment-filter').value;
    renderMarket();
  });
  if (el('symbol-search')) {
    el('symbol-search').addEventListener('focus', () => {
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
  el('close-analysis').addEventListener('click', closeAnalysis);
  el('refresh-quotes').addEventListener('click', () => refreshQuotes());
  el('analysis-refresh').addEventListener('click', async () => {
    toast('Triggering NSE Market Data Refresh...');
    try {
      const response = await fetch('/api/nse/refresh', { method: 'POST' });
      const json = await response.json();
      toast(json.message);
      if (json.success) refreshQuotes();
    } catch (e) {
      toast('Failed to reach NSE scraper.');
    }
  });
  el('connect-iifl').addEventListener('click', () => { if (state.session.mode !== 'LIVE') window.location.assign('/auth/login'); });
  const logoutBtn = el('logout-iifl');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/auth/logout', { method: 'POST' });
        if (response.ok) {
          const session = await response.json();
          setSession(session);
          toast('Logged out successfully.');
        }
      } catch (e) {
        toast('Error logging out.');
      }
    });
  }
  document.querySelectorAll('[data-analysis-tab]').forEach((button) => button.addEventListener('click', () => { 
    state.analysisTab = button.dataset.analysisTab; 
    document.querySelectorAll('[data-analysis-tab]').forEach((tab) => tab.classList.toggle('active', tab === button)); 
    renderAnalysis(); 
    fetchAnalysisData(); 
  }));
  document.querySelectorAll('[data-analysis-filter]').forEach((checkbox) => checkbox.addEventListener('change', renderAnalysis));
  
  const analysisHead = el('analysis-head');
  if (analysisHead) {
    analysisHead.addEventListener('click', (event) => {
      const chgHeader = event.target.closest('#analysis-sort-chg');
      if (chgHeader) {
        state.analysisSortBy = state.analysisSortBy === 'pct' ? 'pct_asc' : 'pct';
        renderAnalysis();
        return;
      }
      const volHeader = event.target.closest('#analysis-sort-vol');
      if (volHeader) {
        state.analysisSortBy = state.analysisSortBy === 'vol' ? 'vol_asc' : 'vol';
        renderAnalysis();
        return;
      }
      const highHeaderEl = event.target.closest('#analysis-sort-high');
      if (highHeaderEl) {
        state.analysisSortBy = state.analysisSortBy === 'high' ? 'high_asc' : 'high';
        renderAnalysis();
        return;
      }
      const lowHeaderEl = event.target.closest('#analysis-sort-low');
      if (lowHeaderEl) {
        state.analysisSortBy = state.analysisSortBy === 'low' ? 'low_asc' : 'low';
        renderAnalysis();
        return;
      }
    });
  }

  // Toggle sort by pct change
  const sortPctBtn = el('sort-pct-change');
  if (sortPctBtn) {
    sortPctBtn.addEventListener('click', () => {
      state.sortByPctDesc = !state.sortByPctDesc;
      sortPctBtn.textContent = state.sortByPctDesc ? '%chg ▼' : '%chg';
      renderMarket();
    });
  }

  document.addEventListener('keydown', (event) => { 
    if (event.key === 'Escape') closeAnalysis(); 
    if (event.key === 'F7') { event.preventDefault(); showAnalysis(); } 
    
    // Alphabetical filtering
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) {
      if (event.key.length === 1 && /[a-zA-Z]/.test(event.key)) {
        const searchInput = el('local-search');
        if (searchInput) {
          event.preventDefault(); // Prevent browser from typing the character a second time
          searchInput.focus();
          searchInput.value = event.key.toUpperCase();
          state.localSearch = event.key.toLowerCase();
          renderMarket();
        }
      }
    }
  });
  
  // Click on analysis table row -> open chart for that stock
  el('analysis-body').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-key]');
    if (row) openChart(row.dataset.key);
  });
  
  el('edit-watchlist')?.addEventListener('click', (e) => {
    state.isEditMode = !state.isEditMode;
    e.target.textContent = state.isEditMode ? 'Done' : 'Edit';
    e.target.style.background = state.isEditMode ? '#ffefc2' : '';
    if (sortableInstance) sortableInstance.option('disabled', !state.isEditMode);
    
    const tbody = el('market-body');
    if (tbody) {
      tbody.classList.toggle('reorder-mode', state.isEditMode);
    }
    if (!state.isEditMode) renderMarket();
  });

  // Smooth Drag-and-Drop Sorting via SortableJS
  const tbody = el('market-body');
  if (typeof Sortable !== 'undefined') {
    sortableInstance = new Sortable(tbody, {
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      disabled: true, // Disabled by default to prevent accidental scroll-dragging
      onEnd: function () {
        // Save new order after drag ends
        const newKeys = Array.from(tbody.querySelectorAll('tr[data-key]')).map(row => row.dataset.key);
        if (newKeys.length > 0) reorderWatchlist(newKeys);
      }
    });
  }

  // Local Search Filtering
  el('local-search').addEventListener('input', (e) => {
    state.localSearch = e.target.value.toLowerCase();
    renderMarket();
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

  // Draggable Analysis Window
  const analysisWin = el('analysis-window');
  const analysisTitlebar = analysisWin.querySelector('.analysis-titlebar');
  if (analysisWin && analysisTitlebar) {
    let isDragging = false;
    let startX, startY, initialTop, initialLeft;

    const startDrag = (clientX, clientY, target) => {
      if (target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = clientX;
      startY = clientY;
      const rect = analysisWin.getBoundingClientRect();
      initialTop = rect.top;
      initialLeft = rect.left;
      analysisWin.style.right = 'auto';
      analysisWin.style.left = initialLeft + 'px';
      analysisWin.style.top = initialTop + 'px';
      document.body.style.userSelect = 'none';
    };

    const doDrag = (clientX, clientY) => {
      if (!isDragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;
      analysisWin.style.left = (initialLeft + dx) + 'px';
      analysisWin.style.top = (initialTop + dy) + 'px';
    };

    const stopDrag = () => {
      if (isDragging) {
        isDragging = false;
        document.body.style.userSelect = '';
      }
    };

    analysisTitlebar.addEventListener('mousedown', (e) => startDrag(e.clientX, e.clientY, e.target));
    analysisTitlebar.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientX, e.touches[0].clientY, e.target), {passive: false});

    document.addEventListener('mousemove', (e) => doDrag(e.clientX, e.clientY));
    document.addEventListener('touchmove', (e) => {
      if (isDragging) {
        e.preventDefault();
        doDrag(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, {passive: false});

    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchend', stopDrag);
  }

  // --- Chart Window: Drag + Resize ---
  const chartWin = el('chart-window');
  const chartTitlebar = chartWin?.querySelector('.analysis-titlebar');
  if (chartWin && chartTitlebar) {
    let isDraggingChart = false;
    let cStartX, cStartY, cInitialTop, cInitialLeft;

    const startChartDrag = (clientX, clientY, target) => {
      if (target.tagName === 'BUTTON') return;
      isDraggingChart = true;
      cStartX = clientX;
      cStartY = clientY;
      const rect = chartWin.getBoundingClientRect();
      cInitialTop = rect.top;
      cInitialLeft = rect.left;
      chartWin.style.right = 'auto';
      chartWin.style.left = cInitialLeft + 'px';
      chartWin.style.top = cInitialTop + 'px';
      document.body.style.userSelect = 'none';
    };

    const doChartDrag = (clientX, clientY) => {
      if (!isDraggingChart) return;
      chartWin.style.left = (cInitialLeft + (clientX - cStartX)) + 'px';
      chartWin.style.top = (cInitialTop + (clientY - cStartY)) + 'px';
    };

    const stopChartDrag = () => {
      if (isDraggingChart) {
        isDraggingChart = false;
        document.body.style.userSelect = '';
      }
    };

    chartTitlebar.addEventListener('mousedown', (e) => startChartDrag(e.clientX, e.clientY, e.target));
    chartTitlebar.addEventListener('touchstart', (e) => startChartDrag(e.touches[0].clientX, e.touches[0].clientY, e.target), {passive: false});

    document.addEventListener('mousemove', (e) => doChartDrag(e.clientX, e.clientY));
    document.addEventListener('touchmove', (e) => {
      if (isDraggingChart) {
        e.preventDefault();
        doChartDrag(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, {passive: false});

    document.addEventListener('mouseup', stopChartDrag);
    document.addEventListener('touchend', stopChartDrag);

    // Auto-resize chart when the window is resized via CSS resize handle
    if (typeof ResizeObserver !== 'undefined') {
      const chartContainer = el('chart-container');
      new ResizeObserver(() => {
        if (chartInstance && chartContainer) {
          chartInstance.resize(chartContainer.clientWidth, chartContainer.clientHeight);
        }
      }).observe(chartWin);
    }
  }
}

async function initialize() {
  const hasCache = loadStateFromCache();
  renderMarket(); 
  renderAnalysis(); 
  bindEvents(); 
  startClock(); 
  startIndicesPoll(); 
  if (hasCache) {
    console.log('[CACHE] Loaded browser state cache instantly.');
  }

  // Register Service Worker for instant static asset caching
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  await getSession();
  await loadWatchlist();

  // Connect WebSocket for real-time push
  connectWebSocket();
  startHeartbeat();

  // Only poll via REST as a fallback if the WebSocket is disconnected
  await refreshQuotes(true);
  setInterval(() => {
    if (!state.wsConnected) {
      refreshQuotes(true);
    }
  }, 1000);
}

initialize();

