'use strict';

const axios = require('axios');

// Internal memory maps for fast lookups
let symbolMap = new Map();             // SYMBOL -> { symbol, companyName }
let normalizedCompanyMap = new Map();  // NORMALIZED_NAME -> SYMBOL
let isLoaded = false;

// Common corporate words to strip for fuzzy matching
const STOP_WORDS = new Set([
  'LIMITED', 'LTD', 'INDUSTRIES', 'IND', 'INDIA', 'CORP', 'CORPORATION',
  'ENTERPRISES', 'ENT', 'HOLDINGS', 'HOLDING', 'FINANCE', 'FINANCIAL',
  'SERVICES', 'BANK', 'CO', 'COMPANY', 'INTERNATIONAL', 'INTL',
  'TECHNOLOGIES', 'TECH', 'SOLUTION', 'SOLUTIONS', 'INFRASTRUCTURE', 'INFRA'
]);

function normalizeString(str) {
  if (!str) return '';
  return String(str)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => !STOP_WORDS.has(word))
    .join(' ');
}

function rawNormalize(str) {
  if (!str) return '';
  return String(str).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseCSV(csvText) {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return;

  symbolMap.clear();
  normalizedCompanyMap.clear();

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle CSV quoting
    const parts = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g);
    if (!parts || parts.length < 2) continue;

    const cleanParts = parts.map(p => {
      let s = p.replace(/^,/, '').trim();
      if (s.startsWith('"') && s.endsWith('"')) {
        s = s.slice(1, -1).replace(/""/g, '"');
      }
      return s.trim();
    });

    const symbol = cleanParts[0]?.toUpperCase();
    const companyName = cleanParts[1];

    if (symbol && companyName && symbol !== 'SYMBOL') {
      symbolMap.set(symbol, { symbol, companyName });
      
      const normName = normalizeString(companyName);
      if (normName) {
        normalizedCompanyMap.set(normName, symbol);
      }
      // Also map raw alphanumeric name
      const rawName = rawNormalize(companyName);
      if (rawName) {
        normalizedCompanyMap.set(rawName, symbol);
      }
    }
  }

  isLoaded = true;
  console.log(`[NSE Master] ✅ Parsed ${symbolMap.size} symbols from NSE EQUITY_L.csv`);
}

async function loadNSEMaster() {
  const url = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    timeout: 15000
  };

  try {
    console.log('[NSE Master] Downloading official EQUITY_L.csv from NSE...');
    const response = await axios.get(url, options);
    if (response.data && typeof response.data === 'string') {
      parseCSV(response.data);
      return;
    }
  } catch (err) {
    console.warn('[NSE Master] ⚠️ Failed to download EQUITY_L.csv directly from NSE:', err.message);
  }

  // Fallback to secondary mirror if direct download fails
  try {
    console.log('[NSE Master] Retrying with secondary NSE mirror...');
    const fallbackUrl = 'https://raw.githubusercontent.com/indian-stock-market/nse-symbols/main/EQUITY_L.csv';
    const fallbackRes = await axios.get(fallbackUrl, { timeout: 10000 });
    if (fallbackRes.data && typeof fallbackRes.data === 'string') {
      parseCSV(fallbackRes.data);
      return;
    }
  } catch (_) {
    console.warn('[NSE Master] ⚠️ Secondary mirror unavailable. Using internal fallback matcher.');
  }
}

function resolveNSESymbol(companyName) {
  if (!companyName) return null;
  const input = String(companyName).trim();
  const inputUpper = input.toUpperCase();

  // 1. Direct exact symbol match
  if (symbolMap.has(inputUpper)) {
    return inputUpper;
  }

  // 2. Direct normalized company name match
  const normInput = normalizeString(input);
  if (normalizedCompanyMap.has(normInput)) {
    return normalizedCompanyMap.get(normInput);
  }

  const rawInput = rawNormalize(input);
  if (normalizedCompanyMap.has(rawInput)) {
    return normalizedCompanyMap.get(rawInput);
  }

  // 3. Fuzzy prefix / substring match against registered companies
  if (isLoaded && normInput.length > 2) {
    for (const [normCompany, symbol] of normalizedCompanyMap.entries()) {
      if (normCompany === normInput || normCompany.startsWith(normInput) || normInput.startsWith(normCompany)) {
        return symbol;
      }
    }
  }

  // 4. Fallback: clean up common text suffixes from Moneycontrol title string
  const cleanedSymbol = inputUpper
    .replace(/(?:LIMITED|LTD|INDUSTRIES|IND|INDIA|CORP|ENTERPRISES|HOLDINGS|SERVICES|BANK).*$/i, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim();

  return cleanedSymbol || inputUpper;
}

module.exports = {
  loadNSEMaster,
  resolveNSESymbol,
  isLoaded: () => isLoaded
};
