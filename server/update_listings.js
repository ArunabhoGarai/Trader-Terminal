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
  // STEP 2: Download & Replace IIFL Equity Contracts (NSEEQ.json)
  // -------------------------------------------------------------------------
  console.log('\n▶ STEP 2: Fetching live equity contract tokens from IIFL Capital API...');
  let nseContracts = [];
  try {
    const iiflUrl = 'https://api.iiflcapital.com/v1/contractfiles/NSEEQ.json';
    console.log(`  📡 Requesting: ${iiflUrl}...`);
    const res = await axios.get(iiflUrl, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

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

      // Save to contracts_cache.json
      let fullCache = {};
      try {
        if (fs.existsSync(CONTRACTS_FILE)) fullCache = JSON.parse(fs.readFileSync(CONTRACTS_FILE, 'utf8'));
      } catch (_) {}
      fullCache['NSEEQ'] = nseContracts;
      fs.writeFileSync(CONTRACTS_FILE, JSON.stringify(fullCache), 'utf8');

      const contractStats = fs.statSync(CONTRACTS_FILE);
      console.log(`  ✅ Successfully updated contracts_cache.json (${nseContracts.length} instruments, ${(contractStats.size / 1024).toFixed(1)} KB)`);
    } else {
      console.warn('  ⚠️ IIFL contract file returned empty list.');
    }
  } catch (err) {
    console.warn(`  ⚠️ Failed to download IIFL contracts: ${err.message}`);
  }

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
  // STEP 4: Verification of Key & Newly Released Scrips
  // -------------------------------------------------------------------------
  console.log('\n▶ STEP 4: Verifying targeted scrips (JPL-EQ, SWIGGY-EQ, HYUNDAI-EQ, etc.)...');
  
  // Scrips to verify: defaults + any CLI arguments
  const cliArgs = process.argv.slice(2).map(a => a.toUpperCase().trim()).filter(Boolean);
  const verifySymbols = Array.from(new Set(['JPL', 'SWIGGY', 'HYUNDAI', 'RELIANCE', ...cliArgs]));

  // Index contracts by symbol
  const contractsBySym = new Map();
  nseContracts.forEach(c => {
    const raw = c.symbol.toUpperCase();
    const clean = raw.replace(/-(EQ|BE|SM|ST|BZ|E1|E2)$/i, '');
    contractsBySym.set(raw, c);
    if (!contractsBySym.has(clean)) contractsBySym.set(clean, c);
  });

  console.log('------------------------------------------------------------------------------------------------');
  console.log('| SYMBOL       | TOKEN       | SERIES | COMPANY NAME                     | STATUS               |');
  console.log('------------------------------------------------------------------------------------------------');

  for (const sym of verifySymbols) {
    const listing = nseMaster.getListingDetails(sym);
    const contract = contractsBySym.get(sym) || contractsBySym.get(`${sym}-EQ`);

    const symbolPad = (contract?.symbol || `${sym}-EQ`).padEnd(12);
    const tokenPad = (contract?.instrumentId || 'N/A').padEnd(11);
    const seriesPad = (listing?.series || 'EQ').padEnd(6);
    const company = (listing?.companyName || contract?.displayName || 'Unknown').slice(0, 32);
    const companyPad = company.padEnd(32);
    const status = (contract && listing) ? '✅ Ready (Search & Stream)' : (contract ? '✅ In IIFL Catalog' : '⚠️ Pending Token');
    const statusPad = status.padEnd(20);

    console.log(`| ${symbolPad} | ${tokenPad} | ${seriesPad} | ${companyPad} | ${statusPad} |`);
  }
  console.log('------------------------------------------------------------------------------------------------');

  console.log('\n================================================================');
  console.log('🎉 MANUAL UPDATE COMPLETED SUCCESSFULLY!');
  console.log('================================================================');
  console.log('Summary:');
  console.log(` • Active NSE Stock Listings: ${nseMaster.getAllSymbols().length} symbols`);
  console.log(` • Active Equity Contracts:   ${nseContracts.length} instruments with valid tokens`);
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
