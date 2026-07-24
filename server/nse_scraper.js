const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

let global52WHighs = [{
  symbol: 'FETCHING...',
  exchange: 'NSEEQ',
  instrumentId: 'NSE_LOAD',
  companyName: 'Connecting to NSE via Stealth Puppeteer...',
  lastPrice: 0,
  pctChange: 0,
  week52High: 0,
  week52Low: 0,
  updatedAt: Date.now(),
  isRealNSEData: true
}];
let global52WLows = [{
  symbol: 'FETCHING...',
  exchange: 'NSEEQ',
  instrumentId: 'NSE_LOAD',
  companyName: 'Connecting to NSE via Stealth Puppeteer...',
  lastPrice: 0,
  pctChange: 0,
  week52High: 0,
  week52Low: 0,
  updatedAt: Date.now(),
  isRealNSEData: true
}];

let globalGainers = [];
let globalLosers = [];
let globalVolume = [];
let globalValue = [];

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

function mapMostActiveToQuote(item) {
  return {
    symbol: item.symbol,
    exchange: 'NSEEQ',
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

async function scrapeNSE() {
  console.log('[NSE Scraper] Waking up to fetch full NSE analysis data...');
  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    console.log('[NSE Scraper] Warming up session cookies on NSE homepage...');
    await page.goto('https://www.nseindia.com', { waitUntil: 'networkidle2', timeout: 45000 });
    
    // Wait for Akamai cookies to settle
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('[NSE Scraper] Fetching 52-week High...');
    const highResponse = await page.goto('https://www.nseindia.com/api/live-analysis-52Week?index=high', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const highJson = await highResponse.json();
    if (highJson && highJson.dataLtpGreater20) {
      global52WHighs = highJson.dataLtpGreater20.map(item => mapNSEToQuote(item, true));
      console.log(`[NSE Scraper] ✅ Fetched ${global52WHighs.length} 52-week Highs.`);
    }

    console.log('[NSE Scraper] Fetching 52-week Low...');
    await new Promise(resolve => setTimeout(resolve, 3500));
    
    const lowResponse = await page.goto('https://www.nseindia.com/api/live-analysis-52Week?index=low', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const lowJson = await lowResponse.json();
    if (lowJson && lowJson.dataLtpGreater20) {
      global52WLows = lowJson.dataLtpGreater20.map(item => mapNSEToQuote(item, false));
      console.log(`[NSE Scraper] ✅ Fetched ${global52WLows.length} 52-week Lows.`);
    }

    console.log('[NSE Scraper] Fetching Gainers...');
    await new Promise(resolve => setTimeout(resolve, 3500));
    const gainersRes = await page.goto('https://www.nseindia.com/api/live-analysis-variations?index=gainers', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const gainersJson = await gainersRes.json();
    if (gainersJson && gainersJson.NIFTY && gainersJson.NIFTY.data) {
      globalGainers = gainersJson.NIFTY.data.map(mapGainerLoserToQuote);
      console.log(`[NSE Scraper] ✅ Fetched ${globalGainers.length} Gainers.`);
    }

    console.log('[NSE Scraper] Fetching Losers...');
    await new Promise(resolve => setTimeout(resolve, 3500));
    const losersRes = await page.goto('https://www.nseindia.com/api/live-analysis-variations?index=loosers', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const losersJson = await losersRes.json();
    if (losersJson && losersJson.NIFTY && losersJson.NIFTY.data) {
      globalLosers = losersJson.NIFTY.data.map(mapGainerLoserToQuote);
      console.log(`[NSE Scraper] ✅ Fetched ${globalLosers.length} Losers.`);
    }

    console.log('[NSE Scraper] Fetching Volume Active...');
    await new Promise(resolve => setTimeout(resolve, 3500));
    const volRes = await page.goto('https://www.nseindia.com/api/live-analysis-most-active-securities?index=volume', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const volJson = await volRes.json();
    if (volJson && volJson.data) {
      globalVolume = volJson.data.map(mapMostActiveToQuote);
      console.log(`[NSE Scraper] ✅ Fetched ${globalVolume.length} Active by Volume.`);
    }

    console.log('[NSE Scraper] Fetching Value Active...');
    await new Promise(resolve => setTimeout(resolve, 3500));
    const valRes = await page.goto('https://www.nseindia.com/api/live-analysis-most-active-securities?index=value', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const valJson = await valRes.json();
    if (valJson && valJson.data) {
      globalValue = valJson.data.map(mapMostActiveToQuote);
      console.log(`[NSE Scraper] ✅ Fetched ${globalValue.length} Active by Value.`);
    }

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
    if (browser) await browser.close();
  }
}

function startNSEScraper(intervalMs = 4 * 60 * 1000) { // Default 4 minutes
  // Initial run
  scrapeNSE();
  // Schedule recurring runs
  setInterval(scrapeNSE, intervalMs);
}

function getNSEMarketWideData() {
  return {
    highs: global52WHighs,
    lows: global52WLows,
    gainers: globalGainers,
    losers: globalLosers,
    volume: globalVolume,
    value: globalValue
  };
}

module.exports = {
  startNSEScraper,
  getNSEMarketWideData
};
