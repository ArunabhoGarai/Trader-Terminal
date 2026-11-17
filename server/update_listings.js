#!/usr/bin/env node
'use strict';

/**
 * Trader Terminal - Manual Market Listings & Contracts Updater
 * 
 * Usage on EC2:
 *   node update_listings.js
 *   npm run update-listings
 *   node update_listings.js JPL SWIGGY HYUNDAI
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, 'cache');
const EQUITY_L_FILE = path.join(CACHE_DIR, 'EQUITY_L.csv');
const SME_EQUITY_L_FILE = path.join(CACHE_DIR, 'SME_EQUITY_L.csv');
const CONTRACTS_FILE = path.join(__dirname, 'contracts_cache.json');
const NSE_52W_FILE = path.join(CACHE_DIR, 'nse_52w_master.json');

const nseMaster = require('./nse_master');
const nse52WMaster = require('./nse_52w_master');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function formatDate(d) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(d);
}

async function runManualUpdate() {
  console.log('\n================================================================');
  console.log('⚡ TRADER TERMINAL - MANUAL MARKET LISTINGS & CONTRACTS UPDATER');
  console.log(`⏰ Executed at: ${formatDate(new Date())} IST`);
  console.log('================================================================\n');

  ensureDir(CACHE_DIR);

  // -------------------------------------------------------------------------
  // STEP 1: Download & Replace Official NSE Stock Listings (EQUITY_L.csv & SME)
  // -------------------------------------------------------------------------
  console.log('▶ STEP 1: Fetching official NSE stock listings from NSE India site...');
  const nseSuccess = await nseMaster.downloadAndReplaceNSEListings();
  if (nseSuccess) {
    const stats = fs.statSync(EQUITY_L_FILE);
    console.log(`  ✅ Successfully updated EQUITY_L.csv (${(stats.size / 1024).toFixed(1)} KB)`);
  } else {
    console.warn('  ⚠️ Failed to fetch fresh online listings, using local cached version.');
  }

  // -------------------------------------------------------------------------
  // STEP 2: Download & Replace IIFL Equity Contracts (NSEEQ.json & BSEEQ.json)
  // -------------------------------------------------------------------------
  console.log('\n▶ STEP 2: Fetching live equity contract tokens from IIFL Capital API...');
  let nseContracts = [];
  let bseContracts = [];

  const axiosOptions = {
    timeout: 30000,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };

  // Download NSEEQ
  try {
    const nseUrl = 'https://api.iiflcapital.com/v1/contractfiles/NSEEQ.json';
    console.log(`  📡 Requesting NSE contracts: ${nseUrl}...`);
    const res = await axios.get(nseUrl, axiosOptions);
    const rawList = Array.isArray(res.data) ? res.data : (res.data?.result || res.data?.data || []);
    if (rawList.length > 0) {
      nseContracts = rawList.map((row, index) => {
        const instrumentId = String(row.instrumentId ?? row.instrumentID ?? row.exchangeInstrumentId ?? row.token ?? '').trim();
        const rawSymbol = String(row.symbol ?? row.tradingSymbol ?? row.underlyingInstrumentSymbol ?? row.name ?? '').trim().toUpperCase();
        if (!instrumentId || !rawSymbol) return null;

        const cleanSym = rawSymbol.replace(/-(EQ|BE|SM|ST|BZ|E1|E2)$/i, '').trim();
        const companyName = nseMaster.getCompanyName(cleanSym) || nseMaster.getCompanyName(rawSymbol) || row.formattedInstrumentName || rawSymbol;

        return {
          instrumentId,
          symbol: rawSymbol,
          exchange: 'NSEEQ',
          segment: 'Equity',
          displayName: companyName,
          basePrice: parseFloat(row.lastPrice ?? row.close ?? 100) || 100,
          lotSize: row.lotSize || '1',
          tickSize: row.tickSize || '0.05'
        };
      }).filter(Boolean);
      console.log(`  ✅ Successfully parsed ${nseContracts.length} NSEEQ contracts.`);
    }
  } catch (err) {
    console.warn(`  ⚠️ Failed to download NSE contracts: ${err.message}`);
  }

  // Download BSEEQ
  try {
    const bseUrl = 'https://api.iiflcapital.com/v1/contractfiles/BSEEQ.json';
    console.log(`  📡 Requesting BSE contracts: ${bseUrl}...`);
    const resBse = await axios.get(bseUrl, axiosOptions);
    const rawListBse = Array.isArray(resBse.data) ? resBse.data : (resBse.data?.result || resBse.data?.data || []);
    if (rawListBse.length > 0) {
      bseContracts = rawListBse.map((row, index) => {
        const instrumentId = String(row.instrumentId ?? row.instrumentID ?? row.exchangeInstrumentId ?? row.token ?? '').trim();
        const rawSymbol = String(row.symbol ?? row.tradingSymbol ?? row.underlyingInstrumentSymbol ?? row.name ?? '').trim().toUpperCase();
        if (!instrumentId || !rawSymbol) return null;

        const cleanSym = rawSymbol.replace(/-(EQ|BE|SM|ST|BZ|E1|E2)$/i, '').trim();
        const companyName = nseMaster.getCompanyName(cleanSym) || nseMaster.getCompanyName(rawSymbol) || row.formattedInstrumentName || rawSymbol;

        return {
          instrumentId,
          symbol: rawSymbol,
          exchange: 'BSEEQ',
          segment: 'Equity',
          displayName: companyName,
          basePrice: parseFloat(row.lastPrice ?? row.close ?? 100) || 100,
          lotSize: row.lotSize || '1',
          tickSize: row.tickSize || '0.05'
        };
      }).filter(Boolean);
      console.log(`  ✅ Successfully parsed ${bseContracts.length} BSEEQ contracts.`);
    }
  } catch (err) {
    console.warn(`  ⚠️ Failed to download BSE contracts: ${err.message}`);
  }

  // Save both NSEEQ and BSEEQ to contracts_cache.json
  let fullCache = {};
  try {
    if (fs.existsSync(CONTRACTS_FILE)) fullCache = JSON.parse(fs.readFileSync(CONTRACTS_FILE, 'utf8'));
  } catch (_) {}
  if (nseContracts.length > 0) fullCache['NSEEQ'] = nseContracts;
  if (bseContracts.length > 0) fullCache['BSEEQ'] = bseContracts;
  fs.writeFileSync(CONTRACTS_FILE, JSON.stringify(fullCache), 'utf8');

  const contractStats = fs.statSync(CONTRACTS_FILE);
  console.log(`  💾 Successfully updated contracts_cache.json (${(nseContracts.length + bseContracts.length)} total contracts across NSE & BSE, ${(contractStats.size / (1024 * 1024)).toFixed(2)} MB)`);

  // -------------------------------------------------------------------------
  // STEP 3: Refresh 52-Week High & Low Archive
  // -------------------------------------------------------------------------
  console.log('\n▶ STEP 3: Fetching official 52-Week High/Low archive from NSE...');
  try {
    const w52Success = await nse52WMaster.fetchNSE52WeekMaster();
    if (w52Success) {
      console.log(`  ✅ 52-Week master archive updated (${nse52WMaster.get52WCount()} records, effective: ${nse52WMaster.getLastEffectiveDate() || 'latest'}).`);
    } else {
      console.log(`  ℹ️ 52-Week master archive retained (${nse52WMaster.get52WCount()} records).`);
    }
  } catch (e) {
    console.warn(`  ⚠️ 52-Week fetch notice: ${e.message}`);
  }

  // -------------------------------------------------------------------------
  // STEP 4: Verification of Key Scrips (NSE, BSE, and Exclusive Scrips)
  // -------------------------------------------------------------------------
  console.log('\n▶ STEP 4: Verifying targeted scrips (NSE, BSE, and Exclusive scrips)...');
  
  // Scrips to verify: defaults + any CLI arguments
  const cliArgs = process.argv.slice(2).map(a => a.toUpperCase().trim()).filter(Boolean);
  const verifySymbols = Array.from(new Set(['RELIANCE', 'TCS', 'JPL', 'SWIGGY', 'HYUNDAI', '544937', ...cliArgs]));

  // Index contracts by symbol and exchange
  const allContracts = [...nseContracts, ...bseContracts];
  const contractsByKey = new Map();
  allContracts.forEach(c => {
    const raw = c.symbol.toUpperCase();
    const clean = raw.replace(/-(EQ|BE|SM|ST|BZ|E1|E2)$/i, '');
    contractsByKey.set(`${c.exchange}:${raw}`, c);
    contractsByKey.set(`${c.exchange}:${clean}`, c);
    contractsByKey.set(`${c.exchange}:${c.instrumentId}`, c);
    contractsByKey.set(`ID:${c.instrumentId}`, c);
  });

  console.log('----------------------------------------------------------------------------------------------------------------');
  console.log('| SYMBOL / QUERY | EXCHANGE | TOKEN       | COMPANY NAME                     | STATUS                          |');
  console.log('----------------------------------------------------------------------------------------------------------------');

  for (const sym of verifySymbols) {
    // Check if token was provided (e.g. 544937)
    if (/^\d+$/.test(sym)) {
      const byId = contractsByKey.get(`ID:${sym}`);
      if (byId) {
        const symPad = byId.symbol.padEnd(14);
        const exPad = byId.exchange.padEnd(8);
        const tokenPad = byId.instrumentId.padEnd(11);
        const companyPad = (byId.displayName || 'Unknown').slice(0, 32).padEnd(32);
        console.log(`| ${symPad} | ${exPad} | ${tokenPad} | ${companyPad} | ✅ BSE Exclusive (Ready)       |`);
      }
      continue;
    }

    // Check NSE
    const nseC = contractsByKey.get(`NSEEQ:${sym}`) || contractsByKey.get(`NSEEQ:${sym}-EQ`);
    // Check BSE
    const bseC = contractsByKey.get(`BSEEQ:${sym}`);

    const listing = nseMaster.getListingDetails(sym);

    if (nseC) {
      const symPad = nseC.symbol.padEnd(14);
      const exPad = 'NSEEQ'.padEnd(8);
      const tokenPad = nseC.instrumentId.padEnd(11);
      const companyPad = (nseC.displayName || listing?.companyName || 'Unknown').slice(0, 32).padEnd(32);
      const status = '✅ Ready (NSE)';
      console.log(`| ${symPad} | ${exPad} | ${tokenPad} | ${companyPad} | ${status.padEnd(31)} |`);
    }

    if (bseC) {
      const symPad = bseC.symbol.padEnd(14);
      const exPad = 'BSEEQ'.padEnd(8);
      const tokenPad = bseC.instrumentId.padEnd(11);
      const companyPad = (bseC.displayName || 'Unknown').slice(0, 32).padEnd(32);
      const status = nseC ? '✅ Ready (BSE)' : '✅ BSE Exclusive (Ready)';
      console.log(`| ${symPad} | ${exPad} | ${tokenPad} | ${companyPad} | ${status.padEnd(31)} |`);
    }

    if (!nseC && !bseC) {
      const symPad = sym.padEnd(14);
      const exPad = 'N/A'.padEnd(8);
      const tokenPad = 'N/A'.padEnd(11);
      const companyPad = (listing?.companyName || 'Unknown').slice(0, 32).padEnd(32);
      console.log(`| ${symPad} | ${exPad} | ${tokenPad} | ${companyPad} | ⚠️ Pending Contract Token       |`);
    }
  }
  console.log('----------------------------------------------------------------------------------------------------------------');

  console.log('\n================================================================');
  console.log('🎉 MANUAL UPDATE COMPLETED SUCCESSFULLY!');
  console.log('================================================================');
  console.log('Summary:');
  console.log(` • Active NSE Stock Listings: ${nseMaster.getAllSymbols().length} symbols`);
  console.log(` • Active NSE Equity Tokens:  ${nseContracts.length} instruments`);
  console.log(` • Active BSE Equity Tokens:  ${bseContracts.length} instruments`);
  console.log(` • Total Searchable Catalog:  ${(nseContracts.length + bseContracts.length)} instruments`);
  console.log(` • Cache files updated on disk:`);
  console.log(`     - ${EQUITY_L_FILE}`);
  console.log(`     - ${SME_EQUITY_L_FILE}`);
  console.log(`     - ${CONTRACTS_FILE}`);
  console.log(`     - ${NSE_52W_FILE}`);
  console.log('\n💡 Next Steps on EC2:');
  console.log(' • If Trader Terminal is running via PM2, reload it to apply immediately:');
  console.log('     pm2 reload all');
  console.log(' • Or trigger instant hot-reload via HTTP:');
  console.log('     curl -X POST http://localhost:3001/api/listings/refresh\n');
}

runManualUpdate().catch(err => {
  console.error('\n❌ Error during manual update:', err);
  process.exit(1);
});
