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
  return entry ? entry.companyName : '';
}

function getAllSymbols() {
  return Array.from(symbolMap.values());
}

module.exports = {
  loadNSEMaster,
  resolveNSESymbol,
  getCompanyName,
  getAllSymbols,
  isLoaded: () => isLoaded
};
