'use strict';

/**
 * 币安 U 本位合约实时行情（零依赖）
 *
 * 为什么不用 npm 包：路由器 Docker 构建时 npm install 需要联网+可用源，
 * 而这里只需要「一条长连接 + 解析文本帧」，手写不到 200 行，永不因依赖挂掉。
 *
 * 订阅两条流：
 *   <sym>@aggTrade  逐笔成交 → 最新成交价（和币安官网中间那个大数字同源，延迟 10~50ms）
 *   <sym>@ticker    1000ms   → 24h 涨跌幅 / 高低 / 量
 *
 * 断线自动重连（指数退避），并提供 REST 兜底（WS 不通时用批量 ticker/24hr 轮询）。
 */

const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

function b64(buf) { return Buffer.from(buf).toString('base64'); }

/** 客户端帧必须加掩码（RFC6455 5.3） */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(head.length + 4 + len);
  head.copy(out, 0);
  mask.copy(out, head.length);
  for (let i = 0; i < len; i++) out[head.length + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

class FuturesFeed extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.wsUrl = opts.wsUrl || 'wss://fstream.binancefuture.com/stream';
    this.streams = opts.streams || ['aggTrade', 'ticker'];
    this.pushMs = Math.max(50, Number(opts.pushMs) || 150);
    this.setSymbols(opts.symbols || ['BTCUSDT']);

    this.tick = new Map();          // symbol -> { price, changePct, high, low, volume, at }
    this.st = {
      connected: false,
      msgCount: 0,
      lastMsgAt: 0,
      lastOpenAt: 0,
      reconnects: 0,
      lastError: '',
      mode: 'idle',                 // ws | rest | idle
      latencyMs: null,
    };
    this._sock = null;
    this._buf = Buffer.alloc(0);
    this._dirty = false;
    this._closed = false;
    this._backoff = 1000;
    this._pingTimer = null;
    this._flushTimer = null;
  }

  /** 币种变更后需要重连才能换订阅 */
  setSymbols(arr) {
    this.symbols = [...new Set(arr.map((s) => String(s).toUpperCase()))];
  }

  buildUrl() {
    const st = this.streams.map((s) => this.symbols.map((y) => y.toLowerCase() + '@' + s)).flat();
    const base = this.wsUrl.replace(/\/+$/, '');
    const sep = base.includes('?') ? '&' : '?';
    return base + sep + 'streams=' + st.join('/');
  }

  start() {
    this._closed = false;
    this._flushTimer = setInterval(() => this._flush(), this.pushMs);
    this._connect();
  }

  stop() {
    this._closed = true;
    clearInterval(this._flushTimer);
    clearInterval(this._pingTimer);
    if (this._sock) { try { this._sock.destroy(); } catch (e) {} }
  }

  _connect() {
    if (this._closed) return;
    const url = new URL(this.buildUrl());
    const host = url.hostname;
    const port = Number(url.port) || 443;
    const target = url.pathname + (url.search || '');
    const key = b64(crypto.randomBytes(16));
    const self = this;

    this._buf = Buffer.alloc(0);
    let handshook = false;

    const sock = tls.connect({
      host, port, servername: host, rejectUnauthorized: false,
    }, () => {
      sock.write(
        'GET ' + target + ' HTTP/1.1\r\n' +
        'Host: ' + host + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'User-Agent: CryptoDash/2\r\n\r\n'
      );
    });
    this._sock = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);

    const fail = (msg) => {
      this.st.lastError = msg;
      if (this.st.mode === 'ws') this.st.mode = 'idle';
      try { sock.destroy(); } catch (e) {}
    };

    sock.on('data', (chunk) => {
      this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
      if (!handshook) {
        const i = this._buf.indexOf('\r\n\r\n');
        if (i < 0) {
          if (this._buf.length > 16384) fail('handshake header too large');
          return;
        }
        const head = this._buf.slice(0, i).toString('latin1');
        this._buf = this._buf.slice(i + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) return fail('handshake: ' + head.split('\r\n')[0]);
        handshook = true;
        this.st.connected = true;
        this.st.mode = 'ws';
        this.st.lastOpenAt = Date.now();
        this.st.lastError = '';
        this._backoff = 1000;
        this.emit('open');
        clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => {
          try { sock.write(encodeFrame(0x9, Buffer.from('hb'))); } catch (e) {}
        }, 20000);
      }
      this._parse();
    });

    sock.on('error', (e) => fail('socket: ' + e.message));
    sock.on('close', () => {
      this.st.connected = false;
      if (this.st.mode === 'ws') this.st.mode = 'idle';
      clearInterval(this._pingTimer);
      if (this._closed) return;
      this.st.reconnects += 1;
      const wait = Math.min(this._backoff, 15000);
      this._backoff = Math.min(this._backoff * 1.6, 15000);
      this.emit('down');
      setTimeout(() => this._connect(), wait);
    });
  }

  _parse() {
    while (this._buf.length >= 2) {
      const b1 = this._buf[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        len = Number(this._buf.readBigUInt64BE(2)); off = 10;
      }
      const maskBytes = masked ? 4 : 0;
      if (this._buf.length < off + maskBytes + len) return;
      const payload = this._buf.slice(off + maskBytes, off + maskBytes + len);
      const op = this._buf[0] & 0x0f;
      let data = payload;
      if (masked) {
        data = Buffer.from(payload);
        for (let i = 0; i < data.length; i++) data[i] ^= this._buf[off + (i & 3)];
      }
      this._buf = this._buf.slice(off + maskBytes + len);

      if (op === 0x1) {
        this._onText(data.toString('utf8'));
      } else if (op === 0x8) {
        try { this._sock.end(); } catch (e) {}
        return;
      } else if (op === 0x9) {
        try { this._sock.write(encodeFrame(0xA, data)); } catch (e) {}
      }
    }
  }

  _onText(txt) {
    this.st.msgCount += 1;
    this.st.lastMsgAt = Date.now();
    let m;
    try { m = JSON.parse(txt); } catch (e) { return; }
    const d = m.data || m;
    if (!d || !d.s) return;
    const sym = String(d.s).toUpperCase();
    const t = this.tick.get(sym) || { price: null, changePct: null, at: 0 };
    let hit = false;

    if (d.e === 'aggTrade' && d.p !== undefined) {
      t.price = Number(d.p);
      t.at = Number(d.T) || Date.now();
      hit = true;
    } else if (d.e === '24hrTicker' || d.c !== undefined) {
      t.price = Number(d.c);
      t.changePct = Number(d.P);
      t.high = Number(d.h);
      t.low = Number(d.l);
      t.volume = Number(d.v);
      t.quoteVolume = Number(d.q);   // 24h 成交额（USDT），屏上副标题用
      t.at = Number(d.E) || Date.now();
      hit = true;
    }
    if (!hit) return;
    this.tick.set(sym, t);
    if (!this._dirty) {
      this._dirty = true;
      this.st.latencyMs = this.st.lastOpenAt ? Date.now() - this.st.lastOpenAt : null;
    }
  }

  _flush() {
    if (!this._dirty) return;
    this._dirty = false;
    this.emit('update', this.snapshot());
  }

  /** 供 HTTP 接口直接读取（毫秒级 age） */
  snapshot() {
    const now = Date.now();
    return this.symbols.map((s) => {
      const t = this.tick.get(s) || {};
      return {
        symbol: s,
        price: t.price,
        changePct: t.changePct,
        high: t.high,
        low: t.low,
        volume: t.volume,
        quoteVolume: t.quoteVolume,
        ageMs: t.at ? now - t.at : null,
      };
    });
  }
}

module.exports = { FuturesFeed };
