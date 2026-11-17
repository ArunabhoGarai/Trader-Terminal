'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, 'cache');
const EQUITY_L_FILE = path.join(CACHE_DIR, 'EQUITY_L.csv');
const SME_EQUITY_L_FILE = path.join(CACHE_DIR, 'SME_EQUITY_L.csv');

// Internal memory maps for fast lookups
let symbolMap = new Map();             // SYMBOL -> { symbol, companyName, series, listingDate, isin, isSme }
let normalizedCompanyMap = new Map();  // NORMALIZED_NAME -> SYMBOL
let isinMap = new Map();               // ISIN -> SYMBOL
let instrumentIdMap = new Map();       // INSTRUMENT_ID -> { symbol, companyName }
let isLoaded = false;
let lastDownloadDate = null;
let dailyScheduleInterval = null;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
  }
}

function indiaTradingDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

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

function parseCSV(csvText, append = false, isSme = false) {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return;

  if (!append) {
    symbolMap.clear();
    normalizedCompanyMap.clear();
    isinMap.clear();
  }

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

    const symbol = cleanParts[0]?.toUpperCase().trim();
    const companyName = cleanParts[1]?.trim();
    const series = (cleanParts[2] || (isSme ? 'SM' : 'EQ')).toUpperCase().trim();
    const listingDate = cleanParts[3]?.trim() || '';
    const isin = cleanParts[6]?.toUpperCase().trim() || '';

    if (symbol && companyName && symbol !== 'SYMBOL') {
      const record = { symbol, companyName, series, listingDate, isin, isSme };
      symbolMap.set(symbol, record);

      // Also index with series suffix for direct lookup
      if (series && series !== 'EQ') {
        symbolMap.set(`${symbol}-${series}`, record);
      } else {
        symbolMap.set(`${symbol}-EQ`, record);
      }

      if (isin) {
        isinMap.set(isin, symbol);
      }
      
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
  console.log(`[NSE Master] ✅ Parsed ${symbolMap.size} symbols from NSE ${isSme ? 'SME' : 'Mainboard'} listings.`);
}

function loadFromDisk() {
  let loaded = false;
  try {
    ensureCacheDir();
    if (fs.existsSync(EQUITY_L_FILE)) {
      const content = fs.readFileSync(EQUITY_L_FILE, 'utf8');
      if (content && content.length > 200) {
        parseCSV(content, false, false);
        loaded = true;
      }
    }
    if (fs.existsSync(SME_EQUITY_L_FILE)) {
      const content = fs.readFileSync(SME_EQUITY_L_FILE, 'utf8');
      if (content && content.length > 100) {
        parseCSV(content, true, true);
        loaded = true;
      }
    }
    if (loaded) {
      isLoaded = true;
      console.log(`[NSE Master] 📂 Loaded ${symbolMap.size} symbols from cached listings on disk.`);
    }
  } catch (err) {
    console.warn('[NSE Master] ⚠️ Error loading local listings cache:', err.message);
  }
  return loaded;
}

async function downloadAndReplaceNSEListings() {
  ensureCacheDir();
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://www.nseindia.com/'
    },
    timeout: 20000
  };

  let mainCsv = null;
  let smeCsv = null;

  // 1. Download official mainboard EQUITY_L.csv
  const mainUrls = [
    'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
    'https://raw.githubusercontent.com/indian-stock-market/nse-symbols/main/EQUITY_L.csv'
  ];

  for (const url of mainUrls) {
    try {
      console.log(`[NSE Master] 📡 Downloading fresh NSE stock listings from ${url}...`);
      const res = await axios.get(url, options);
      if (res.data && typeof res.data === 'string' && res.data.includes('SYMBOL') && res.data.length > 1000) {
        mainCsv = res.data;
        // Atomically replace old file on disk
        fs.writeFileSync(EQUITY_L_FILE, mainCsv, 'utf8');
        console.log(`[NSE Master] 💾 Successfully replaced old EQUITY_L.csv on disk (${(mainCsv.length / 1024).toFixed(1)} KB).`);
        break;
      }
    } catch (err) {
      console.warn(`[NSE Master] ⚠️ Download from ${url} failed:`, err.message);
    }
  }

  // 2. Download official SME_EQUITY_L.csv
  const smeUrls = [
    'https://nsearchives.nseindia.com/content/equities/SME_EQUITY_L.csv'
  ];

  for (const url of smeUrls) {
    try {
      console.log(`[NSE Master] 📡 Downloading fresh SME stock listings from ${url}...`);
      const res = await axios.get(url, options);
      if (res.data && typeof res.data === 'string' && res.data.includes('SYMBOL') && res.data.length > 100) {
        smeCsv = res.data;
        // Atomically replace old file on disk
        fs.writeFileSync(SME_EQUITY_L_FILE, smeCsv, 'utf8');
        console.log(`[NSE Master] 💾 Successfully replaced old SME_EQUITY_L.csv on disk (${(smeCsv.length / 1024).toFixed(1)} KB).`);
        break;
      }
    } catch (err) {
      console.warn(`[NSE Master] ⚠️ SME download failed:`, err.message);
    }
  }

  // 3. Re-parse and update in-memory maps
  if (mainCsv) {
    parseCSV(mainCsv, false, false);
    if (smeCsv) {
      parseCSV(smeCsv, true, true);
    } else if (fs.existsSync(SME_EQUITY_L_FILE)) {
      try { parseCSV(fs.readFileSync(SME_EQUITY_L_FILE, 'utf8'), true, true); } catch (_) {}
    }
    isLoaded = true;
    lastDownloadDate = indiaTradingDate();
    console.log(`[NSE Master] ✅ Stock listings updated: ${symbolMap.size} total active NSE symbols ready for search.`);
    return true;
  } else {
    // If download failed, make sure local cache is loaded
    if (symbolMap.size === 0) {
      loadFromDisk();
    }
    return false;
  }
}

