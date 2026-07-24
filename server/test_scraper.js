const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function run() {
  console.log('Launching puppeteer...');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  });

  console.log('Visiting NSE home page to warm up session (bypass Akamai)...');
  await page.goto('https://www.nseindia.com', { waitUntil: 'networkidle2', timeout: 30000 });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log('Fetching 52-week high data...');
  const highResponse = await page.goto('https://www.nseindia.com/api/live-analysis-52Week?index=high', { waitUntil: 'domcontentloaded' });
  const highText = await highResponse.text();
  console.log('High data prefix:', highText.substring(0, 200));

  console.log('Fetching 52-week low data...');
  const lowResponse = await page.goto('https://www.nseindia.com/api/live-analysis-52Week?index=low', { waitUntil: 'domcontentloaded' });
  const lowText = await lowResponse.text();
  console.log('Low data prefix:', lowText.substring(0, 200));
  
  await browser.close();
}

run().catch(console.error);
