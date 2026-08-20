'use strict';

/**
 * IIFL Real-Time Market Data Stream (Binary MQTT Bridge)
 * 
 * Official Reference: https://github.com/IIFLCapital/BridgePy
 * Endpoint: bridge.iiflcapital.com:8883 (TLS)
 * Auth:
 *   Username: Extracted JWT preferred_username / sub
 *   Password: "OPENID~~" + userSessionToken + "~"
 * Topics:
 *   Market Quotes: prod/marketfeed/mw/v1/<exchange>/<instrumentId>
 *   Indices:       prod/marketfeed/index/v1/<exchange>/<instrumentId>
 *   52W High:      prod/marketfeed/high52week/v1/<exchange>
 *   52W Low:       prod/marketfeed/low52week/v1/<exchange>
 *   Upper Circuit: prod/marketfeed/uppercircuit/v1/<exchange>
 *   Lower Circuit: prod/marketfeed/lowercircuit/v1/<exchange>
 *   Market Status: prod/marketfeed/marketstatus/v1/<exchange>
 *   Open Interest: prod/marketfeed/oi/v1/<exchange>/<instrumentId>
 */

const mqtt = require('mqtt');
const EventEmitter = require('events');

function extractUsernameFromToken(token) {
  if (!token) return 'tester';
  try {
    const parts = String(token).split('.');
    if (parts.length >= 2) {
      let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4) payload += '=';
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      return decoded.preferred_username || decoded.sub || decoded.client_id || decoded.userId || 'tester';
    }
  } catch (_) {}
  return 'tester';
}

function formatDateClientId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = String(d.getFullYear()).slice(-2);
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  const secs = pad(d.getSeconds());
  return `bridgePy${day}${month}${year}${hours}${mins}${secs}`;
}