function startDailyNSESchedule(onUpdateCallback) {
  // 1. Instant startup from disk cache
  loadFromDisk();

  // 2. Download fresh files asynchronously on startup and replace old files
  downloadAndReplaceNSEListings().then(success => {
    if (success && typeof onUpdateCallback === 'function') {
      try { onUpdateCallback(); } catch (_) {}
    }
  }).catch(() => {});

  // 3. Schedule daily run: check every 15 minutes
  if (!dailyScheduleInterval) {
    dailyScheduleInterval = setInterval(async () => {
      try {
        const istString = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
        const istDate = new Date(istString);
        const hour = istDate.getHours();
        const todayStr = indiaTradingDate();

        // Target daily refresh windows:
        // Window 1: 08:00 - 08:30 IST (before market open)
        // Window 2: 18:30 - 19:00 IST (after market close, when new listing circulars take effect)
        const isScheduledHour = (hour === 8 || hour === 18);
        if (isScheduledHour && lastDownloadDate !== todayStr) {
          console.log(`[NSE Master] ⏰ Daily Schedule Trigger (${hour}:00 IST): Downloading latest NSE stock listings...`);
          const updated = await downloadAndReplaceNSEListings();
          if (updated && typeof onUpdateCallback === 'function') {
            try { onUpdateCallback(); } catch (_) {}
          }
        }
      } catch (e) {
        console.warn('[NSE Master] ⚠️ Schedule check error:', e.message);
      }
    }, 15 * 60 * 1000);
  }
}

