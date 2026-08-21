'use strict';

/**
 * NSE Official 52-Week High & Low Master Data Loader
 * 
 * Source: https://nsearchives.nseindia.com/content/CM_52_wk_High_low_DDMMYYYY.csv
 * Format: "SYMBOL","SERIES","Adjusted 52_Week_High","52_Week_High_Date","Adjusted 52_Week_Low","52_Week_Low_DT"
 * 
 * Features:
 * 1. Automatic date fallback: Tries today's date (DDMMYYYY), then rolls back up to 7 previous days.
 * 2. Caches parsed master to server/cache/nse_52w_master.json for offline resilience.
 * 3. Instant O(1) in-memory lookup via get52WBounds(symbol).
 * 4. Automated daily schedule at 8:00 PM IST (20:00).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'nse_52w_master.json');

const nse52WMap = new Map(); // cleanSymbol -> { symbol, series, high, low, highDate, lowDate }
let isFetching = false;
let lastFetchTime = null;
let lastEffectiveDate = null;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
  }
}

function formatDateDDMMYYYY(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  return `${day}${month}${year}`;
}

function loadCached52W() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data.records === 'object') {
        nse52WMap.clear();
        for (const [k, v] of Object.entries(data.records)) {
          nse52WMap.set(k.toUpperCase().trim(), v);
        }
        lastEffectiveDate = data.effectiveDate || null;
        console.log(`[NSE 52W MASTER] 📂 Loaded ${nse52WMap.size} scrips from local cache (Effective: ${lastEffectiveDate || 'N/A'}).`);
      }
    }
  } catch (err) {
    console.warn('[NSE 52W MASTER] ⚠️ Failed to load local cache:', err.message);
  }
}

function parse52WCSV(csvContent) {
  const records = {};
  const lines = csvContent.split(/\r?\n/);
  let effectiveDate = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.includes('Effective for')) {
      const match = line.match(/Effective for ([^",\r\n]+)/i);
      if (match) effectiveDate = match[1].trim();
      continue;
    }

    if (line.startsWith('"SYMBOL"') || line.startsWith('SYMBOL')) continue;
    if (line.startsWith('"Disclaimer') || line.startsWith('Disclaimer')) continue;

    // CSV format: "SYMBOL","SERIES","Adjusted 52_Week_High","52_Week_High_Date","Adjusted 52_Week_Low","52_Week_Low_DT"
    const parts = line.split(',').map(p => p.replace(/^["'\s]+|["'\s]+$/g, ''));
    if (parts.length >= 6) {
      const sym = parts[0].toUpperCase().trim();
      const series = parts[1].toUpperCase().trim();
      const high = parseFloat(parts[2]);
      const highDate = parts[3];
      const low = parseFloat(parts[4]);
      const lowDate = parts[5];

      if (sym && !isNaN(high) && !isNaN(low)) {
        const clean = sym.replace(/-(EQ|BE|SM|ST|BZ|E1|E2|N[1-9]|RR)$/i, '').trim();
        const item = {
          symbol: sym,
          series,
          high: +high.toFixed(2),
          low: +low.toFixed(2),
          highDate,
          lowDate,
        };

        // Prefer EQ series if multiple series exist
        if (!records[clean] || series === 'EQ') {
          records[clean] = item;
        }
        records[sym] = item;
      }
    }
  }

  return { records, effectiveDate };
}

async function fetchNSE52WeekMaster() {
  if (isFetching) return false;
  isFetching = true;

  console.log('[NSE 52W MASTER] 🔄 Fetching official NSE 52-Week High & Low master file...');
  ensureCacheDir();

  // Try today and rollback up to 7 days
  const now = new Date();
  let success = false;

  for (let offset = 0; offset < 7; offset++) {
    const targetDate = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const dateStr = formatDateDDMMYYYY(targetDate);
    const url = `https://nsearchives.nseindia.com/content/CM_52_wk_High_low_${dateStr}.csv`;

    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/csv,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 10000,
      });

      if (response.status === 200 && response.data && typeof response.data === 'string' && response.data.includes('52_Week')) {
        const { records, effectiveDate } = parse52WCSV(response.data);
        const count = Object.keys(records).length;

        if (count > 100) {
          nse52WMap.clear();
          for (const [k, v] of Object.entries(records)) {
            nse52WMap.set(k, v);
          }
          lastEffectiveDate = effectiveDate || dateStr;
          lastFetchTime = new Date().toISOString();

          // Save to cache file
          fs.writeFileSync(CACHE_FILE, JSON.stringify({
            effectiveDate: lastEffectiveDate,
            fetchedAt: lastFetchTime,
            dateStr,
            records,
          }, null, 2), 'utf8');

          console.log(`[NSE 52W MASTER] ✅ Successfully loaded & cached ${count} scrips for ${lastEffectiveDate} (from archive ${dateStr}).`);
          success = true;
          break;
        }
      }
    } catch (err) {
      // 404 is normal for non-trading days or today's file before market close
    }
  }

  isFetching = false;
  if (!success) {
    console.warn('[NSE 52W MASTER] ⚠️ Could not fetch fresh online archive; falling back to existing cache.');
    if (nse52WMap.size === 0) loadCached52W();
  }
  return success;
}

function get52WBounds(symbol) {
  if (!symbol) return null;
  const raw = String(symbol).toUpperCase().trim();
  const clean = raw.replace(/-(EQ|BE|SM|ST|BZ|E1|E2|N[1-9]|RR)$/i, '').trim();
  
  return nse52WMap.get(clean) || nse52WMap.get(raw) || nse52WMap.get(`${clean}-EQ`) || null;
}

function startDaily52WSchedule() {
  // 1. Initial load from cache immediately
  loadCached52W();

  // 2. Fetch fresh archive right now on startup
  fetchNSE52WeekMaster().catch(() => {});

  // 3. Schedule daily run at 8:00 PM IST (20:00)
  // Check every 15 minutes if current IST time is 20:00..20:30 and we haven't fetched today
  setInterval(() => {
    try {
      const istString = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const istDate = new Date(istString);
      const hour = istDate.getHours();
      const todayStr = formatDateDDMMYYYY(istDate);

      // Trigger at 8:00 PM IST (hour === 20)
      if (hour === 20) {
        const lastDate = lastFetchTime ? formatDateDDMMYYYY(new Date(lastFetchTime)) : '';
        if (lastDate !== todayStr) {
          console.log('[NSE 52W MASTER] ⏰ 8:00 PM IST Daily Trigger: Refreshing 52-Week High & Low master file...');
          fetchNSE52WeekMaster().catch(() => {});
        }
      }
    } catch (_) {}
  }, 15 * 60 * 1000);
}

module.exports = {
  startDaily52WSchedule,
  fetchNSE52WeekMaster,
  get52WBounds,
  loadCached52W,
  get52WCount: () => nse52WMap.size,
  getLastEffectiveDate: () => lastEffectiveDate,
};
