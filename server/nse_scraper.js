const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const axios = require('axios');
const cheerio = require('cheerio');

let global52WHighs = [{
  symbol: 'FETCHING...',
  exchange: 'NSEEQ',
  instrumentId: 'NSE_LOAD',
  companyName: 'Connecting to NSE via Stealth Puppeteer...',
  lastPrice: 0, pctChange: 0, week52High: 0, week52Low: 0, updatedAt: Date.now(), isRealNSEData: true
}];
let global52WLows = [{
  symbol: 'FETCHING...',
  exchange: 'NSEEQ',
  instrumentId: 'NSE_LOAD',
  companyName: 'Connecting to NSE via Stealth Puppeteer...',
  lastPrice: 0, pctChange: 0, week52High: 0, week52Low: 0, updatedAt: Date.now(), isRealNSEData: true
}];

let mc52WHighs = [];
let mc52WLows = [];

let globalGainers = [];
let globalLosers = [];
let globalVolume = [];
let globalValue = [];

let cacheTimestamps = {
  mc52W: 0,
  mcGainersLosers: 0,
  nseMostActive: 0
};

function mapNSEToQuote(item, isHigh) {
  // Map NSE JSON object to our terminal's internal quote format
  const ltp = Number(item.ltp) || 0;
  const pChange = Number(item.pChange) || 0;
  const whl = Number(item.new52WHL) || 0;
  
  return {
    symbol: item.symbol,
    exchange: 'NSEEQ', // Assume NSE equity
    series: item.series || 'EQ',
    instrumentId: `NSE_${item.symbol}`, // Generate a faux ID for charting/linking
    companyName: item.companyName || item.symbol,
    lastPrice: ltp,
    pctChange: pChange,
    new52WHL: whl,
    prev52WHL: Number(item.prev52WHL) || 0,
    prevHLDate: item.prevHLDate || '-',
    week52High: isHigh ? whl : Number(item.prev52WHL) || 0,
    week52Low: isHigh ? Number(item.prev52WHL) || 0 : whl,
    updatedAt: Date.now(),
    isRealNSEData: true // Flag to indicate this is market-wide data
  };
}

function mapGainerLoserToQuote(item) {
  return {
    symbol: item.symbol,
    exchange: 'NSEEQ',
    segment: 'Equity',
    series: item.series || 'EQ',
    instrumentId: `NSE_${item.symbol}`,
    open: Number(item.open_price) || 0,
    high: Number(item.high_price) || 0,
    low: Number(item.low_price) || 0,
    prevClose: Number(item.prev_price) || 0,
    lastPrice: Number(item.ltp) || 0,
    pctChange: Number(item.perChange) || 0,
    volume: Number(item.trade_quantity) || 0,
    turnover: Number(item.turnover) || 0,
    ca: item.ca_purpose || '-',
    updatedAt: Date.now(),
    isRealNSEData: true
  };
}

async function scrapeMoneycontrolGainersLosers() {
  if (Date.now() - cacheTimestamps.mcGainersLosers < 30 * 1000) return { success: true, message: 'Cached' };
  
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
  };

  try {
    const [gainersRes, losersRes] = await Promise.all([
      axios.get('https://www.moneycontrol.com/stocks/market-stats/top-gainers-nse/?indexName=All%20NSE&id=-2', options),
      axios.get('https://www.moneycontrol.com/stocks/market-stats/top-losers-nse/?indexName=All%20NSE&id=-2', options)
    ]);

    const parseTable = (html) => {
      const $ = cheerio.load(html);
      const rows = $('table').eq(1).find('tbody tr').toArray();
      // Parse top 50 items
      return rows.slice(0, 50).map(row => {
        const cols = $(row).find('td');
        if (cols.length < 5) return null;
        
        let companyName = $(cols[0]).find('a').first().text().trim() || $(cols[0]).text().trim();
        companyName = companyName.replace(/Vol Shocker.*$/i, '').trim();
        const symbol = companyName;

        const priceP = $(cols[2]).find('p');
        const lastPriceStr = priceP.clone().children().remove().end().text().trim().replace(/,/g, '');
        const lastPrice = parseFloat(lastPriceStr) || 0;

        const spanText = priceP.find('span').text().replace(/,/g, '');
        const spanMatch = spanText.match(/([-\d.]+)\s*\(([-\d.]+)%\)/);
        const netChange = spanMatch ? parseFloat(spanMatch[1]) : 0;
        const pctChange = spanMatch ? parseFloat(spanMatch[2]) : 0;

        const high = parseFloat($(cols[3]).text().replace(/,/g, '')) || 0;
        const low = parseFloat($(cols[4]).text().replace(/,/g, '')) || 0;
        const open = parseFloat($(cols[5]).text().replace(/,/g, '')) || 0;
        
        return {
          symbol: symbol.substring(0, 20),
          exchange: 'NSEEQ',
          segment: 'Equity',
          series: 'EQ',
          instrumentId: `NSE_${symbol.replace(/\s+/g, '')}`,
          open: open,
          high: high,
          low: low,
          prevClose: lastPrice - netChange,
          lastPrice: lastPrice,
          pctChange: pctChange,
          volume: 0,
          turnover: 0,
          ca: '-',
          updatedAt: Date.now(),
          isRealNSEData: true
        };
      }).filter(Boolean);
    };

    globalGainers = parseTable(gainersRes.data);
    console.log(`[NSE Scraper] ✅ Fetched ${globalGainers.length} Gainers from Moneycontrol.`);

    globalLosers = parseTable(losersRes.data);
    console.log(`[NSE Scraper] ✅ Fetched ${globalLosers.length} Losers from Moneycontrol.`);
    
    cacheTimestamps.mcGainersLosers = Date.now();
  } catch (err) {
    console.warn('[NSE Scraper] ⚠️ Failed fetching from Moneycontrol:', err.message);
  }
}