// Explicit company name -> official NSE EQ symbol overrides
const COMPANY_SYMBOL_OVERRIDES = new Map([
  ['PROVENTUS', 'PROV'],
  ['PROVENTUS LIFE', 'PROV'],
  ['PROVENTUS LIFE SCIENCES', 'PROV'],
  ['PROVENTUS LIFE SCIENCES LIMITED', 'PROV'],
  ['IND-SWIFT LABS', 'INDSWIFTLAB'],
  ['IND SWIFT LABS', 'INDSWIFTLAB'],
  ['IND-SWIFT LABORATORIES', 'INDSWIFTLAB'],
  ['AARTI SURFACTAN', 'AARTISURF'],
  ['AARTI SURFACTANTS', 'AARTISURF'],
  ['AKUMS DRUGS P', 'AKUMS'],
  ['AKUMS DRUGS', 'AKUMS'],
  ['AKUMS DRUGS & PHARMACEUTICALS', 'AKUMS'],
  ['RELIANCE HOME F', 'RHFL'],
  ['RELIANCE HOME FINANCE', 'RHFL'],
  ['LAXMI GOLDORNA', 'LGHL'],
  ['LAXMI GOLDORNA HOUSE', 'LGHL'],
  ['ISHAN INTL', 'ISHAN'],
  ['ISHAN INTL.', 'ISHAN'],
  ['ISHAN INTERNATIONAL', 'ISHAN'],
  ['LUMAX AUTO TECH', 'LUMAXTECH'],
  ['CHENNAI PETRO', 'CHENNPETRO'],
  ['FINOLEX CABLES', 'FINCABLES'],
  ['KOLTE-PATIL', 'KOLTEPATIL'],
  ['RIR POWER ELECT', 'RIR'],
  ['TCPL PACKAGING', 'TCPLPACK'],
  ['STANDARD IND', 'SIL'],
  ['ORIENT BELL', 'ORIENTBELL'],
  ['SUNDRAM', 'SUNDRMFAST'],
  ['SEDEMAC MECHATR', 'SEDEMAC'],
  ['ZYDUS LIFE', 'ZYDUSLIFE'],
  ['KWALITY PHARMAC', 'KPL'],
  ['SPECIALITY REST', 'SPECIALITY'],
  ['SAKAR HEALTHCAR', 'SAKAR'],
  ['SUDEEP PHARMA', 'SUDEEPPHRM'],
  ['XTRANET TECHNOL', 'XTRANET'],
  ['ANAWIL WIRE', 'ANAWILWIRE'],
  ['BIRLA CABLE', 'BIRLACABLE'],
  ['HOAC FOODS', 'HOACFOODS'],
  ['USHANTI COLOUR', 'USHANTICOLOUR'],
  ['AVATAR IND', 'AVATAR'],
  ['BIKEWO GREEN', 'BIKEWOGREEN'],
  ['VIVO COLLABORAT', 'VIVOCOLLABORAT'],
  ['DS KULKARNI', 'DSKULKARNI'],
  ['GP PETROLEUMS', 'GULFPETRO'],
  ['ANTHEM BIOSCIEN', 'ANTHEM'],
  ['PANACHE DIGILIF', 'PANACHE'],
  ['THYROCARE TECHN', 'THYROCARE'],
  ['POLYPLEX CORP', 'POLYPLEX'],
  ['E2E NETWORKS', 'E2E'],
  ['GOLDIAM INTER', 'GOLDIAM'],
  ['BOSCH', 'BOSCHLTD'],
  ['PROPSHOP EVENTS', 'PROPSHOPEVENTS'],
  ['RUBICON RES', 'RUBICON'],
  ['ORBIT EXPORTS', 'ORBTEXP'],
  ['ACCRETION PHARM', 'ACCRETION'],
  ['DEEP IND', 'DEEPINDS'],
  ['FERMENTA BIO', 'FERMENTA'],
  ['GTPL H', 'GTPL'],
  ['PRAMARA', 'PRAMARA'],
  ['KORE DIGITAL', 'KOREDIGITAL'],
  ['BEW ENG', 'BEWENG'],
  ['WS INDUSTRIES', 'WS'],
  ['CEINSYS TECH', 'CEINSYS'],
  ['TRUST FINTECH', 'TRUSTFINTECH'],
  ['KEC INTL', 'KEC'],
  ['INDO THAI SECU', 'INDOTHAI'],
  ['SUMEET IND', 'SUMEETINDS'],
  ['KPIGREEN', 'KPIGREEN'],
  ['GSM FOILS', 'GSMFOILS'],
  ['FLEXITUFF VENTU', 'FLEXITUFF'],
  ['AVRO INDIA', 'AVROIND'],
  ['SURYALATA SPG', 'SURYALATASPG'],
  ['CHEMPLAST SANMA', 'CHEMPLASTS'],
  ['PHANTOM DIGITAL', 'PHANTOMDIGITAL'],
  ['KITEX GARMENTS', 'KITEX'],
  ['STUDDS ACCESS', 'STUDDS'],
  ['UMA CONVERTER', 'UMACONVERTER'],
  ['ALPINE TEXWORLD', 'ALPINETEX'],
  ['LCC INFOTECH', 'LCCINFOTEC'],
  ['OSIA HYPER RETA', 'OSIAHYPER'],
  ['PARSVN', 'PARSVNATH'],
  ['GENSOL ENG', 'GENSOL'],
  ['JK LAKSHMI CEM', 'JKLAKSHMI'],
  ['OWAIS METAL', 'OWAISMETAL'],
  ['STAR CEMENT', 'STARCEMENT'],
  ['HDFC BANK', 'HDFCBANK'],
  ['SITI NETWORKS', 'SITINET'],
  ['SHRENIK', 'SHRENIK'],
  ['NEELAM LINENS', 'NEELAMLINENS'],
  ['SANWARIA CONSUM', 'SANWARIA'],
  ['AFCONS INFRA', 'AFCONS'],
  ['DUGLOBAL', 'DUGLOBAL'],
  ['INDIA SHELTER', 'INDIASHLTR'],
  ['ARSHIYA', 'ARSHIYA'],
  ['INOX WIND', 'INOXWIND'],
  ['NILE', 'NILE'],
  ['MONO PHARMACARE', 'MONOPHARMACARE'],
  ['VIVIMED LABS', 'VIVIMEDLAB'],
  ['OSEL DEVICES', 'OSELDEVICES'],
  ['PCBL', 'PCBL'],
  ['BEML', 'BEML'],
  ['ABFRL', 'ABFRL']
]);

