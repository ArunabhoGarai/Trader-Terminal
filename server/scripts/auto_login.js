const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const OTPAuth = require('otpauth');

puppeteer.use(StealthPlugin());

async function runAutoLogin(port = 3001) {
  console.log('[AUTO-LOGIN] Starting Headless Login Flow...');
  const clientId = process.env.IIFL_CLIENT_ID;
  const password = process.env.IIFL_PASSWORD;
  const totpSecret = process.env.IIFL_TOTP_SECRET;

  if (!clientId || !password || !totpSecret) {
    console.error('[AUTO-LOGIN] Missing credentials in .env');
    return { success: false, error: 'Missing credentials in .env' };
  }

  // We will generate the TOTP right before we type it, so it doesn't expire during page navigation.
  
  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: true, // run invisibly 
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions'
      ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Listen to browser console and network for debugging
    page.on('console', msg => console.log(`[BROWSER CONSOLE] ${msg.type().toUpperCase()}: ${msg.text()}`));
    page.on('pageerror', err => console.error(`[BROWSER ERROR] ${err.toString()}`));
    page.on('response', response => {
      if (!response.ok() && (response.url().includes('login') || response.url().includes('auth'))) {
        console.log(`[BROWSER NETWORK ERROR] ${response.status()} from ${response.url()}`);
      }
    });

    // Navigate directly to the IIFL login URL (same URL as manual login)
    const marketsUrl = (process.env.IIFL_MARKETS_URL || 'https://markets.iiflcapital.com').replace(/\/$/, '');
    const appKey = process.env.IIFL_APP_KEY || '';
    const redirectUri = process.env.IIFL_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
    const iiflLoginUrl = `${marketsUrl}/?v=1&appkey=${encodeURIComponent(appKey)}&redirecturl=${redirectUri}`;
    console.log(`[AUTO-LOGIN] Navigating directly to IIFL: ${iiflLoginUrl}`);
    // We use domcontentloaded instead of networkidle2 because IIFL's login page
    // might have long-polling trackers that prevent networkidle from ever firing.
    await page.goto(iiflLoginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the IIFL page to fully render (it may use JS frameworks)
    console.log('[AUTO-LOGIN] Waiting for IIFL login page to render...');
    await new Promise(r => setTimeout(r, 3000));

    // Log what inputs are actually on the page for debugging
    const inputDebug = await page.evaluate(() => {
      const all = document.querySelectorAll('input');
      return Array.from(all).map(i => ({
        type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
        visible: i.offsetParent !== null, value: i.value
      }));
    });
    console.log('[AUTO-LOGIN] Found inputs on page:', JSON.stringify(inputDebug));

    // Find the first visible, non-hidden input (Client ID field)
    const filled = await page.evaluate((clientId) => {
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button' || input.type === 'checkbox' || input.type === 'radio') continue;
        if (input.offsetParent === null) continue; // not visible
        input.focus();
        // Use native input setter to work with React/Angular controlled inputs
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, clientId);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    }, clientId);

    if (!filled) {
      throw new Error("Could not find any visible input field for Client ID.");
    }

    console.log('[AUTO-LOGIN] Filled Client ID. Looking for Password...');
    const passSelector = 'input[type="password"]';
    try {
      // Wait up to 6 seconds to see if the password field is already there (1-step login)
      await page.waitForSelector(passSelector, { timeout: 6000, visible: true });
    } catch (e) {
      // If it's not there, it might be a 2-step login. Hit Enter to proceed to the password step.
      console.log('[AUTO-LOGIN] Password field not immediately visible. Pressing Enter (assuming 2-step login)...');
      await page.keyboard.press('Enter');
      await page.waitForSelector(passSelector, { timeout: 15000, visible: true });
    }
    
    // Use native setter for React/Angular compatibility
    await page.evaluate((password) => {
      const passInput = document.querySelector('input[type="password"]');
      if (passInput) {
        passInput.focus();
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(passInput, password);
        passInput.dispatchEvent(new Event('input', { bubbles: true }));
        passInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, password);

    console.log('[AUTO-LOGIN] Submitting credentials...');
    // Hit Enter to submit
    await page.keyboard.press('Enter');

    // Wait for the TOTP field to appear. 
    // It is typically a number input, or another text input.
    console.log('[AUTO-LOGIN] Waiting for TOTP/OTP field...');
    
    // After pressing enter, wait for a new input that might be the OTP field.
    // Sometimes it's input[type="text"] or input[type="number"] or id containing "otp"
    await page.waitForFunction(() => {
      const allInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
      // We look for an input that is empty, because the previous ones might be gone or still there
      for (const input of allInputs) {
        if (input.value === '' || input.name.toLowerCase().includes('otp') || input.id.toLowerCase().includes('otp')) return true;
      }
      return false;
    }, { timeout: 30000 });

    // Wait a brief moment for any animations
    await new Promise(r => setTimeout(r, 1000));

    // Generate TOTP exactly when we are ready to type it
    let totpCode;
    try {
      const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(totpSecret) });
      totpCode = totp.generate();
      console.log(`[AUTO-LOGIN] Generated fresh TOTP: ${totpCode}`);
    } catch (err) {
      throw new Error('Failed to generate TOTP: ' + err.message);
    }
    const activeOtpInputs = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
    // We assume the first empty or appropriately named input is the OTP one
    let typed = false;
    for (const input of activeOtpInputs) {
      const val = await page.evaluate(el => el.value, input);
      if (val === '') {
        await input.type(totpCode);
        typed = true;
        break;
      }
    }
    
    if (!typed) {
      console.warn('[AUTO-LOGIN] Could not confidently find an empty OTP field. Trying to type anyway...');
      await page.keyboard.type(totpCode);
    }

    console.log('[AUTO-LOGIN] Submitting TOTP...');
    await page.keyboard.press('Enter');

    console.log('[AUTO-LOGIN] Waiting for possible Authorize button...');
    try {
      await page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
        return btns.some(b => (b.innerText || b.value || '').toLowerCase().includes('authorize') || (b.innerText || b.value || '').toLowerCase().includes('allow') || (b.innerText || b.value || '').toLowerCase().includes('approve'));
      }, { timeout: 30000 });
      console.log('[AUTO-LOGIN] Found Authorize button, clicking...');
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
        const authBtn = btns.find(b => (b.innerText || b.value || '').toLowerCase().includes('authorize') || (b.innerText || b.value || '').toLowerCase().includes('allow') || (b.innerText || b.value || '').toLowerCase().includes('approve'));
        if (authBtn) authBtn.click();
      });
    } catch (e) {
      console.log('[AUTO-LOGIN] No Authorize button found or needed. Proceeding...');
    }

    // Wait for redirection back to localhost or the registered AWS redirect.
    console.log('[AUTO-LOGIN] Waiting for redirection to callback...');
    await page.waitForResponse(response => {
      return response.url().includes('/auth/callback');
    }, { timeout: 30000 });

    console.log('[AUTO-LOGIN] ✅ Successfully logged in and captured session via callback!');
    return { success: true };
    
  } catch (err) {
    console.error('[AUTO-LOGIN] ❌ Failed:', err.message);
    const result = { success: false, error: err.message };
    // Dump page HTML and screenshot on failure to frontend folder so UI can show it
    if (browser) {
       try {
         const path = require('path');
         const frontendDir = path.join(__dirname, '..', '..', 'frontend');
         const pages = await browser.pages();
         const errorPage = pages[pages.length-1];
         if (errorPage) {
           const html = await errorPage.content();
           require('fs').writeFileSync(path.join(frontendDir, 'auto_login_error_dump.html'), html);
           await errorPage.screenshot({ path: path.join(frontendDir, 'auto_login_error_screenshot.png') });
           console.log('[AUTO-LOGIN] Dumped error page to frontend/auto_login_error_dump.html and auto_login_error_screenshot.png');
           result.screenshot = '/auto_login_error_screenshot.png';
         }
       } catch (e) {
         console.error('[AUTO-LOGIN] Could not dump error state:', e.message);
       }
    }
    return result;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { runAutoLogin };
