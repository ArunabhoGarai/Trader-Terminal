'use strict';

/**
 * IIFL Real-Time Market Data Stream (Binary WebSocket / MQTT Bridge)
 * 
 * Official documentation: https://developers.iiflcapital.com/apidocs/marketdatastream
 * Host: bridge.iiflcapital.com:8883 (TLS)
 * Capacity: Up to 1024 subscriptions per batch, up to 6000 per client
 */

const mqtt = require('mqtt');
const EventEmitter = require('events');

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
    console.log(`[IIFL STREAM] 🔌 Connecting to ${brokerUrl} ...`);

    const mqttOptions = {
      username: this.token,
      password: this.token,
      clientId: `iifl_tt_${Date.now()}_${Math.random().toString(16).substring(2, 8)}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      rejectUnauthorized: false, // Permit self-signed or internal CA if needed
    };

    try {
      this.client = mqtt.connect(brokerUrl, mqttOptions);

      this.client.on('connect', (connack) => {
        this.isConnected = true;
        console.log('[IIFL STREAM] ✅ Connected to IIFL Market Data Stream Bridge (CONNACK).');
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
        console.log('[IIFL STREAM] ⏳ Stream is offline, waiting to reconnect...');
      });
    } catch (err) {
      console.error('[IIFL STREAM] ❌ Connection error:', err.message);
      this.emit('error', err);
    }
  }

  /**
   * Subscribe to market data topics in batches of up to 1024 topics
   * @param {string[]} topics - e.g. ['nseeq/2885', 'nsefo/35005', 'bseeq/999901', 'nseeq']
   */
  subscribe(topics) {
    if (!Array.isArray(topics) || topics.length === 0) return;
    
    const validTopics = topics
      .map(t => String(t).trim().toLowerCase())
      .filter(Boolean);

    validTopics.forEach(t => this.subscribedTopics.add(t));

    if (this.isConnected && this.client) {
      this._rawSubscribe(validTopics);
    }
  }

  /**
   * Unsubscribe from market data topics
   * @param {string[]} topics 
   */
  unsubscribe(topics) {
    if (!Array.isArray(topics) || topics.length === 0) return;
    const cleanTopics = topics.map(t => String(t).trim().toLowerCase()).filter(Boolean);
    cleanTopics.forEach(t => this.subscribedTopics.delete(t));

    if (this.isConnected && this.client) {
      this.client.unsubscribe(cleanTopics, (err) => {
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
          console.log(`[IIFL STREAM] 📡 Subscribed to batch of ${batch.length} topics (granted: ${granted?.length || 0}).`);
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
      if (len === 188) {
        // 1. Market Feed (188 bytes)
        const quote = parseMarketFeed(buffer, topicStr);
        if (quote) {
          this.emit('quote', quote);
          this.emit(`quote:${quote.exchange}:${quote.instrumentId}`, quote);
        }
      } else if (len === 12) {
        // 2. 52-Week High / 52-Week Low / Upper Circuit / Lower Circuit / LPP (12 bytes)
        if (topicStr.includes('high') || topicStr === 'nseeq' || topicStr === 'bseeq') {
          const highEvent = parse52WHigh(buffer, topicStr);
          if (highEvent) this.emit('52w_high', highEvent);
        } else if (topicStr.includes('low')) {
          const lowEvent = parse52WLow(buffer, topicStr);
          if (lowEvent) this.emit('52w_low', lowEvent);
        }
      } else if (len === 16) {
        // 3. Open Interest (16 bytes)
        const oi = parseOpenInterest(buffer, topicStr);
        if (oi) this.emit('open_interest', oi);
      } else if (len === 2) {
        // 4. Market Status (2 bytes)
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

function parseMarketFeed(buffer, topic = '') {
  if (buffer.length < 188) return null;

  // Header topic parsing: e.g. "nseeq/2885" -> exchange="NSEEQ", instrumentId="2885"
  let exchange = 'NSEEQ';
  let instrumentId = '';
  if (topic && topic.includes('/')) {
    const parts = topic.split('/');
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

  // Market Depth: 5 Bids (12 bytes each) + 5 Asks (12 bytes each) = 120 bytes (offset 66..185)
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

function parse52WHigh(buffer, topic = '') {
  if (buffer.length < 12) return null;
  const instrumentId = String(buffer.readUInt32LE(0));
  const highRaw = buffer.readUInt32LE(4);
  const priceDivisor = buffer.readInt32LE(8) || 100;
  return {
    exchange: topic.split('/')[0]?.toUpperCase() || 'NSEEQ',
    instrumentId,
    week52High: +(highRaw / priceDivisor).toFixed(2)
  };
}

function parse52WLow(buffer, topic = '') {
  if (buffer.length < 12) return null;
  const instrumentId = String(buffer.readUInt32LE(0));
  const lowRaw = buffer.readUInt32LE(4);
  const priceDivisor = buffer.readInt32LE(8) || 100;
  return {
    exchange: topic.split('/')[0]?.toUpperCase() || 'NSEEQ',
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