function resolveNSESymbol(companyName) {
  if (!companyName) return null;
  const input = String(companyName).trim();
  const inputUpper = input.toUpperCase();

  // 1. Explicit override map check
  if (COMPANY_SYMBOL_OVERRIDES.has(inputUpper)) {
    return COMPANY_SYMBOL_OVERRIDES.get(inputUpper);
  }

  // 2. Direct exact symbol match against official EQUITY_L master
  if (symbolMap.has(inputUpper)) {
    return inputUpper;
  }

  // 3. Direct normalized company name match
  const normInput = normalizeString(input);
  if (COMPANY_SYMBOL_OVERRIDES.has(normInput)) {
    return COMPANY_SYMBOL_OVERRIDES.get(normInput);
  }
  if (normalizedCompanyMap.has(normInput)) {
    return normalizedCompanyMap.get(normInput);
  }

  const rawInput = rawNormalize(input);
  if (COMPANY_SYMBOL_OVERRIDES.has(rawInput)) {
    return COMPANY_SYMBOL_OVERRIDES.get(rawInput);
  }
  if (normalizedCompanyMap.has(rawInput)) {
    return normalizedCompanyMap.get(rawInput);
  }

  // 4. Fuzzy prefix / substring match against registered companies
  if (isLoaded && normInput.length > 2) {
    for (const [normCompany, symbol] of normalizedCompanyMap.entries()) {
      if (normCompany === normInput || normCompany.startsWith(normInput) || normInput.startsWith(normCompany)) {
        return symbol;
      }
    }
  }

  // 5. Fallback: clean up common text suffixes from Moneycontrol title string
  const cleanedSymbol = inputUpper
    .replace(/(?:LIMITED|LTD|INDUSTRIES|IND|INDIA|CORP|ENTERPRISES|HOLDINGS|SERVICES|BANK).*$/i, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim();

  return cleanedSymbol || inputUpper;
}

function getCompanyName(symbol) {
  if (!symbol) return '';
  const clean = String(symbol).toUpperCase().replace(/-(EQ|BE|SM|ST|BZ|E1|E2)$/i, '').trim();
  const entry = symbolMap.get(clean) || symbolMap.get(String(symbol).toUpperCase().trim());
  return entry ? (entry.companyName || '') : '';
}

function getListingDetails(symbol) {
  if (!symbol) return null;
  const clean = String(symbol).toUpperCase().replace(/-(EQ|BE|SM|ST|BZ|E1|E2)$/i, '').trim();
  return symbolMap.get(clean) || symbolMap.get(String(symbol).toUpperCase().trim()) || null;
}

function getISIN(symbol) {
  const details = getListingDetails(symbol);
  return details?.isin || '';
}

function getSymbolByISIN(isin) {
  if (!isin) return null;
  return isinMap.get(String(isin).toUpperCase().trim()) || null;
}

function mapInstrumentId(instrumentId, symbol, companyName) {
  if (!instrumentId || !symbol) return;
  const cleanSym = String(symbol).toUpperCase().replace(/-(EQ|BE|SM|ST|BZ|E1|E2)$/i, '').trim();
  instrumentIdMap.set(String(instrumentId).trim(), {
    symbol: cleanSym,
    companyName: companyName || getCompanyName(cleanSym) || cleanSym
  });
}

function findInstrumentById(instrumentId) {
  if (!instrumentId) return null;
  return instrumentIdMap.get(String(instrumentId).trim()) || null;
}

function getAllSymbols() {
  return Array.from(symbolMap.values());
}

module.exports = {
  loadNSEMaster: downloadAndReplaceNSEListings,
  downloadAndReplaceNSEListings,
  loadFromDisk,
  startDailyNSESchedule,
  resolveNSESymbol,
  getCompanyName,
  getListingDetails,
  getISIN,
  getSymbolByISIN,
  mapInstrumentId,
  findInstrumentById,
  getAllSymbols,
  isLoaded: () => isLoaded,
  getLastDownloadDate: () => lastDownloadDate
};