async function scrapeMoneycontrol52W() {
  if (Date.now() - cacheTimestamps.mc52W < 30 * 1000) return { success: true, message: 'Cached' };

  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
  };

  try {
    const [highsRes, lowsRes] = await Promise.all([
      axios.get('https://www.moneycontrol.com/stocks/market-stats/52-week-high-nse/?indexName=All%20NSE&id=-2', options),
      axios.get('https://www.moneycontrol.com/stocks/market-stats/52-week-low-nse/?indexName=All%20NSE&id=-2', options)
    ]);

    const parse52WTable = (html, isHigh) => {
      const $ = cheerio.load(html);
      const rows = $('table').eq(1).find('tbody tr').toArray();
      // Parse top 50 items
      return rows.slice(0, 50).map(row => {
        const cols = $(row).find('td');
        if (cols.length < 7) return null;
        
        let companyName = $(cols[0]).find('a').first().text().trim() || $(cols[0]).text().trim();
        companyName = companyName.replace(/(?:Vol Shocker|ATH|ATL|Only Buyers|Only Sellers).*$/i, '').trim();
        const symbol = companyName;

        const priceP = $(cols[2]).find('p');
        const lastPriceStr = priceP.clone().children().remove().end().text().trim().replace(/,/g, '');
        const lastPrice = parseFloat(lastPriceStr) || 0;

        const spanText = priceP.find('span').text().replace(/,/g, '');
        const spanMatch = spanText.match(/([-\d.]+)\s*\(([-\d.]+)%\)/);
        const netChange = spanMatch ? parseFloat(spanMatch[1]) : 0;
        const pctChange = spanMatch ? parseFloat(spanMatch[2]) : 0;

        const high = parseFloat($(cols[3]).text().replace(/,/g, '')) || 0;
        const low = parseFloat($(cols[4]).text().replace(/,/g, '')) || 0;
        const week52Val = parseFloat($(cols[5]).text().replace(/,/g, '')) || 0;
        const open = parseFloat($(cols[6]).text().replace(/,/g, '')) || 0;
        
        return {
          symbol: symbol.substring(0, 20),
          exchange: 'NSEEQ',
          segment: 'Equity',
          series: 'EQ',
          instrumentId: `NSE_${symbol.replace(/\s+/g, '')}`,
          companyName: symbol,
          lastPrice: lastPrice,
          pctChange: pctChange,
          prevClose: lastPrice - netChange,
          open: open,
          high: high,
          low: low,
          week52High: isHigh ? week52Val : 0,
          week52Low: isHigh ? 0 : week52Val,
          prev52WHL: 0,
          prevHLDate: '-',
          updatedAt: Date.now(),
          isRealNSEData: true
        };
      }).filter(Boolean);
    };

    mc52WHighs = parse52WTable(highsRes.data, true);
    console.log(`[NSE Scraper] ✅ Fetched ${mc52WHighs.length} 52-week Highs from Moneycontrol.`);

    mc52WLows = parse52WTable(lowsRes.data, false);
    console.log(`[NSE Scraper] ✅ Fetched ${mc52WLows.length} 52-week Lows from Moneycontrol.`);
    
    cacheTimestamps.mc52W = Date.now();
  } catch (err) {
    console.warn('[NSE Scraper] ⚠️ Failed fetching 52-week data from Moneycontrol:', err.message);
  }
}


function mapMostActiveToQuote(item) {
  return {
    symbol: item.symbol,
    exchange: 'NSEEQ',
    segment: 'Equity',
    series: 'EQ',
    instrumentId: `NSE_${item.symbol}`,
    lastPrice: Number(item.lastPrice) || 0,
    pctChange: Number(item.pChange) || 0,
    volume: Number(item.totalTradedVolume) || 0,
    turnover: Number(item.totalTradedValue) || 0,
    updatedAt: Date.now(),
    isRealNSEData: true
  };
}

let lastScrapeTime = 0;
let isScraping = false;

