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

function mapNSEToQuote(item, isHigh) {
  // Map NSE JSON object to our terminal's internal quote format
  const ltp = Number(item.ltp) || 0;
  const pChange = Number(item.pChange) || 0;
  const whl = Number(item.new52WHL) || 0;
  
  return {
    symbol: item.symbol,
    exchange: 'NSEEQ', // Assume NSE equity
    instrumentId: `NSE_${item.symbol}`, // Generate a faux ID for charting/linking
    companyName: item.companyName || item.symbol,
    lastPrice: ltp,
    pctChange: pChange,
    week52High: isHigh ? whl : Number(item.prev52WHL) || 0,
    week52Low: isHigh ? Number(item.prev52WHL) || 0 : whl,
    updatedAt: Date.now(),
    isRealNSEData: true // Flag to indicate this is market-wide data
  };
}

async function scrapeNSE() {
  console.log('[NSE Scraper] Waking up to fetch 52-week data...');
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
    // Slight delay to avoid hammering the API
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const lowResponse = await page.goto('https://www.nseindia.com/api/live-analysis-52Week?index=low', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const lowJson = await lowResponse.json();
    if (lowJson && lowJson.dataLtpGreater20) {
      global52WLows = lowJson.dataLtpGreater20.map(item => mapNSEToQuote(item, false));
      console.log(`[NSE Scraper] ✅ Fetched ${global52WLows.length} 52-week Lows.`);
    }

  } catch (err) {
    console.error('[NSE Scraper] Error during scraping:', err.message);
    
    // Update the UI placeholder with the actual error so the user isn't left guessing
    const errorMsg = err.message.substring(0, 50);
    global52WHighs = [{
      symbol: 'ERROR',
      exchange: 'NSEEQ',
      instrumentId: 'NSE_ERR',
      companyName: `Scraper failed: ${errorMsg}...`,
      lastPrice: 0, pctChange: 0, week52High: 0, week52Low: 0, updatedAt: Date.now(), isRealNSEData: true
    }];
    global52WLows = [...global52WHighs];
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
    lows: global52WLows
  };
}

module.exports = {
  startNSEScraper,
  getNSEMarketWideData
};