class IIFLMarketDataStream extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || 'bridge.iiflcapital.com';
    this.port = options.port || 8883;
    this.token = options.token || null;
    this.client = null;
    this.isConnected = false;
    this.subscribedTopics = new Set();
    this.reconnectTimer = null;
    this.isExplicitDisconnect = false;

    // Official IIFL topic prefixes
    this.TOPIC_MW = 'prod/marketfeed/mw/v1/';
    this.TOPIC_INDEX = 'prod/marketfeed/index/v1/';
    this.TOPIC_OI = 'prod/marketfeed/oi/v1/';
    this.TOPIC_STATUS = 'prod/marketfeed/marketstatus/v1/';
    this.TOPIC_LPP = 'prod/marketfeed/lpp/v1/';
    this.TOPIC_52HIGH = 'prod/marketfeed/high52week/v1/';
    this.TOPIC_52LOW = 'prod/marketfeed/low52week/v1/';
    this.TOPIC_UPPER_CIRCUIT = 'prod/marketfeed/uppercircuit/v1/';
    this.TOPIC_LOWER_CIRCUIT = 'prod/marketfeed/lowercircuit/v1/';
  }

  /**
   * Connect to IIFL Market Data Stream Bridge
   * @param {string} userSessionToken - Active session token from IIFL login
   */
  connect(userSessionToken) {
    if (userSessionToken) this.token = userSessionToken;
    if (!this.token) {
      console.warn('[IIFL STREAM] ⚠️ Cannot connect: userSession token is missing.');
      return;
    }

    if (this.client && this.isConnected) {
      console.log('[IIFL STREAM] ℹ️ Already connected to bridge.');
      return;
    }

    this.isExplicitDisconnect = false;
    const brokerUrl = `mqtts://${this.host}:${this.port}`;
    const username = extractUsernameFromToken(this.token);
    const password = `OPENID~~${this.token}~`;
    const clientId = formatDateClientId();

    console.log(`[IIFL STREAM] 🔌 Connecting to ${brokerUrl} as ${username} (${clientId})...`);

    const mqttOptions = {
      username,
      password,
      clientId,
      protocolVersion: 4, // MQTT v3.1.1
      clean: true,
      keepalive: 20,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      rejectUnauthorized: false,
    };

    try {
      this.client = mqtt.connect(brokerUrl, mqttOptions);

      this.client.on('connect', (connack) => {
        this.isConnected = true;
        console.log('[IIFL STREAM] ✅ Connected to IIFL Market Data Stream Bridge (CONNACK Success).');
        this.emit('connected', connack);

        // Resubscribe to all active topics on reconnection
        if (this.subscribedTopics.size > 0) {
          const topicsArray = Array.from(this.subscribedTopics);
          this._rawSubscribe(topicsArray);
        }
      });

      this.client.on('message', (topic, message) => {
        this._handleBinaryMessage(topic, message);
      });

      this.client.on('error', (err) => {
        console.warn('[IIFL STREAM] ⚠️ Stream error:', err.message);
        this.emit('error', err);
      });

      this.client.on('close', () => {
        this.isConnected = false;
        console.log('[IIFL STREAM] 🔌 Stream connection closed.');
        this.emit('disconnected');
      });

      this.client.on('offline', () => {
        this.isConnected = false;
        console.log('[IIFL STREAM] ⏳ Stream offline, waiting to reconnect...');
      });
    } catch (err) {
      console.error('[IIFL STREAM] ❌ Connection error:', err.message);
      this.emit('error', err);
    }
  }

  /**
   * Subscribe to market data scrips or indices
   * Formats topics with official IIFL prefixes (e.g. prod/marketfeed/mw/v1/nseeq/2885)
   * @param {string[]} rawTokens - e.g. ['nseeq/2885', 'nseeq/999920000', 'bseeq/999901', 'nseeq']
   */
  subscribe(rawTokens) {
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) return;
    
    const fullTopics = [];

    for (const raw of rawTokens) {
      const clean = String(raw).trim().toLowerCase();
      if (!clean) continue;

      if (clean === 'nseeq' || clean === 'bseeq' || clean === 'nsefo') {
        // Event channels (52W High/Low, Circuits, Status)
        fullTopics.push(this.TOPIC_52HIGH + clean);
        fullTopics.push(this.TOPIC_52LOW + clean);
        fullTopics.push(this.TOPIC_STATUS + clean);
        fullTopics.push(this.TOPIC_UPPER_CIRCUIT + clean);
        fullTopics.push(this.TOPIC_LOWER_CIRCUIT + clean);
      } else if (clean.includes('999920000') || clean.includes('999920005') || clean.includes('999901') || clean.includes('26000') || clean.includes('26009')) {
        // Indices
        fullTopics.push(this.TOPIC_INDEX + clean);
        fullTopics.push(this.TOPIC_MW + clean);
      } else {
        // Market quotes
        fullTopics.push(this.TOPIC_MW + clean);
      }
    }

    fullTopics.forEach(t => this.subscribedTopics.add(t));

    if (this.isConnected && this.client) {
      this._rawSubscribe(fullTopics);
    }
  }

  /**
   * Unsubscribe from market data topics
   */
  unsubscribe(rawTokens) {
    if (!Array.isArray(rawTokens) || rawTokens.length === 0) return;
    
    const fullTopics = [];
    for (const raw of rawTokens) {
      const clean = String(raw).trim().toLowerCase();
      fullTopics.push(this.TOPIC_MW + clean);
      fullTopics.push(this.TOPIC_INDEX + clean);
    }

    fullTopics.forEach(t => this.subscribedTopics.delete(t));

    if (this.isConnected && this.client) {
      this.client.unsubscribe(fullTopics, (err) => {
        if (err) console.warn('[IIFL STREAM] ⚠️ Unsubscribe error:', err.message);
      });
    }
  }

  /**
   * Internal batch subscription helper (max 1024 topics per MQTT SUB request)
   */
  _rawSubscribe(topicsList) {
    const BATCH_SIZE = 1024;
    for (let i = 0; i < topicsList.length; i += BATCH_SIZE) {
      const batch = topicsList.slice(i, i + BATCH_SIZE);
      this.client.subscribe(batch, { qos: 0 }, (err, granted) => {
        if (err) {
          console.warn('[IIFL STREAM] ⚠️ Batch subscription error:', err.message);
        } else {
          console.log(`[IIFL STREAM] 📡 Subscribed to ${batch.length} topic(s) (granted: ${granted?.length || 0}).`);
        }
      });
    }
  }

  /**
   * Disconnect from IIFL stream
   */
  disconnect() {
    this.isExplicitDisconnect = true;
    this.isConnected = false;
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    console.log('[IIFL STREAM] 🛑 Disconnected from stream.');
  }

  /**
   * High-speed binary message router and decoder
   */
  _handleBinaryMessage(topic, buffer) {
    if (!Buffer.isBuffer(buffer)) {
      buffer = Buffer.from(buffer);
    }

    const topicStr = String(topic).toLowerCase().trim();
    const len = buffer.length;

    try {
      if (topicStr.includes('/mw/') || topicStr.includes('/index/')) {
        // Market Feed or Index Feed (188 bytes)
        const subTopic = topicStr.split('v1/')[1] || '';
        const quote = parseMarketFeed(buffer, subTopic);
        if (quote) {
          this.emit('quote', quote);
        }
      } else if (topicStr.includes('/high52week/')) {
        // 52-Week High (12 bytes)
        const subTopic = topicStr.split('v1/')[1] || '';
        const highEvent = parse52WHigh(buffer, subTopic);
        if (highEvent) this.emit('52w_high', highEvent);
      } else if (topicStr.includes('/low52week/')) {
        // 52-Week Low (12 bytes)
        const subTopic = topicStr.split('v1/')[1] || '';
        const lowEvent = parse52WLow(buffer, subTopic);
        if (lowEvent) this.emit('52w_low', lowEvent);
      } else if (topicStr.includes('/oi/')) {
        // Open Interest (16 bytes)
        const oi = parseOpenInterest(buffer, topicStr);
        if (oi) this.emit('open_interest', oi);
      } else if (topicStr.includes('/marketstatus/')) {
        // Market Status (2 bytes)
        const status = parseMarketStatus(buffer, topicStr);
        if (status) this.emit('market_status', status);
      }
    } catch (err) {
      console.warn(`[IIFL STREAM] ⚠️ Error parsing packet on topic ${topicStr}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Binary Packet Decoders (Strict Little-Endian as per IIFL Documentation)
// ---------------------------------------------------------------------------

function parseMarketFeed(buffer, subTopic = '') {
  if (buffer.length < 188) return null;

  let exchange = 'NSEEQ';
  let instrumentId = '';
  if (subTopic && subTopic.includes('/')) {
    const parts = subTopic.split('/');
    exchange = parts[0].toUpperCase();
    instrumentId = parts[1];
  }

  // Little-endian binary extraction
  const ltpRaw = buffer.readInt32LE(0);
  const lastTradedQuantity = buffer.readUInt32LE(4);
  const tradedVolume = buffer.readUInt32LE(8);
  const highRaw = buffer.readInt32LE(12);
  const lowRaw = buffer.readInt32LE(16);
  const openRaw = buffer.readInt32LE(20);
  const closeRaw = buffer.readInt32LE(24);
  const averageTradedPriceRaw = buffer.readInt32LE(28);
  // bytes 32-33: reserved
  const bestBidQuantity = buffer.readUInt32LE(34);
  const bestBidPriceRaw = buffer.readInt32LE(38);
  const bestAskQuantity = buffer.readUInt32LE(42);
  const bestAskPriceRaw = buffer.readInt32LE(46);
  const totalBidQuantity = buffer.readUInt32LE(50);
  const totalAskQuantity = buffer.readUInt32LE(54);
  const priceDivisor = buffer.readInt32LE(58) || 100;
  const lastTradedTime = buffer.readInt32LE(62);

  // Market Depth: 5 Bids + 5 Asks (120 bytes, offset 66..185)
  const bids = [];
  let offset = 66;
  for (let i = 0; i < 5; i++) {
    const qty = buffer.readUInt32LE(offset);
    const priceRaw = buffer.readInt32LE(offset + 4);
    const orders = buffer.readInt16LE(offset + 8);
    bids.push({
      quantity: qty,
      price: +(priceRaw / priceDivisor).toFixed(2),
      orders
    });
    offset += 12;
  }

  const asks = [];
  for (let i = 0; i < 5; i++) {
    const qty = buffer.readUInt32LE(offset);
    const priceRaw = buffer.readInt32LE(offset + 4);
    const orders = buffer.readInt16LE(offset + 8);
    asks.push({
      quantity: qty,
      price: +(priceRaw / priceDivisor).toFixed(2),
      orders
    });
    offset += 12;
  }

  const ltp = +(ltpRaw / priceDivisor).toFixed(2);
  const high = +(highRaw / priceDivisor).toFixed(2);
  const low = +(lowRaw / priceDivisor).toFixed(2);
  const open = +(openRaw / priceDivisor).toFixed(2);
  const close = +(closeRaw / priceDivisor).toFixed(2);
  const averageTradedPrice = +(averageTradedPriceRaw / priceDivisor).toFixed(2);
  const bestBidPrice = +(bestBidPriceRaw / priceDivisor).toFixed(2);
  const bestAskPrice = +(bestAskPriceRaw / priceDivisor).toFixed(2);

  const diff = close > 0 ? +(ltp - close).toFixed(2) : 0;
  const pctChange = close > 0 ? +(((ltp - close) / close) * 100).toFixed(2) : 0;

  return {
    exchange,
    instrumentId,
    lastPrice: ltp,
    pctChange,
    close,
    open,
    high,
    low,
    bestBidPrice,
    bestBidQty: bestBidQuantity,
    bestAskPrice,
    bestAskQty: bestAskQuantity,
    totalBidQuantity,
    totalAskQuantity,
    tradedVolume,
    averageTradedPrice,
    lastTradedTime,
    bids,
    asks,
    priceDivisor,
    updatedAt: new Date().toISOString()
  };
}

function parse52WHigh(buffer, subTopic = '') {
  if (buffer.length < 12) return null;
  const instrumentId = String(buffer.readUInt32LE(0));
  const highRaw = buffer.readUInt32LE(4);
  const priceDivisor = buffer.readInt32LE(8) || 100;
  return {
    exchange: subTopic ? subTopic.toUpperCase() : 'NSEEQ',
    instrumentId,
    week52High: +(highRaw / priceDivisor).toFixed(2)
  };
}

function parse52WLow(buffer, subTopic = '') {
  if (buffer.length < 12) return null;
  const instrumentId = String(buffer.readUInt32LE(0));
  const lowRaw = buffer.readUInt32LE(4);
  const priceDivisor = buffer.readInt32LE(8) || 100;
  return {
    exchange: subTopic ? subTopic.toUpperCase() : 'NSEEQ',
    instrumentId,
    week52Low: +(lowRaw / priceDivisor).toFixed(2)
  };
}

function parseOpenInterest(buffer, topic = '') {
  if (buffer.length < 16) return null;
  return {
    openInterest: buffer.readInt32LE(0),
    dayHighOi: buffer.readInt32LE(4),
    dayLowOi: buffer.readInt32LE(8),
    previousOi: buffer.readInt32LE(12)
  };
}

function parseMarketStatus(buffer, topic = '') {
  if (buffer.length < 2) return null;
  const code = buffer.readInt16LE(0);
  const statusMap = {
    0: 'Pre-Open Started', 1: 'Pre-Open Closed', 2: 'Market Opened',
    3: 'Call Auction Started', 4: 'Call Auction Closed', 5: 'Auction Market Started',
    6: 'Auction Market Closed', 7: 'Market Closed', 8: 'Closing Session Opened',
    9: 'Closing Session Closed', 10: 'Halt'
  };
  return {
    statusCode: code,
    statusText: statusMap[code] || 'Unknown'
  };
}

module.exports = {
  IIFLMarketDataStream,
  parseMarketFeed,
  parse52WHigh,
  parse52WLow,
  parseOpenInterest,
  parseMarketStatus
};