async function scrapeNSE(manual = false) {
  if (Date.now() - cacheTimestamps.nseMostActive < 5 * 60 * 1000) return { success: true, message: 'Cached' };
  if (isScraping) return { success: false, message: 'Scraping is already in progress.' };
  
  const now = Date.now();
  if (manual && (now - lastScrapeTime) < 1 * 60 * 1000) {
    const waitMins = Math.ceil((1 * 60 * 1000 - (now - lastScrapeTime)) / 60000);
    return { success: false, message: `Cooldown active. Please wait ${waitMins} minute(s).` };
  }

  isScraping = true;
  lastScrapeTime = Date.now();
  console.log('[NSE Scraper] Waking up to fetch full NSE analysis data...');
  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    
    // Set a solid User-Agent and viewport
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Block unnecessary resources (images, fonts) to speed up loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log('[NSE Scraper] Warming up session cookies on NSE homepage...');
    try {
      await page.goto('https://www.nseindia.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.warn('[NSE Scraper] Homepage warmup warning:', e.message);
    }
    
    // Wait for Akamai cookies to settle
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('[NSE Scraper] Fetching 52-week High...');
    try {
      const highResponse = await page.goto('https://www.nseindia.com/api/live-analysis-52Week?index=high', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const highJson = await highResponse.json();
      if (highJson && highJson.dataLtpGreater20) {
        global52WHighs = highJson.dataLtpGreater20.map(item => mapNSEToQuote(item, true));
        console.log(`[NSE Scraper] ✅ Fetched ${global52WHighs.length} 52-week Highs.`);
      }
    } catch (e) { console.warn('[NSE Scraper] ⚠️ Failed 52-week High:', e.message); }

    console.log('[NSE Scraper] Fetching 52-week Low...');
    await new Promise(resolve => setTimeout(resolve, 3500));
    try {
      const lowResponse = await page.goto('https://www.nseindia.com/api/live-analysis-52Week?index=low', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const lowJson = await lowResponse.json();
      if (lowJson && lowJson.dataLtpGreater20) {
        global52WLows = lowJson.dataLtpGreater20.map(item => mapNSEToQuote(item, false));
        console.log(`[NSE Scraper] ✅ Fetched ${global52WLows.length} 52-week Lows.`);
      }
    } catch (e) { console.warn('[NSE Scraper] ⚠️ Failed 52-week Low:', e.message); }

    // Moneycontrol Gainers/Losers are fetched directly now, no need to run here.

    console.log('[NSE Scraper] Fetching Volume Active...');
    await new Promise(resolve => setTimeout(resolve, 3500));
    try {
      const volRes = await page.goto('https://www.nseindia.com/api/live-analysis-most-active-securities?index=volume', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const volJson = await volRes.json();
      if (volJson && volJson.data) {
        globalVolume = volJson.data.map(mapMostActiveToQuote);
        console.log(`[NSE Scraper] ✅ Fetched ${globalVolume.length} Active by Volume.`);
      }
    } catch (e) { console.warn('[NSE Scraper] ⚠️ Failed Volume:', e.message); }

    console.log('[NSE Scraper] Fetching Value Active...');
    await new Promise(resolve => setTimeout(resolve, 3500));
    try {
      const valRes = await page.goto('https://www.nseindia.com/api/live-analysis-most-active-securities?index=value', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const valJson = await valRes.json();
      if (valJson && valJson.data) {
        globalValue = valJson.data.map(mapMostActiveToQuote);
        console.log(`[NSE Scraper] ✅ Fetched ${globalValue.length} Active by Value.`);
      }
    } catch (e) { console.warn('[NSE Scraper] ⚠️ Failed Value:', e.message); }

  } catch (err) {
    console.error('[NSE Scraper] Error during scraping:', err.message);
    
    // Update the UI placeholder with the actual error so the user isn't left guessing
    const errorMsg = err.message.substring(0, 30);
    global52WHighs = [{
      symbol: `ERR: ${errorMsg}...`,
      exchange: 'NSEEQ',
      instrumentId: 'NSE_ERR',
      companyName: err.message,
      lastPrice: 0, pctChange: 0, week52High: 0, week52Low: 0, updatedAt: Date.now(), isRealNSEData: true
    }];
    global52WLows = [...global52WHighs];
    globalGainers = [...global52WHighs];
    globalLosers = [...global52WHighs];
    globalVolume = [...global52WHighs];
    globalValue = [...global52WHighs];
  } finally {
    isScraping = false;
    if (browser) await browser.close();
  }
  
  cacheTimestamps.nseMostActive = Date.now();
  return { success: true, message: 'NSE data successfully refreshed.' };
}

function startNSEScraper(intervalMs = 5 * 60 * 1000) { 
  // Background polling removed! Scraper will now only run Just-In-Time (JIT) when requested.
  // We still do one initial pull so the server has data on startup.
  scrapeNSE();
  scrapeMoneycontrol52W();
  scrapeMoneycontrolGainersLosers();
}

function getNSEMarketWideData() {
  return {
    highs: global52WHighs,
    lows: global52WLows,
    highs_mc: mc52WHighs,
    lows_mc: mc52WLows,
    gainers: globalGainers,
    losers: globalLosers,
    volume: globalVolume,
    value: globalValue
  };
}

module.exports = {
  startNSEScraper,
  getNSEMarketWideData,
  scrapeNSE,
  scrapeMoneycontrol52W,
  scrapeMoneycontrolGainersLosers
};
