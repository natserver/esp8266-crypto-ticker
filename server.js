'use strict';

/**
 * CryptoDash - 给桌面小盒子(ESP32 摆件)用的行情数据服务
 * 零第三方依赖，Node 18+ 即可运行，适合跑在路由器 Docker 里。
 *
 * 核心思路：
 *   1) 后台定时从多个行情源(OKX/Binance/Gate/MEXC/CoinGecko)抓数据并缓存；
 *   2) 对外提供多种"口味"的接口，尽可能兼容不同固件要的格式；
 *   3) 任何未知路径都会被记录下来(/probe 可看)，方便反推你盒子固件真正请求的地址和格式。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { FuturesFeed } = require('./binance_ws');

process.env.TZ = process.env.TZ || 'Asia/Shanghai';

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });
const REQ_LOG = path.join(DATA_DIR, 'requests.log');

const QUOTE_ASSETS = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USD', 'BTC', 'ETH', 'BNB'];

function parseSymbol(raw) {
  const s = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const q of QUOTE_ASSETS) {
    if (s.length > q.length && s.endsWith(q)) {
      return { sym: s, base: s.slice(0, -q.length), quote: q };
    }
  }
  // 只有裸币种名（BTC / DOGE / XAU）时自动补 USDT：
  // 盒子网页上填的、/api/symbols?set= 传过来的通常都是裸名，
  // 不补后缀会订阅出 "BTC@aggTrade" 这种不存在的流，拿不到任何数据。
  if (s.length <= 12) {
    return { sym: s + 'USDT', base: s, quote: 'USDT' };
  }
  return { sym: s, base: s, quote: 'USDT' };
}

function list(v, def) {
  const s = (v === undefined || v === null || v === '') ? def : v;
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}

const CFG = {
  symbols: list(process.env.SYMBOLS, 'BTCUSDT,ETHUSDT,ETCUSDT').map(parseSymbol),
  stocks: list(process.env.STOCKS, '').map((s) => s.toLowerCase()),
  providers: list(process.env.PROVIDERS, 'binancefutures,okxswap,binance,okx,gate,mexc,coingecko').map((s) => s.toLowerCase()),
  refreshMs: Math.max(3000, Number(process.env.REFRESH_MS) || 15000),
  timeoutMs: Math.max(1000, Number(process.env.UPSTREAM_TIMEOUT_MS) || 6000),
  tz: process.env.TZ,
  siteName: process.env.SITE_NAME || 'CryptoDash',
};

// ---------------------------------------------------------------- 上游接口配置
// 落盘到 data/config.json，重启后仍生效。
// 想换行情接口时，改这个文件（或访问 /admin 页面）即可，不用动代码。

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const FEED_DEF = {
  // 币安 U 本位合约 WebSocket 组合流地址
  wsUrl: 'wss://fstream.binancefuture.com/stream',
  // 订阅哪些流：aggTrade=逐笔成交(最快)  ticker=1 秒 24h 统计
  streams: 'aggTrade,ticker',
  // WS 不通时的 REST 兜底（批量 24h 行情）
  restUrl: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
  // 部分代理需要额外请求头，格式 "Key: Value|Key2: Value2"
  headers: '',
  // 盯盘币种（U 本位合约交易对）
  symbols: (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,ETCUSDT'),
  // 合并推送间隔（毫秒）：越小越实时，越大越省流量
  pushMs: 150,
  // REST 兜底轮询间隔（秒）
  restEverySec: 30,
  // 人民币汇率（USDT→CNY）。留空=自动联网获取；填 7.30 这类数字=手动锁定
  cnyRate: '',
  // ---- 屏幕显示选项（在 /admin 界面上勾选，改完立即下发到盒子）----
  // 是否显示人民币价
  showCny: true,
  // 是否显示 24h 成交额
  showVol: true,
  // 涨跌配色：green=绿涨红跌（币安默认）  red=红涨绿跌（A 股习惯）
  colorMode: 'green',
  // 屏幕最多显示几行（盒子固件最多 4 行，240px 高再多就挤了）
  maxRows: 4,
  // 屏幕字号：0=小 1=中 2=大 3=特大（主=币种名/涨跌幅，次=价格/人民币）
  fontBig: 1,
  fontSmall: 1,
  // 屏幕设备的 IP：从它自己来取数的请求里自动认出来，也能手动改
  boxIp: '',
};

/** 布尔值容错：表单传上来的是 "true"/"on"/"1" */
function toBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return /^(1|true|on|yes|y|是)$/i.test(String(v).trim());
}

let FEEDCFG = Object.assign({}, FEED_DEF);

function loadFeedCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    FEEDCFG = Object.assign({}, FEED_DEF, j);
  } catch (e) { /* 首次运行没有配置文件，用默认值 */ }
  if (FEEDCFG.symbols) {
    const arr = list(FEEDCFG.symbols, '').map((s) => s.toUpperCase());
    if (arr.length) CFG.symbols = arr.map(parseSymbol);
  }
  normalizeFeedCfg();
  return FEEDCFG;
}

/** 配置项类型统一（json 手工改过 / 表单传上来是字符串，都要收敛成干净的值） */
function normalizeFeedCfg() {
  FEEDCFG.showCny = toBool(FEEDCFG.showCny, true);
  FEEDCFG.showVol = toBool(FEEDCFG.showVol, true);
  FEEDCFG.colorMode = String(FEEDCFG.colorMode || 'green').toLowerCase() === 'red' ? 'red' : 'green';
  const mr = Number(FEEDCFG.maxRows);
  FEEDCFG.maxRows = Number.isFinite(mr) ? Math.max(1, Math.min(4, Math.round(mr))) : 4;
  const fb = Number(FEEDCFG.fontBig);
  FEEDCFG.fontBig = Number.isFinite(fb) ? Math.max(0, Math.min(3, Math.round(fb))) : 1;
  const fs2 = Number(FEEDCFG.fontSmall);
  FEEDCFG.fontSmall = Number.isFinite(fs2) ? Math.max(0, Math.min(3, Math.round(fs2))) : 1;
  FEEDCFG.boxIp = String(FEEDCFG.boxIp || '').trim();
  const pm = Number(FEEDCFG.pushMs);
  FEEDCFG.pushMs = Number.isFinite(pm) ? Math.max(50, Math.min(3000, Math.round(pm))) : 150;
  return FEEDCFG;
}

function saveFeedCfg(patch) {
  FEEDCFG = Object.assign({}, FEEDCFG, patch);
  normalizeFeedCfg();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(FEEDCFG, null, 2));
  } catch (e) { console.error('写配置失败', e.message); }
  return FEEDCFG;
}

function parseHeaders(s) {
  const out = {};
  String(s || '').split('|').forEach((kv) => {
    const i = kv.indexOf(':');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return out;
}

loadFeedCfg();

// ---------------------------------------------------------------- HTTP 工具

async function getJson(url, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CFG.timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: Object.assign({ 'User-Agent': 'CryptoDash/1.0' }, headers || {}),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- 汇率（USDT → CNY）
// 屏幕要显示人民币价格，这里维护一个汇率：
//   1) /admin 里填了固定数字 → 直接用（想手动锁死就填）
//   2) 否则每 10 分钟联网取一次，多个源依次尝试
// 取不到就沿用上一次的值，绝不因为汇率把行情搞挂。

const RATE_TTL_MS = 10 * 60 * 1000;
const RATE_FALLBACK = 7.1;
const rate = { usdtCny: RATE_FALLBACK, at: 0, src: 'default', error: '' };

const RATE_SOURCES = [
  { name: 'er-api', url: 'https://open.er-api.com/v6/latest/USD', pick: (j) => j && j.rates && j.rates.CNY },
  { name: 'frankfurter', url: 'https://api.frankfurter.app/latest?from=USD&to=CNY', pick: (j) => j && j.rates && j.rates.CNY },
  { name: 'exchangerate.host', url: 'https://api.exchangerate.host/latest?base=USD&symbols=CNY', pick: (j) => j && j.rates && j.rates.CNY },
];

async function refreshCnyRate(force) {
  // 手动锁定优先
  const manual = Number(FEEDCFG.cnyRate);
  if (Number.isFinite(manual) && manual > 1 && manual < 20 && String(FEEDCFG.cnyRate).trim() !== '') {
    rate.usdtCny = manual; rate.at = Date.now(); rate.src = 'manual'; rate.error = '';
    return rate;
  }
  if (!force && rate.at && rate.src !== 'default' && Date.now() - rate.at < RATE_TTL_MS) return rate;
  rate.error = '';
  for (const s of RATE_SOURCES) {
    try {
      const v = Number(s.pick(await getJson(s.url)));
      if (Number.isFinite(v) && v > 1 && v < 20) {
        rate.usdtCny = v; rate.at = Date.now(); rate.src = s.name; rate.error = '';
        console.log('[rate] USDT/CNY = ' + v + ' (' + s.name + ')');
        return rate;
      }
    } catch (e) {
      rate.error = s.name + ': ' + String((e && e.message) || e);
    }
  }
  if (!rate.at) { rate.usdtCny = RATE_FALLBACK; rate.at = Date.now(); rate.src = 'default'; }
  return rate;
}

// 人民币价格格式化：大数四舍五入到元并加千分位，小币值保留小数
function fmtCny(v) {
  if (!Number.isFinite(v)) return '-';
  let s;
  if (v >= 1000) s = v.toFixed(0);
  else if (v >= 1) s = v.toFixed(2);
  else if (v >= 0.01) s = v.toFixed(4);
  else s = v.toFixed(6);
  const parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

function mkQuote(sym, price, changePct, extra) {
  const e = extra || {};
  const p = num(price);
  const c = num(changePct);
  return {
    symbol: sym,
    label: sym,
    price: p,
    changePct: c,
    high: num(e.high),
    low: num(e.low),
    volume: num(e.volume),
    quoteVolume: num(e.quoteVolume),
    market: e.market || 'spot',
    ts: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------- 行情源

const PROVIDERS = {
  // 币安 U 本位合约（永续）—— 用户指定主源
  async binancefutures(syms) {
    const rows = await Promise.all(syms.map(async (s) => {
      try {
        const j = await getJson('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=' + s.sym);
        if (!j || !j.symbol || j.lastPrice === undefined) return null;
        return mkQuote(s.sym, j.lastPrice, j.priceChangePercent, {
          high: j.highPrice, low: j.lowPrice, volume: j.volume, market: 'futures',
        });
      } catch (e) { return null; }
    }));
    return rows.filter(Boolean);
  },

  // OKX 永续（SWAP）—— 合约价备用源
  async okxswap(syms) {
    const j = await getJson('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
    const rows = (j && j.data) || [];
    const idx = new Map(rows.map((r) => [String(r.instId).toUpperCase(), r]));
    const out = [];
    for (const s of syms) {
      const r = idx.get(s.base + '-' + s.quote + '-SWAP');
      if (!r) continue;
      const last = num(r.last);
      const open = num(r.open24h);
      out.push(mkQuote(s.sym, last, open && last ? ((last - open) / open) * 100 : null, {
        high: r.high24h, low: r.low24h, volume: r.vol24h, market: 'futures',
      }));
    }
    return out;
  },

  // OKX 现货
  async okx(syms) {
    const j = await getJson('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
    const rows = (j && j.data) || [];
    const idx = new Map(rows.map((r) => [String(r.instId).replace('-', '').toUpperCase(), r]));
    const out = [];
    for (const s of syms) {
      const r = idx.get(s.sym);
      if (!r) continue;
      const last = num(r.last);
      const open = num(r.open24h);
      out.push(mkQuote(s.sym, last, open && last ? ((last - open) / open) * 100 : null, {
        high: r.high24h, low: r.low24h, volume: r.vol24h,
      }));
    }
    return out;
  },

  // Binance 现货
  async binance(syms) {
    const q = encodeURIComponent(JSON.stringify(syms.map((s) => s.sym)));
    const j = await getJson('https://api.binance.com/api/v3/ticker/24hr?symbols=' + q);
    const rows = Array.isArray(j) ? j : [j];
    return rows
      .filter((r) => r && r.symbol)
      .map((r) => mkQuote(r.symbol, r.lastPrice, r.priceChangePercent, {
        high: r.highPrice, low: r.lowPrice, volume: r.volume,
      }));
  },

  // Gate.io 现货
  async gate(syms) {
    const out = [];
    for (const s of syms) {
      try {
        const pair = s.base + '_' + s.quote;
        const j = await getJson('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=' + pair);
        const r = Array.isArray(j) ? j[0] : null;
        if (!r) continue;
        const last = num(r.last);
        const open = num(r.change_percentage) !== null && last ? last / (1 + num(r.change_percentage) / 100) : null;
        out.push(mkQuote(s.sym, last, r.change_percentage, {
          high: r.high_24h, low: r.low_24h, volume: r.base_volume,
        }));
      } catch (e) { /* 单个失败忽略 */ }
    }
    return out;
  },

  // MEXC 现货
  async mexc(syms) {
    const q = encodeURIComponent(JSON.stringify(syms.map((s) => s.sym)));
    const j = await getJson('https://api.mexc.com/api/v3/ticker/24hr?symbols=' + q);
    const rows = Array.isArray(j) ? j : [j];
    return rows
      .filter((r) => r && r.symbol)
      .map((r) => mkQuote(r.symbol, r.lastPrice, r.priceChangePercent, {
        high: r.highPrice, low: r.lowPrice, volume: r.volume,
      }));
  },

  // CoinGecko（按币种名查，适合做兜底）
  async coingecko(syms) {
    const map = {
      BTC: 'bitcoin', ETH: 'ethereum', ETC: 'ethereum-classic', SOL: 'solana',
      DOGE: 'dogecoin', BNB: 'binancecoin', XRP: 'ripple', ADA: 'cardano',
      TRX: 'tron', LTC: 'litecoin', BCH: 'bitcoin-cash', DOT: 'polkadot',
    };
    const bases = syms.map((s) => s.base).filter((b) => map[b]);
    if (!bases.length) return [];
    const ids = [...new Set(bases.map((b) => map[b]))].join(',');
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids +
      '&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true';
    const j = await getJson(url);
    const out = [];
    for (const s of syms) {
      const id = map[s.base];
      const row = id && j[id];
      if (!row) continue;
      out.push(mkQuote(s.sym, row.usd, row.usd_24h_change, {}));
    }
    return out;
  },
};

// ---------------------------------------------------------------- 股票(可选)

async function fetchStocks() {
  if (!CFG.stocks.length) return { source: '', items: [] };
  try {
    const url = 'https://qt.gtimg.cn/q=' + CFG.stocks.join(',');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CFG.timeoutMs);
    let buf;
    try {
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      buf = Buffer.from(await r.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    let text;
    try { text = new TextDecoder('gbk').decode(buf); } catch (e) { text = buf.toString('utf8'); }
    const items = [];
    for (const line of text.split(';')) {
      const m = line.match(/v_([a-z]{2}\d{6})="([^"]*)"/);
      if (!m) continue;
      const f = m[2].split('~');
      if (f.length < 6) continue;
      const now = num(f[3]);
      const prev = num(f[4]);
      items.push({
        code: m[1],
        name: f[1],
        price: now,
        prevClose: prev,
        open: num(f[5]),
        changePct: (now !== null && prev) ? ((now - prev) / prev) * 100 : null,
        ts: Math.floor(Date.now() / 1000),
      });
    }
    return { source: 'tencent', items };
  } catch (e) {
    return { source: 'tencent', items: [], error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- 缓存与刷新

const state = {
  quotes: [],
  stocks: [],
  cryptoSource: '',
  market: '',
  stockSource: '',
  updatedAt: 0,
  lastError: '',
  providerStatus: {},
  refreshCount: 0,
  boxIp: '',
  boxSeenAt: 0,
};

let refreshing = null;

function mergeQuotes(oldList, newList) {
  const map = new Map();
  const now = Math.floor(Date.now() / 1000);
  for (const q of oldList) {
    if (q && q.ts && now - q.ts < 300) map.set(q.symbol, q);
  }
  for (const q of newList) map.set(q.symbol, Object.assign({}, q, { ts: now }));
  const order = CFG.symbols.map((s) => s.sym);
  return [...map.values()]
    .filter((q) => order.indexOf(q.symbol) >= 0)
    .sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol));
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const errs = [];
    let got = [];
    let source = '';
    for (const p of CFG.providers) {
      const fn = PROVIDERS[p];
      if (!fn) { errs.push(p + ': unknown'); continue; }
      try {
        const qs = await fn(CFG.symbols);
        if (qs && qs.length) {
          got = qs; source = p;
          state.providerStatus[p] = { ok: true, count: qs.length, at: Math.floor(Date.now() / 1000) };
          break;
        }
        state.providerStatus[p] = { ok: false, error: 'empty result', at: Math.floor(Date.now() / 1000) };
        errs.push(p + ': empty');
      } catch (e) {
        const msg = String((e && e.message) || e);
        state.providerStatus[p] = { ok: false, error: msg, at: Math.floor(Date.now() / 1000) };
        errs.push(p + ': ' + msg);
      }
    }
    if (got.length) {
      state.quotes = mergeQuotes(state.quotes, got);
      state.cryptoSource = source;
      state.market = got[0].market || 'spot';
      state.updatedAt = Math.floor(Date.now() / 1000);
      state.lastError = '';
    } else if (errs.length) {
      state.lastError = errs.join(' | ');
    }

    const st = await fetchStocks();
    if (st.items && st.items.length) {
      state.stocks = st.items;
      state.stockSource = st.source;
    } else if (st.error) {
      state.lastError = (state.lastError ? state.lastError + ' | ' : '') + 'stocks: ' + st.error;
    }

    state.refreshCount += 1;
    return state;
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

// ---------------------------------------------------------------- 实时推送通道

// SSE 客户端集合（盒子长连接就挂在这里）
const sseClients = new Set();
let feed = null;
const feedStats = { updates: 0, lastPushAt: 0, connectedAt: 0 };

/** 把 WebSocket 快照写进 state.quotes，让所有老接口自动受益 */
function applyFeedSnapshot(snap) {
  const got = [];
  for (const r of snap) {
    if (!Number.isFinite(r.price)) continue;
    got.push({
      symbol: r.symbol,
      label: r.symbol,
      price: r.price,
      changePct: r.changePct,
      high: r.high,
      low: r.low,
      volume: r.volume,
      quoteVolume: r.quoteVolume,
      market: 'futures',
      ts: Math.floor(Date.now() / 1000),
      ageMs: r.ageMs,
    });
  }
  if (!got.length) return;
  state.quotes = mergeQuotes(state.quotes, got);
  state.cryptoSource = 'binance-futures-ws';
  state.market = 'futures';
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.lastError = '';
  state.refreshCount += 1;
  feedStats.updates += 1;
  feedStats.lastPushAt = Date.now();
}

/** SSE 单条消息体（字段名压到最短，ESP8266 解析省内存） */
function sseBody() {
  const t = timeInfo();
  const rows = screenRows();
  const age = state.quotes.length
    ? Math.max(0, Math.min(...state.quotes.map((q) => (Number.isFinite(q.ageMs) ? q.ageMs : 9999))))
    : null;
  return JSON.stringify({
    t: t.time, s: state.cryptoSource, r: Math.round(rate.usdtCny * 100) / 100, a: age,
    fb: FEEDCFG.fontBig, fs: FEEDCFG.fontSmall,
    d: rows,
  });
}

function sseBroadcast() {
  if (!sseClients.size) return;
  const line = 'data: ' + sseBody() + '\n\n';
  for (const c of sseClients) {
    try { c.write(line); } catch (e) { sseClients.delete(c); }
  }
}

// 心跳：15 秒一次注释行，防止路由器/NAT 把空闲连接踢掉
setInterval(() => {
  for (const c of sseClients) {
    try { c.write(': hb\n\n'); } catch (e) { sseClients.delete(c); }
  }
}, 15000).unref();

function startFeed() {
  if (feed) { try { feed.stop(); } catch (e) {} feed = null; }
  if (!FEEDCFG.wsUrl) return null;
  feed = new FuturesFeed({
    wsUrl: FEEDCFG.wsUrl,
    streams: list(FEEDCFG.streams, 'aggTrade,ticker'),
    symbols: CFG.symbols.map((s) => s.sym),
    pushMs: Number(FEEDCFG.pushMs) || 150,
    headers: parseHeaders(FEEDCFG.headers),
  });
  feed.on('update', (snap) => {
    applyFeedSnapshot(snap);
    sseBroadcast();
  });
  feed.on('open', () => {
    feedStats.connectedAt = Date.now();
    console.log('[feed] 币安合约 WebSocket 已连接: ' + CFG.symbols.map((s) => s.sym).join(','));
  });
  feed.on('down', () => console.log('[feed] WebSocket 断开，自动重连中…'));
  feed.start();
  return feed;
}

// REST 兜底：WS 没数据时用 24h 行情补上，保证永远不会停在旧价
// 币安的批量 symbols 参数不可靠（会被忽略并返回全量），这里按币种并发单查，每个仅 ~370 字节
async function restFallback() {
  if (!FEEDCFG.restUrl) return;
  const fresh = feed && feed.st.connected && feed.st.lastMsgAt &&
    (Date.now() - feed.st.lastMsgAt < 20000);
  if (fresh) return;
  try {
    const hdr = parseHeaders(FEEDCFG.headers);
    const base = FEEDCFG.restUrl;
    const got = (await Promise.all(CFG.symbols.map(async (s) => {
      try {
        const j = await getJson(base + (base.includes('?') ? '&' : '?') + 'symbol=' + s.sym, hdr);
        if (!j || j.lastPrice === undefined) return null;
        return mkQuote(String(j.symbol || s.sym).toUpperCase(), j.lastPrice, j.priceChangePercent, {
          high: j.highPrice, low: j.lowPrice, volume: j.volume, quoteVolume: j.quoteVolume, market: 'futures',
        });
      } catch (e) { return null; }
    }))).filter(Boolean);
    if (got.length) {
      state.quotes = mergeQuotes(state.quotes, got);
      state.cryptoSource = 'binance-futures-rest';
      state.market = 'futures';
      state.updatedAt = Math.floor(Date.now() / 1000);
      sseBroadcast();
    }
  } catch (e) {
    state.lastError = 'rest fallback: ' + String((e && e.message) || e);
  }
}

// ---------------------------------------------------------------- 视图数据

function fmtPrice(p) {
  if (p === null || p === undefined) return '-';
  const n = Number(p);
  if (!Number.isFinite(n)) return '-';
  let s;
  if (n >= 10000) s = n.toFixed(1);
  else if (n >= 1) s = n.toFixed(2);
  else if (n >= 0.01) s = n.toFixed(4);
  else s = n.toFixed(6);
  // 千分位：屏上 80,662.4 比 80662.4 好读（参考币安 App 的做法）
  const parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

/** 24h 成交额，换算成「亿」的短数字（中文「亿」由固件用点阵字模补上） */
function fmtVol(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const y = n / 1e8;
  if (y >= 100) return y.toFixed(0);
  if (y >= 10) return y.toFixed(1);
  return y.toFixed(2);
}

/** 单行最小字段（字段名压到最短，ESP8266 解析省内存）
 *  u = 涨跌方向（1 涨 / 0 平 / -1 跌）
 *  k = 显示颜色（1 红 / -1 绿），已经按「绿涨红跌 / 红涨绿跌」换算好，
 *      盒子直接照这个上色，配色开关就不用再动固件了 */
function rowView(x) {
  const up = x.up;
  const col = FEEDCFG.colorMode === 'red'
    ? (up === true ? -1 : up === false ? 1 : 0)      // 红涨绿跌
    : (up === true ? 1 : up === false ? -1 : 0);     // 绿涨红跌
  return {
    l: x.label || x.symbol,
    p: x.priceText,
    y: x.cnyText,
    v: x.volText || '',
    c: x.changeText,
    u: up === true ? 1 : up === false ? -1 : 0,
    k: col,
  };
}

/** 屏幕上要显示的行（受「最多显示几行」限制） */
function screenRows() {
  return itemsView().slice(0, FEEDCFG.maxRows).map(rowView);
}

function itemsView() {
  const out = [];
  for (const q of state.quotes) {
    const s = parseSymbol(q.symbol);
    const c = q.changePct;
    const cny = Number.isFinite(q.price) ? q.price * rate.usdtCny : null;
    out.push({
      symbol: q.symbol,
      label: s.base + '/' + s.quote,
      base: s.base,
      quote: s.quote,
      price: q.price,
      priceText: fmtPrice(q.price),
      volText: FEEDCFG.showVol ? fmtVol(q.quoteVolume) : '',
      cny: cny,
      cnyText: FEEDCFG.showCny ? fmtCny(cny) : '',
      cnyRate: rate.usdtCny,
      change: c,
      changePct: c,
      changeText: (c === null || c === undefined) ? '-' : (c >= 0 ? '+' : '') + Number(c).toFixed(2) + '%',
      up: c === null || c === undefined ? null : c >= 0,
      high: q.high,
      low: q.low,
      volume: q.volume,
      market: q.market || 'spot',
    });
  }
  for (const s of state.stocks) {
    const c = s.changePct;
    out.push({
      symbol: s.code,
      label: s.name,
      base: s.code,
      quote: 'CNY',
      price: s.price,
      priceText: fmtPrice(s.price),
      cny: s.price,
      cnyText: fmtCny(s.price),
      change: c,
      changePct: c,
      changeText: (c === null || c === undefined) ? '-' : (c >= 0 ? '+' : '') + Number(c).toFixed(2) + '%',
      up: c === null || c === undefined ? null : c >= 0,
      kind: 'stock',
    });
  }
  return out;
}

function timeInfo() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CFG.tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return {
    ts: Math.floor(d.getTime() / 1000),
    time: parts.hour + ':' + parts.minute + ':' + parts.second,
    date: parts.year + '-' + parts.month + '-' + parts.day,
    weekday: d.getDay(),
    tz: CFG.tz,
    pad,
  };
}

function flatQuotes() {
  const out = {};
  for (const it of itemsView()) {
    const key = String(it.base).toLowerCase();
    out[key + '_price'] = it.price;
    out[key + '_change'] = it.changePct;
  }
  return out;
}

function kitchenSink() {
  const items = itemsView();
  const t = timeInfo();
  const bySymbol = {};
  for (const it of items) bySymbol[it.symbol] = it;
  return Object.assign(
    {
      code: 0,
      status: 'ok',
      success: true,
      msg: 'ok',
      message: 'ok',
      ts: t.ts,
      time: t.time,
      date: t.date,
      updated: state.updatedAt,
      source: state.cryptoSource || 'none',
    },
    flatQuotes(),
    {
      items,
      quotes: items,
      data: items,
      list: items,
      ticker: bySymbol,
      result: { items, quotes: items, list: items, data: items },
    }
  );
}

// ---------------------------------------------------------------- 请求记录

const reqLog = [];

function logRequest(req, url, body) {
  const entry = {
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: url.search,
    ua: req.headers['user-agent'] || '',
    host: req.headers.host || '',
    ip: req.socket.remoteAddress || '',
    accept: req.headers.accept || '',
    body: body || '',
  };
  reqLog.push(entry);
  if (reqLog.length > 300) reqLog.shift();
  try {
    const line = JSON.stringify(entry) + '\n';
    if (fs.existsSync(REQ_LOG) && fs.statSync(REQ_LOG).size > 2 * 1024 * 1024) {
      fs.writeFileSync(REQ_LOG, '');
    }
    fs.appendFileSync(REQ_LOG, line);
  } catch (e) { /* 忽略写日志失败 */ }
}

// ---------------------------------------------------------------- 响应工具

/** 把「屏幕设备」的 IP 记下来：ESP 的请求没有 UA 或 UA 带 ESP8266；
 *  浏览器/脚本一律带 UA，靠这个区分，避免把自己当成盒子 */
function noteBox(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (ua && !/esp8266|esp32|arduino/i.test(ua)) return;
  let ip = (req.socket && req.socket.remoteAddress) || '';
  ip = ip.replace(/^::ffff:/, '');
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return;
  if (state.boxIp !== ip || Date.now() - (state.boxSeenAt || 0) > 5000) {
    state.boxIp = ip;
    state.boxSeenAt = Date.now();
    if (FEEDCFG.boxIp !== ip) saveFeedCfg({ boxIp: ip });
  } else {
    state.boxSeenAt = Date.now();
  }
}

/** 让盒子改连别的行情服务：盒子固件 final13 起支持 GET /setapi?api=host:port */
function pushBoxApi(ip, api, timeoutMs) {
  return new Promise((resolve) => {
    const host = String(ip || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
    const addr = String(api || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
    if (!/^[\w.-]+(:\d+)?$/.test(host)) return resolve({ ok: false, error: '盒子 IP 不合法' });
    if (!/^[\w.-]+:\d+$/.test(addr)) return resolve({ ok: false, error: '地址要写成 host:port，如 192.168.100.2:8095' });
    const url = 'http://' + host + '/setapi?api=' + encodeURIComponent(addr);
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const req = http.get(url, { timeout: timeoutMs || 4000 }, (r) => {
      let buf = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { buf += c; });
      r.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (e) { /* 老固件返回 HTML */ }
        if (j && j.ok) return finish({ ok: true, api: j.api || addr });
        if (j && j.error) return finish({ ok: false, error: j.error });
        finish({ ok: false, error: '盒子返回 ' + r.statusCode + '（固件可能太旧，需要 final13 以上）' });
      });
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false, error: '盒子没响应（IP 对吗？盒子在线吗？）' }); });
    req.on('error', (e) => finish({ ok: false, error: '连不上盒子：' + e.message }));
  });
}

/** 读盒子 /status，拿它现在连的地址和在线状态 */
function probeBox(ip, timeoutMs) {
  return new Promise((resolve) => {
    const host = String(ip || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
    if (!/^[\w.-]+(:\d+)?$/.test(host)) return resolve({ online: false });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const req = http.get('http://' + host + '/status', { timeout: timeoutMs || 1500 }, (r) => {
      let buf = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { buf += c; });
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          finish({ online: true, ip: j.ip || host, api: j.api || '', rows: j.rows, sse: j.sse, heap: j.heap, syms: j.syms });
        } catch (e) { finish({ online: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); finish({ online: false }); });
    req.on('error', () => finish({ online: false }));
  });
}

function sendJson(res, obj, status) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, html, status) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status || 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, file, status) {
  try {
    const body = fs.readFileSync(file);
    res.writeHead(status || 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    sendHtml(res, '<h1>404</h1>', 404);
  }
}

// 兼容 Binance 风格的 ticker 输出（字段全是字符串，和官方一致）
function binanceTicker(single) {
  const make = (q) => {
    const s = parseSymbol(q.symbol);
    return {
      symbol: q.symbol,
      priceChange: q.changePct === null ? '0' : String(((q.price || 0) * q.changePct / 100).toFixed(4)),
      priceChangePercent: q.changePct === null ? '0' : String(Number(q.changePct).toFixed(3)),
      lastPrice: String(q.price),
      highPrice: q.high === null ? '0' : String(q.high),
      lowPrice: q.low === null ? '0' : String(q.low),
      volume: q.volume === null ? '0' : String(q.volume),
      quoteVolume: '0',
      openPrice: q.changePct === null ? String(q.price) : String((q.price / (1 + q.changePct / 100)).toFixed(4)),
      prevClosePrice: '0',
      closeTime: Date.now(),
      openTime: Date.now() - 86400000,
      base: s.base,
      quote: s.quote,
    };
  };
  if (single) {
    const q = state.quotes.find((x) => x.symbol === single);
    return q ? make(q) : { code: -1121, msg: 'Invalid symbol.' };
  }
  return state.quotes.map(make);
}

// 兼容 OKX 风格的 tickers 输出
function okxTicker() {
  return {
    code: '0',
    msg: '',
    data: state.quotes.map((q) => {
      const s = parseSymbol(q.symbol);
      const open = (q.changePct === null || !q.price) ? q.price : q.price / (1 + q.changePct / 100);
      return {
        instType: 'SPOT',
        instId: s.base + '-' + s.quote,
        last: String(q.price),
        open24h: String(Number(open).toFixed(8)),
        high24h: String(q.high === null ? q.price : q.high),
        low24h: String(q.low === null ? q.price : q.low),
        vol24h: String(q.volume === null ? 0 : q.volume),
        ts: String(Date.now()),
      };
    }),
  };
}

function probePage() {
  const rows = reqLog.slice().reverse().map((e) => {
    return '<tr><td>' + esc(e.at) + '</td><td><b>' + esc(e.method) + '</b></td><td class="p">' +
      esc(e.path + e.query) + '</td><td>' + esc(e.ip) + '</td><td>' + esc(e.ua.slice(0, 80)) +
      '</td><td>' + esc(e.host) + '</td></tr>';
  }).join('');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>设备请求探测 - ' + esc(CFG.siteName) + '</title><style>' +
    'body{margin:0;padding:20px;font:14px/1.6 -apple-system,"Segoe UI",sans-serif;background:#f7f8fa;color:#1f2328}' +
    'h1{font-size:18px;margin:0 0 4px}p.hint{color:#6b7280;margin:0 0 16px;font-size:13px}' +
    'table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}' +
    'th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #f0f1f3;font-size:13px;vertical-align:top}' +
    'th{background:#fafbfc;font-weight:600;color:#4b5563}td.p{font-family:ui-monospace,Consolas,monospace;word-break:break-all}' +
    'code{background:#f3f4f6;padding:1px 5px;border-radius:4px}' +
    '</style></head><body><h1>设备请求探测</h1>' +
    '<p class="hint">共记录 ' + reqLog.length + ' 条。把你盒子的请求指到本机后，刷新这里看它请求了什么路径。<br>' +
    '程序会自动回应一份"万能 JSON"，如果盒子能显示说明接口对上了；如果还白屏，把这张表截图给我，我按真实路径改。</p>' +
    '<table><thead><tr><th>时间</th><th>方法</th><th>路径</th><th>来源 IP</th><th>User-Agent</th><th>Host</th></tr></thead>' +
    '<tbody>' + (rows || '<tr><td colspan="6" style="color:#9ca3af">还没有请求</td></tr>') + '</tbody></table>' +
    '</body></html>';
}

function esc(s) {
  return String(s === undefined ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function configView() {
  const now = Date.now();
  return {
    ok: true,
    configFile: CONFIG_FILE,
    upstream: FEEDCFG,
    symbols: CFG.symbols.map((s) => s.sym),
    feed: feed ? {
      connected: feed.st.connected,
      mode: feed.st.mode,
      msgs: feed.st.msgCount,
      lastMsgAgoMs: feed.st.lastMsgAt ? now - feed.st.lastMsgAt : null,
      reconnects: feed.st.reconnects,
      lastError: feed.st.lastError,
      ticks: feed.snapshot(),
    } : null,
    sseClients: sseClients.size,
    updates: feedStats.updates,
    rate: {
      usdtCny: rate.usdtCny,
      source: rate.src,
      at: rate.at ? new Date(rate.at).toISOString() : null,
      manual: String(FEEDCFG.cnyRate || '').trim() !== '',
      error: rate.error || null,
    },
    rows: itemsView().slice(0, 8).map((x) => ({ l: x.label, p: x.priceText, y: x.cnyText, c: x.changeText })),
  };
}

// ---------------------------------------------------------------- 后台设置页
// 常用币种：给「添加」下拉和预览里的圆形图标配色用
const SYM_PRESETS = [
  ['BTC', 'Bitcoin', '#F7931A'], ['ETH', 'Ethereum', '#627EEA'], ['BNB', 'BNB', '#F3BA2F'],
  ['SOL', 'Solana', '#14F195'], ['XRP', 'XRP', '#23292F'], ['DOGE', 'Dogecoin', '#C2A633'],
  ['ADA', 'Cardano', '#0033AD'], ['TRX', 'TRON', '#E50915'], ['LINK', 'Chainlink', '#2A5ADA'],
  ['LTC', 'Litecoin', '#345D9D'], ['ETC', 'Ethereum Classic', '#328332'], ['BCH', 'Bitcoin Cash', '#8DC351'],
  ['AVAX', 'Avalanche', '#E84142'], ['DOT', 'Polkadot', '#E6007A'], ['TON', 'Toncoin', '#0098EA'],
  ['SUI', 'Sui', '#4DA2FF'], ['PEPE', 'Pepe', '#3D8130'], ['SHIB', 'Shiba Inu', '#F00500'],
  ['NEAR', 'NEAR', '#00C1DE'], ['APT', 'Aptos', '#2C2C2C'], ['ARB', 'Arbitrum', '#12AAFF'],
  ['OP', 'Optimism', '#FF0420'], ['FIL', 'Filecoin', '#0090FF'], ['UNI', 'Uniswap', '#FF007A'],
  ['XAU', 'Gold', '#D4A73A'], ['XAG', 'Silver', '#A9ADB3'],
];

function adminPage() {
  const f = FEEDCFG;
  const online = !!(feed && feed.st.connected);
  const init = {
    cfg: {
      symbols: CFG.symbols.map((s) => s.base),
      showCny: f.showCny,
      showVol: f.showVol,
      colorMode: f.colorMode,
      maxRows: f.maxRows,
      fontBig: f.fontBig,
      fontSmall: f.fontSmall,
      pushMs: f.pushMs,
      cnyRate: String(f.cnyRate || ''),
      autoRate: rate.usdtCny,
      wsUrl: f.wsUrl,
      restUrl: f.restUrl,
      streams: f.streams,
      headers: f.headers,
    },
    presets: SYM_PRESETS,
    status: { online, sse: sseClients.size, msgs: feed ? feed.st.msgCount : 0, lag: rate.src },
  };
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>后台设置 - CryptoDash</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:18px 18px 96px;background:#0b0e11;color:#eaecef;
  font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1060px;margin:0 auto}
h1{font-size:18px;margin:0 0 3px;letter-spacing:.2px}
.sub{color:#848e9c;font-size:12px;margin-bottom:14px}
.top{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
  background:#161a1e;font-size:12px;color:#b7bdc6;border:1px solid #2b3139}
.dot{width:7px;height:7px;border-radius:50%;flex:none}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 292px;gap:16px;align-items:start}
@media(max-width:860px){.grid{grid-template-columns:1fr}}
.card{background:#161a1e;border:1px solid #2b3139;border-radius:12px;padding:14px 16px;margin-bottom:14px}
.card h2{font-size:13px;margin:0 0 10px;display:flex;align-items:center;gap:8px;font-weight:600}
.card h2 i{font-style:normal;font-weight:400;font-size:12px;color:#848e9c}
.note{font-size:12px;color:#6b7480;margin-top:8px;line-height:1.5}
.note code{background:#0d1117;border:1px solid #2b3139;color:#b7bdc6;padding:2px 6px;
  border-radius:5px;font:12px Consolas,monospace;word-break:break-all}
.symlist{display:flex;flex-direction:column;gap:7px}
.symrow{display:flex;align-items:center;gap:10px;background:#0d1117;border:1px solid #262c33;
  border-radius:9px;padding:7px 9px}
.coin{width:26px;height:26px;border-radius:50%;flex:none;display:flex;align-items:center;
  justify-content:center;font-weight:700;font-size:13px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.35)}
.sinfo{flex:1;min-width:0;line-height:1.25}
.sinfo b{font-size:13px;letter-spacing:.4px}
.sinfo em{display:block;font-style:normal;font-size:11px;color:#6b7480}
.symrow button{background:#1e2329;border:1px solid #2b3139;color:#b7bdc6;width:26px;height:26px;
  border-radius:6px;cursor:pointer;font-size:12px;line-height:1;padding:0}
.symrow button:hover{border-color:#474f58;color:#fff}
.symrow button.rm:hover{border-color:#f6465d;color:#f6465d}
.addbar{display:flex;gap:8px;margin-top:10px}
.addbar input{flex:1}
input,select{background:#0d1117;border:1px solid #2b3139;color:#eaecef;padding:8px 10px;
  border-radius:7px;font:13px/1.4 Consolas,monospace;width:100%}
input:focus,select:focus{outline:none;border-color:#3f7bd8}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.chip{background:#1e2329;border:1px solid #2b3139;color:#b7bdc6;border-radius:999px;
  padding:3px 10px;font-size:12px;cursor:pointer;font-family:Consolas,monospace}
.chip:hover{border-color:#3f7bd8;color:#fff}
.switch{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;
  border-bottom:1px solid #1e2329}
.switch:last-of-type{border-bottom:0}
.switch span{font-size:13px}
.switch small{display:block;color:#6b7480;font-size:11.5px;line-height:1.4}
.tg{position:relative;width:42px;height:23px;flex:none}
.tg input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.tg i{position:absolute;inset:0;background:#2b3139;border-radius:999px;transition:.15s}
.tg i:after{content:"";position:absolute;width:17px;height:17px;border-radius:50%;background:#848e9c;
  top:3px;left:3px;transition:.15s}
.tg input:checked + i{background:#2ebd85}
.tg input:checked + i:after{transform:translateX(19px);background:#fff}
.seg{display:flex;gap:0;border:1px solid #2b3139;border-radius:8px;overflow:hidden;flex:none}
.seg button{background:#0d1117;border:0;color:#b7bdc6;padding:6px 11px;font-size:12px;cursor:pointer}
.seg button.on{background:#2ebd85;color:#08110d;font-weight:600}
.seg button.on.red{background:#f6465d;color:#fff}
input[type=range]{padding:0;border:0;background:transparent;accent-color:#2ebd85}
.val{font-family:Consolas,monospace;color:#2ebd85;font-size:13px}
details summary{cursor:pointer;font-size:13px;color:#b7bdc6;outline:none}
details[open] summary{margin-bottom:10px}
.lbl{font-size:12px;color:#848e9c;margin:10px 0 5px}
.phone{background:#161a1e;border:1px solid #2b3139;border-radius:14px;padding:12px;position:sticky;top:14px}
#cv{display:block;width:240px;height:240px;border-radius:8px;background:#000;margin:0 auto;
  box-shadow:0 0 0 4px #0d1117,0 0 0 5px #2b3139}
.live{font:12px/1.7 Consolas,monospace;color:#8b949e;margin-top:11px;border-top:1px solid #1e2329;
  padding-top:9px}
.live b{color:#eaecef;font-weight:500}
.save{position:fixed;left:0;right:0;bottom:0;background:rgba(11,14,17,.95);border-top:1px solid #2b3139;
  padding:12px 18px;backdrop-filter:blur(6px);z-index:9}
.save .in{max-width:1060px;margin:0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
button.primary{background:#2ebd85;border:0;color:#08110d;padding:10px 22px;border-radius:8px;
  font-size:14px;font-weight:600;cursor:pointer}
button.primary:disabled{opacity:.55;cursor:default}
button.ghost{background:#1e2329;border:1px solid #2b3139;color:#b7bdc6;padding:9px 16px;
  border-radius:8px;font-size:13px;cursor:pointer}
#msg{font-size:13px;color:#2ebd85}
#msg.err{color:#f6465d}
</style></head><body>
<div class="wrap">
  <h1>后台设置</h1>
  <div class="sub">改动点「保存并应用」，1 秒后屏幕自动跟着变（盒子走长连接，不用重启、不用重新刷固件）。
    改盒子连的地址 → <a href="#boxCard" style="color:#3f7bd8">「屏幕设备」</a>
    　换上游行情源 → <a href="#advCard" style="color:#3f7bd8">「行情接口地址」</a></div>

  <div class="top" id="top"></div>

  <div class="grid">
    <div>
      <div class="card" id="boxCard" style="border-color:#2f6f55">
        <h2>屏幕设备（盒子）<i>改盒子连哪个行情服务 —— 就是 192.168.100.2:8095 这一项</i></h2>
        <div class="note" id="boxState" style="margin-top:0">读取中…</div>
        <div class="lbl">盒子 IP（服务端从它自己的取数请求里自动认出来，可手改）</div>
        <input id="boxIp" placeholder="192.168.100.106">
        <div class="lbl">盒子要连的行情服务地址（host:port，不用写 http://）</div>
        <input id="boxApi" placeholder="192.168.100.2:8095">
        <div class="chips">
          <span class="chip" id="boxPush" style="border-color:#2ebd85;color:#2ebd85">推送给盒子</span>
          <span class="chip" id="boxRead">重新读一遍</span>
          <span class="chip" id="boxSelf">填成本页地址</span>
        </div>
        <div class="note" id="boxMsg">推送后盒子会立刻断开旧连接、用新地址重连，屏幕 1~2 秒后恢复。<br>
          填错了盒子就取不到数，那时打开 <b>http://盒子IP/syms</b> 手动改回来。</div>
      </div>

      <div class="card">
        <h2>屏幕显示的币种 <i>最多 4 个（240×240 屏幕，再多就挤了）</i></h2>
        <div class="symlist" id="syms"></div>
        <div class="addbar">
          <input id="addIn" placeholder="输入币种代号，如 SOL / TON / PEPE，回车添加" maxlength="10">
          <button class="ghost" id="addBtn" style="flex:none">添加</button>
        </div>
        <div class="chips" id="chips"></div>
        <div class="note">顺序就是屏幕上的顺序，用 ↑ ↓ 调。服务端会自动补 <code>USDT</code> 后缀（填 BTC 即 BTCUSDT 永续合约）。</div>
      </div>

      <div class="card">
        <h2>显示内容</h2>
        <div class="switch">
          <span>人民币价格<small>每行右下角显示 ¥ 金额；关掉就用 24h 成交额顶上</small></span>
          <label class="tg"><input type="checkbox" id="optCny"><i></i></label>
        </div>
        <div class="switch">
          <span>24h 成交额<small>只在关掉人民币时显示，如「880亿」</small></span>
          <label class="tg"><input type="checkbox" id="optVol"><i></i></label>
        </div>
        <div class="switch">
          <span>涨跌配色<small>币安/国际习惯是绿涨红跌，A 股习惯是红涨绿跌</small></span>
          <div class="seg" id="segColor">
            <button data-v="green">绿涨红跌</button><button data-v="red">红涨绿跌</button>
          </div>
        </div>
        <div class="switch">
          <span>屏幕行数<small>行数越少，同样字号越宽松</small></span>
          <div class="seg" id="segRows">
            <button data-v="1">1</button><button data-v="2">2</button><button data-v="3">3</button><button data-v="4">4</button>
          </div>
        </div>
        <div class="switch">
          <span>主字号<small>币种名（BTC）和涨跌幅（+4.28%）的字号</small></span>
          <div class="seg" id="segFb">
            <button data-v="0">小</button><button data-v="1">中</button><button data-v="2">大</button><button data-v="3">特大</button>
          </div>
        </div>
        <div class="switch">
          <span>次字号<small>价格和人民币金额的字号</small></span>
          <div class="seg" id="segFs">
            <button data-v="0">小</button><button data-v="1">中</button><button data-v="2">大</button><button data-v="3">特大</button>
          </div>
        </div>
        <div class="note">字号改完立刻生效（走长连接下发，盒子不用重启）。行数多、字号又调太大时，盒子会自动降一档到放得下为止，不会重叠。</div>
      </div>

      <div class="card">
        <h2>行情速度</h2>
        <div class="switch">
          <span>合并推送间隔 <b class="val" id="pushVal">150</b> ms<small>币安一笔成交到屏幕约 0.25 秒。改大一点数字跳得慢些、更好看；改小更跟手。</small></span>
        </div>
        <input type="range" id="pushMs" min="80" max="800" step="10">
      </div>

      <div class="card">
        <h2>人民币汇率</h2>
        <div class="switch">
          <span>自动联网获取<small>每 10 分钟取一次中间价，当前 <b id="autoRate">-</b></small></span>
          <label class="tg"><input type="checkbox" id="autoCny"><i></i></label>
        </div>
        <div id="manualBox" style="display:none">
          <div class="lbl">手动锁定汇率（1 USDT 兑多少 CNY）</div>
          <input id="cnyRate" placeholder="例如 7.30，按你实际 C2C 成交价填">
        </div>
      </div>

      <div class="card" id="advCard">
        <h2>行情接口地址 <i>换服务商时才改；改完会重连上游，屏幕空 1~2 秒属正常</i></h2>
        <div class="lbl">WebSocket 地址（实时推送，主通道）</div>
        <input id="wsUrl" placeholder="wss://fstream.binancefuture.com/stream">
        <div class="lbl">REST 兜底地址（长连接断开时用，每 30 秒拉一次）</div>
        <input id="restUrl" placeholder="https://fapi.binance.com/fapi/v1/ticker/24hr">
        <div class="lbl">订阅流（逗号分隔：aggTrade=逐笔成交，ticker=1 秒行情）</div>
        <input id="streams" placeholder="aggTrade,ticker">
        <div class="lbl">额外请求头（换服务商要带 Key 时填，格式 Key: Value）</div>
        <input id="headers" placeholder="留空即可">
        <div class="chips" id="preChips">
          <span class="chip" data-pre="alt">币安合约（备用域名 · 当前推荐）</span>
          <span class="chip" data-pre="main">币安合约（主域名 · 部分网络被拦）</span>
        </div>
        <div class="note">
          当前生效：<code id="curEp">-</code><br>
          换其他服务商时，只要对方是「币安兼容的 WebSocket + 24hr ticker REST」，把地址填进去即可；
          地址留空表示<b>只用 REST 轮询</b>（延迟约 1 秒，不再实时）。改完点下面的「保存并应用」。
        </div>
      </div>
    </div>

    <div>
      <div class="phone">
        <canvas id="cv" width="480" height="480"></canvas>
        <div class="live" id="live">连接中…</div>
      </div>
    </div>
  </div>
</div>

<div class="save"><div class="in">
  <button class="primary" id="saveBtn">保存并应用</button>
  <button class="ghost" id="resetBtn">重新读取</button>
  <span id="msg"></span>
</div></div>

<script>
var INIT = ${JSON.stringify(init)};
var S = INIT.cfg;
S.symbols = (S.symbols || []).slice(0, 4);
var PRESETS = INIT.presets;
var LAST = [];

function el(id) { return document.getElementById(id); }
function preset(code) {
  for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i][0] === code) return PRESETS[i];
  return null;
}
function colorOf(code) { var p = preset(code); return p ? p[2] : '#5b6673'; }
function nameOf(code) { var p = preset(code); return p ? p[1] : ''; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
  return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

// ---- 顶部状态
function renderTop(st) {
  var d = st.online ? '#2ebd85' : '#f6465d';
  el('top').innerHTML =
    '<span class="pill"><span class="dot" style="background:' + d + '"></span>' +
    (st.online ? '币安合约实时推送已连接' : '上游未连接（REST 兜底中）') + '</span>' +
    '<span class="pill">屏上长连接 <b style="color:#eaecef">' + st.sse + '</b> 个</span>' +
    '<span class="pill">已收行情 <b style="color:#eaecef">' + st.msgs + '</b> 条</span>';
}

// ---- 币种列表
function renderSyms() {
  var h = '';
  for (var i = 0; i < S.symbols.length; i++) {
    var c = S.symbols[i];
    h += '<div class="symrow">' +
      '<span class="coin" style="background:' + colorOf(c) + '">' + esc(c.slice(0, 1)) + '</span>' +
      '<div class="sinfo"><b>' + esc(c) + '/USDT</b><em>' + esc(nameOf(c) || '未收录图标（屏上显示灰圈首字母）') + '</em></div>' +
      '<button data-up="' + i + '">↑</button>' +
      '<button data-dn="' + i + '">↓</button>' +
      '<button class="rm" data-rm="' + i + '">✕</button>' +
      '</div>';
  }
  if (!S.symbols.length) h = '<div class="note">还没有币种，下面选一个添加。</div>';
  el('syms').innerHTML = h;
  var chips = '';
  for (var j = 0; j < PRESETS.length; j++) {
    var p = PRESETS[j];
    if (S.symbols.indexOf(p[0]) >= 0) continue;
    chips += '<span class="chip" data-add="' + p[0] + '">+ ' + p[0] + '</span>';
  }
  el('chips').innerHTML = chips;
}
el('syms').onclick = function (e) {
  var t = e.target;
  if (t.dataset.rm !== undefined) { S.symbols.splice(+t.dataset.rm, 1); renderSyms(); drawPreview(); return; }
  if (t.dataset.up !== undefined) {
    var i = +t.dataset.up; if (i > 0) { var a = S.symbols[i]; S.symbols[i] = S.symbols[i - 1]; S.symbols[i - 1] = a; }
    renderSyms(); drawPreview(); return;
  }
  if (t.dataset.dn !== undefined) {
    var k = +t.dataset.dn;
    if (k < S.symbols.length - 1) { var b = S.symbols[k]; S.symbols[k] = S.symbols[k + 1]; S.symbols[k + 1] = b; }
    renderSyms(); drawPreview(); return;
  }
};
el('chips').onclick = function (e) {
  var c = e.target.dataset.add;
  if (c) addSymbol(c);
};
function addSymbol(raw) {
  var c = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  if (!c) return;
  if (S.symbols.indexOf(c) >= 0) { msg('已经有 ' + c + ' 了', true); return; }
  if (S.symbols.length >= 4) { msg('最多 4 个币种', true); return; }
  S.symbols.push(c);
  el('addIn').value = '';
  msg('');
  renderSyms(); drawPreview();
}
el('addBtn').onclick = function () { addSymbol(el('addIn').value); };
el('addIn').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); addSymbol(this.value); } };

// ---- 开关 / 分段
el('optCny').onchange = function () { S.showCny = this.checked; drawPreview(); };
el('optVol').onchange = function () { S.showVol = this.checked; drawPreview(); };
function segSet(id, val, cb) {
  var box = el(id);
  box.onclick = function (e) {
    var v = e.target.dataset.v;
    if (!v) return;
    cb(v);
    paintSeg(id, v);
    drawPreview();
  };
  paintSeg(id, val);
}
function paintSeg(id, val) {
  var bs = el(id).querySelectorAll('button');
  for (var i = 0; i < bs.length; i++) {
    var on = bs[i].dataset.v === String(val);
    bs[i].className = on ? ('on' + (id === 'segColor' && val === 'red' ? ' red' : '')) : '';
  }
}
segSet('segColor', S.colorMode, function (v) { S.colorMode = v; });
segSet('segRows', S.maxRows, function (v) { S.maxRows = +v; });
segSet('segFb', S.fontBig, function (v) { S.fontBig = +v; });
segSet('segFs', S.fontSmall, function (v) { S.fontSmall = +v; });

el('pushMs').oninput = function () { S.pushMs = +this.value; el('pushVal').textContent = this.value; };

el('autoCny').onchange = function () {
  el('manualBox').style.display = this.checked ? 'none' : 'block';
};
el('cnyRate').oninput = function () { S.cnyRate = this.value; };

function updCurEp() {
  var ws = el('wsUrl').value.trim(), rs = el('restUrl').value.trim();
  var t = ws ? ('WS ' + ws) : '仅 REST 轮询（无实时推送）';
  if (rs) t += '   ｜   REST ' + rs;
  el('curEp').textContent = t;
}
el('wsUrl').oninput = function () { S.wsUrl = this.value; updCurEp(); };
el('restUrl').oninput = function () { S.restUrl = this.value; updCurEp(); };
el('streams').oninput = function () { S.streams = this.value; };
el('headers').oninput = function () { S.headers = this.value; };

el('preChips').addEventListener('click', function (e) {
  var pre = e.target.dataset.pre;
  if (!pre) return;
  if (pre === 'alt') {
    el('wsUrl').value = 'wss://fstream.binancefuture.com/stream';
    el('restUrl').value = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
  } else {
    el('wsUrl').value = 'wss://fstream.binance.com/stream';
    el('restUrl').value = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
  }
  S.wsUrl = el('wsUrl').value; S.restUrl = el('restUrl').value;
});

// ---- 240×240 预览：和固件 final14 同一套坐标算
// 字号档位对应的字形高（FreeSansBold 9/12/18/24pt 的 0~9 实测高）
var FONT_H = [13, 18, 26, 34];
var HEAD_H = 30, X_L = 6, X_R = 232;
var FONT_FAM = '-apple-system,"Segoe UI","Microsoft YaHei",sans-serif';
var LASTTIME = '';

function drawPreview() {
  var c = el('cv').getContext('2d');
  c.setTransform(2, 0, 0, 2, 0, 0);
  c.fillStyle = '#0b0e11';
  c.fillRect(0, 0, 240, 240);
  c.textBaseline = 'alphabetic';

  var n = Math.max(1, Math.min(4, +S.maxRows || 4));
  if (LAST.length) n = Math.min(n, LAST.length);   // 盒子按实际收到的行数排行高

  var pxOf = function (lvl) { return Math.round(FONT_H[lvl] * 1.3); };
  var meas = function (lvl, s) {
    c.font = 'bold ' + pxOf(lvl) + 'px ' + FONT_FAM;
    return c.measureText(String(s)).width;
  };
  var row = function (i) {
    return LAST[i] || { l: (S.symbols[i] || 'BTC') + '/USDT', p: '—', c: '-', u: 0, y: '', v: '' };
  };

  // ---- 版式：先按行高纵向收敛，再按「价格 + 人民币」宽度收敛次字号
  var rowH = Math.floor((240 - HEAD_H) / n);
  var fb = Math.max(0, Math.min(3, +S.fontBig || 0));
  var fs = Math.max(0, Math.min(3, +S.fontSmall || 0));
  while (FONT_H[fb] + FONT_H[fs] + 4 > rowH && (fb > 0 || fs > 0)) {
    if (fb >= fs) { if (fb > 0) fb--; } else { if (fs > 0) fs--; }
  }
  while (fs > 0) {
    var need = 0;
    for (var i = 0; i < n; i++) {
      var r0 = row(i);
      var w = X_L + meas(fs, r0.p) + 8 + (S.showCny ? 12 + 2 + meas(fs, '¥' + r0.y) : 0);
      if (w > need) need = w;
    }
    if (need <= X_R) break;
    fs--;
  }
  var hb = FONT_H[fb], hs = FONT_H[fs];
  var lgap = Math.min(6, Math.max(2, Math.floor(hb / 8)));
  var topPad = Math.max(1, Math.floor((rowH - (hb + lgap + hs)) / 2));
  var bigTop = topPad, subTop = topPad + hb + lgap;

  // ---- 顶部白色时间条（圆角只在顶部）
  c.fillStyle = '#f5f7fa';
  roundRect(c, 0, 0, 240, HEAD_H + 10, 9); c.fill();
  c.fillStyle = '#0b0e11';
  c.fillRect(0, HEAD_H, 240, 10);

  c.fillStyle = '#1c1e22';
  c.textAlign = 'left';
  c.font = 'bold 18px ' + FONT_FAM;
  c.fillText(LASTTIME || '--:--:--', 10, 22);

  // WiFi：三道弧 + 圆点（跟固件一致：r=6/10/14，弧厚 2px）
  c.strokeStyle = '#1c1e22';
  c.lineWidth = 2;
  for (var w2 = 0; w2 < 3; w2++) {
    c.beginPath();
    c.arc(219, HEAD_H - 7, 6 + w2 * 4, -Math.PI * 0.7778, -Math.PI * 0.2222, false);
    c.stroke();
  }
  c.fillStyle = '#1c1e22';
  c.beginPath(); c.arc(219, HEAD_H - 7, 2, 0, Math.PI * 2); c.fill();

  // ---- 行情行
  for (var k = 0; k < n; k++) {
    var r = row(k);
    var y0 = HEAD_H + k * rowH;
    var lab = String(r.l || 'BTC/USDT');
    var sl = lab.indexOf('/');
    var base = sl > 0 ? lab.slice(0, sl) : lab;
    var tail = sl > 0 ? lab.slice(sl) : '/USDT';

    // 右上：涨跌幅（先算左边界）
    var chgW = meas(fb, r.c);
    var chgX = X_R - chgW;

    // 左上：币种大字 + /USDT 9pt 小字（撞上就不画）
    c.textAlign = 'left';
    c.font = 'bold ' + pxOf(fb) + 'px ' + FONT_FAM;
    c.fillStyle = '#eaecef';
    c.fillText(base, X_L, y0 + bigTop + hb);
    var symW = c.measureText(base).width;
    if (X_L + symW + 2 + meas(0, tail) <= chgX - 3) {
      c.font = 'bold ' + pxOf(0) + 'px ' + FONT_FAM;
      c.fillStyle = '#848e9c';
      c.fillText(tail, X_L + symW + 2, y0 + bigTop + hb);
    }

    // 右上：涨跌幅
    var up = r.u === 1;
    var col = S.colorMode === 'red' ? (up ? '#f6465d' : '#2ebd85') : (up ? '#2ebd85' : '#f6465d');
    if (r.u === 0) col = '#848e9c';
    c.font = 'bold ' + pxOf(fb) + 'px ' + FONT_FAM;
    c.fillStyle = col;
    c.textAlign = 'right';
    c.fillText(r.c, X_R, y0 + bigTop + hb);

    // 左下：USDT 价
    c.font = 'bold ' + pxOf(fs) + 'px ' + FONT_FAM;
    c.fillStyle = '#ffffff';
    c.textAlign = 'left';
    c.fillText(r.p, X_L, y0 + subTop + hs);

    // 右下：人民币（没开就退回成交额）
    var right = '';
    if (S.showCny && r.y) right = '¥' + r.y;
    else if (S.showVol && r.v) right = r.v + '亿';
    if (right) {
      c.fillStyle = '#848e9c';
      c.textAlign = 'right';
      c.fillText(right, X_R, y0 + subTop + hs);
    }
  }
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ---- 保存
function msg(t, bad) {
  var m = el('msg');
  m.textContent = t || '';
  m.className = bad ? 'err' : '';
}
function collect() {
  return {
    symbols: S.symbols.join(','),
    showCny: S.showCny ? 'true' : 'false',
    showVol: S.showVol ? 'true' : 'false',
    colorMode: S.colorMode,
    maxRows: String(S.maxRows),
    fontBig: String(S.fontBig),
    fontSmall: String(S.fontSmall),
    pushMs: String(S.pushMs),
    cnyRate: el('autoCny').checked ? '' : String(el('cnyRate').value || '').trim(),
    wsUrl: el('wsUrl').value.trim(),
    restUrl: el('restUrl').value.trim(),
    streams: el('streams').value.trim(),
    headers: el('headers').value.trim(),
  };
}
el('saveBtn').onclick = function () {
  if (!S.symbols.length) { msg('至少要留一个币种', true); return; }
  var btn = this;
  btn.disabled = true;
  msg('保存中…');
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collect())
  }).then(function (r) { return r.json(); }).then(function (j) {
    btn.disabled = false;
    if (!j.ok) { msg('保存失败：' + (j.error || '未知错误'), true); return; }
    msg('已生效，屏幕约 1 秒后跟着变');
    S.cnyRate = String(j.upstream.cnyRate || '');
    updCurEp();
    renderTop({ online: !!(j.feed && j.feed.connected), sse: j.sseClients, msgs: (j.feed && j.feed.msgs) || 0 });
    setInterval(function () { msg(''); }, 4000);
  }).catch(function (e) {
    btn.disabled = false;
    msg('保存失败：' + e.message, true);
  });
};
el('resetBtn').onclick = function () { location.reload(); };

// ---- 实时数据
var es = new EventSource('/api/stream');
es.onmessage = function (ev) {
  var j = JSON.parse(ev.data);
  LAST = j.d || [];
  LASTTIME = j.t || '';
  var out = '';
  for (var i = 0; i < LAST.length; i++) {
    var r = LAST[i];
    var cls = r.u === 1 ? (S.colorMode === 'red' ? '#f6465d' : '#2ebd85')
      : r.u === -1 ? (S.colorMode === 'red' ? '#2ebd85' : '#f6465d') : '#848e9c';
    out += '<div style="display:flex;gap:6px;justify-content:space-between">' +
      '<b>' + esc(r.l) + '</b><span>' + esc(r.p) + '</span>' +
      '<span style="color:' + cls + '">' + esc(r.c) + '</span></div>';
  }
  out += '<div style="margin-top:6px;color:#6b7480">数据年龄 ' + (j.a === null ? '-' : j.a + ' ms') +
    ' ｜ 汇率 1U=' + (j.r === undefined ? '-' : j.r) + '</div>';
  el('live').innerHTML = out;
  drawPreview();
};

// ---- 初始化
el('optCny').checked = !!S.showCny;
el('optVol').checked = !!S.showVol;
el('pushMs').value = S.pushMs;
el('pushVal').textContent = S.pushMs;
el('autoCny').checked = !S.cnyRate;
el('manualBox').style.display = S.cnyRate ? 'block' : 'none';
el('cnyRate').value = S.cnyRate;
el('autoRate').textContent = '1U ≈ ' + INIT.cfg.autoRate + ' CNY';
el('wsUrl').value = S.wsUrl;
el('restUrl').value = S.restUrl;
el('streams').value = S.streams;
el('headers').value = S.headers;
updCurEp();

// ---- 屏幕设备（盒子）：读它现在连的地址，推送新地址进去
function boxShow(txt, bad) {
  var b = el('boxMsg');
  b.innerHTML = txt;
  b.style.color = bad ? '#f6465d' : '#6b7480';
}
function boxLoad() {
  el('boxState').textContent = '读取中…';
  fetch('/api/box').then(function (r) { return r.json(); }).then(function (j) {
    if (j.ip) el('boxIp').value = j.ip;
    if (j.target) el('boxApi').value = j.target;
    else if (!el('boxApi').value) el('boxApi').value = location.host;
    el('boxState').innerHTML = j.online
      ? '<b style="color:#2ebd85">盒子在线</b> · 它现在连的是 <code>' + (j.target || '读取失败') + '</code>'
        + ' · ' + (j.rows || 0) + ' 行 · heap ' + (j.heap || 0) + ' B'
      : '<b style="color:#f6465d">盒子没响应</b> · ' + (j.hint || '检查 IP 是否对、是否同一网段');
  }).catch(function () { el('boxState').textContent = '读不到盒子状态（服务端异常）'; });
}
el('boxRead').onclick = boxLoad;
el('boxSelf').onclick = function () { el('boxApi').value = location.host; };
el('boxPush').onclick = function () {
  var ip = el('boxIp').value.trim(), api = el('boxApi').value.trim();
  if (!ip) { boxShow('先填盒子 IP', true); return; }
  if (!/^[A-Za-z0-9._-]+:[0-9]+$/.test(api)) { boxShow('地址要写成 host:port，例如 192.168.100.2:8095', true); return; }
  boxShow('正在推送给盒子…');
  fetch('/api/box', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: ip, api: api })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) { boxShow('推送失败：' + (j.error || '未知错误'), true); return; }
    boxShow('<b style="color:#2ebd85">已推送到盒子</b> · 它现在连 <code>' + j.api + '</code>，2 秒后屏幕恢复');
    setTimeout(boxLoad, 2500);
  }).catch(function (e) { boxShow('推送失败：' + e.message, true); });
};
boxLoad();
renderTop(INIT.status);
renderSyms();
drawPreview();
</script>
</body></html>`;
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  // 收集 body（用于探测固件 POST 了什么）
  let body = '';
  req.on('data', (c) => { if (body.length < 2048) body += c.toString('utf8'); });
  req.on('end', () => handle(req, res, url, body));
});

async function handle(req, res, url, body) {
  const p = (url.pathname.replace(/\/+$/, '') || '/');
  const q = url.searchParams;

  try {
    if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    // 老的静态预览图早于当前固件版式，已经过时 → 统一跳到后台（那里带实时预览）
    if (p === '/preview' || p === '/preview.html') {
      res.writeHead(302, { Location: '/admin' });
      return res.end('');
    }

    if (p === '/health') {
      return sendJson(res, {
        ok: state.quotes.length > 0,
        uptime: Math.floor(process.uptime()),
        updated: state.updatedAt,
        ageSec: state.updatedAt ? Math.floor(Date.now() / 1000) - state.updatedAt : null,
        source: state.cryptoSource,
        market: state.market,
        quotes: state.quotes.length,
        stocks: state.stocks.length,
        cnyRate: Math.round(rate.usdtCny * 10000) / 10000,
        lastError: state.lastError || null,
        providers: state.providerStatus,
        config: {
          symbols: CFG.symbols.map((s) => s.sym),
          stocks: CFG.stocks,
          providers: CFG.providers,
          refreshMs: CFG.refreshMs,
        },
      });
    }

    // 极简接口：给内存紧张的设备用（ESP8266 只有 ~40KB 堆）
    // 字段短、无重复数组，整个响应 300 字节上下
    // 运行时增删/修改盯盘币种：/api/symbols?set=BTC,ETH,SOL
    if (p === '/api/symbols' || p === '/api/watch') {
      const set = q.get('set') || q.get('add') || '';
      if (set) {
        const arr = list(set, '').map((s) => s.toUpperCase()).slice(0, 8);
        if (arr.length) {
          CFG.symbols = arr.map(parseSymbol);
          state.quotes = [];
          // 落盘用补全后缀后的名字，重启时不用再猜
          saveFeedCfg({ symbols: CFG.symbols.map((s) => s.sym).join(',') });
          startFeed();            // 币种变了要重新订阅
          restFallback();
        }
      }
      return sendJson(res, {
        ok: true,
        count: CFG.symbols.length,
        symbols: CFG.symbols.map((s) => s.sym),
        bases: CFG.symbols.map((s) => s.base),
      });
    }

    // 实时推送（SSE）：盒子保持一条长连接，币安有成交就立刻下发
    // 用 Connection: close + 关闭 chunked，让 ESP8266 能直接按行读，不用解析分块编码
    if (p === '/api/stream' || p === '/api/sse') {
      noteBox(req);
      res.useChunkedEncodingByDefault = false;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'close',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + sseBody() + '\n\n');
      sseClients.add(res);
      // 只监听 res 的 close：GET 请求的 req 在请求体读完时就会触发 close，
      // 用它做清理会立刻把刚连上的客户端删掉（踩过这个坑）。
      res.setTimeout(0);
      res.on('close', () => { sseClients.delete(res); });
      res.on('error', () => { sseClients.delete(res); });
      return;
    }

    // 上游接口配置：改这里就能换行情源，不用改代码
    if (p === '/api/config') {
      if (req.method === 'POST') {
        let patch = {};
        if (body && body.trim().startsWith('{')) {
          try { patch = JSON.parse(body); } catch (e) {
            return sendJson(res, { ok: false, error: 'bad json' }, 400);
          }
        } else if (body) {
          for (const [k, v] of new URLSearchParams(body)) patch[k] = v;
        }
        const rebuild = ['wsUrl', 'streams', 'symbols', 'pushMs', 'headers']
          .some((k) => patch[k] !== undefined && String(patch[k]) !== String(FEEDCFG[k]));
        if (patch.symbols !== undefined) {
          const arr = list(patch.symbols, '').map((s) => s.toUpperCase());
          if (arr.length) CFG.symbols = arr.map(parseSymbol);
        }
        saveFeedCfg(patch);
        if (rebuild) startFeed();
        if (patch.cnyRate !== undefined) refreshCnyRate(true).catch(() => {});
        // 字号/行数这类纯显示项：行情没跳动时也立刻推一帧过去，屏幕马上跟着变
        sseBroadcast();
        return sendJson(res, configView());
      }
      return sendJson(res, configView());
    }

    // 屏幕设备（盒子）：查看 / 修改它去哪个地址取数（就是 192.168.100.2:8095 这一项）
    if (p === '/api/box') {
      if (req.method === 'POST') {
        let patch = {};
        try { patch = JSON.parse(body || '{}'); } catch (e) {
          return sendJson(res, { ok: false, error: 'bad json' }, 400);
        }
        const ip = String(patch.ip || FEEDCFG.boxIp || state.boxIp || '').trim();
        const r = await pushBoxApi(ip, patch.api);
        if (r.ok) saveFeedCfg({ boxIp: ip });
        return sendJson(res, Object.assign({ boxIp: ip, target: r.api || '' }, r));
      }
      const ip = String(FEEDCFG.boxIp || state.boxIp || '').trim();
      const st = ip ? await probeBox(ip) : { online: false };
      return sendJson(res, {
        ok: true,
        ip,
        online: !!st.online,
        target: st.api || '',
        rows: st.rows,
        sse: st.sse,
        heap: st.heap,
        lastSeenAgoMs: state.boxSeenAt ? Date.now() - state.boxSeenAt : null,
        self: '127.0.0.1:' + PORT,
        hint: st.online ? '' : '盒子没响应，检查 IP / 是否同一网段 / 是否断电',
      });
    }

    if (p === '/admin' || p === '/config') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(adminPage());
    }

    if (p === '/api/latency') {
      const now = Date.now();
      return sendJson(res, {
        ok: true,
        wsConnected: feed ? feed.st.connected : false,
        msgs: feed ? feed.st.msgCount : 0,
        lastMsgAgoMs: feed && feed.st.lastMsgAt ? now - feed.st.lastMsgAt : null,
        minAgeMs: state.quotes.length
          ? Math.min(...state.quotes.map((q) => (Number.isFinite(q.ageMs) ? q.ageMs : 1e9)))
          : null,
        sseClients: sseClients.size,
        rows: itemsView().slice(0, 8).map((x) => ({ s: x.symbol, p: x.price, a: null })),
      });
    }

    if (p === '/api/tiny' || p === '/api/mini') {
      noteBox(req);
      const t = timeInfo();
      const rows = screenRows();
      const age = state.quotes.length
        ? Math.min(...state.quotes.map((q) => (Number.isFinite(q.ageMs) ? q.ageMs : 9999)))
        : null;
      return sendJson(res, {
        t: t.time, s: state.cryptoSource, m: state.market,
        r: Math.round(rate.usdtCny * 100) / 100, a: age,
        fb: FEEDCFG.fontBig, fs: FEEDCFG.fontSmall,
        d: rows,
      });
    }

    // 当前人民币汇率（USDT→CNY）：屏幕后台/自己排查都用得上
    if (p === '/api/rate') {
      return sendJson(res, {
        ok: true,
        usdtCny: rate.usdtCny,
        source: rate.src,
        at: rate.at ? new Date(rate.at).toISOString() : null,
        ageSec: rate.at ? Math.round((Date.now() - rate.at) / 1000) : null,
        manual: String(FEEDCFG.cnyRate || '').trim() !== '',
        error: rate.error || null,
      });
    }

    // 通用接口
    if (p === '/api/quotes' || p === '/api/device' || p === '/api/data' || p === '/api/all') {
      const t = timeInfo();
      return sendJson(res, {
        ok: state.quotes.length > 0 || state.stocks.length > 0,
        ts: t.ts,
        time: t.time,
        date: t.date,
        source: state.cryptoSource,
        market: state.market,
        updated: state.updatedAt,
        items: itemsView(),
        quotes: itemsView(),
      });
    }

    if (p === '/api/quotes/flat' || p === '/api/flat') {
      return sendJson(res, Object.assign({ ok: true, ts: Math.floor(Date.now() / 1000) }, flatQuotes(), { items: itemsView() }));
    }

    if (p === '/api/stocks') {
      return sendJson(res, { ok: true, source: state.stockSource, items: state.stocks });
    }

    if (p === '/api/time' || p === '/api/clock') {
      const t = timeInfo();
      return sendJson(res, { ok: true, ts: t.ts, time: t.time, date: t.date, weekday: t.weekday, tz: t.tz });
    }

    // 单币种查询
    if (p === '/api/price') {
      const sym = parseSymbol(q.get('symbol') || q.get('coin') || CFG.symbols[0].sym).sym;
      const hit = state.quotes.find((x) => x.symbol === sym);
      if (!hit) return sendJson(res, { ok: false, error: 'unknown symbol', symbol: sym }, 404);
      return sendJson(res, Object.assign({ ok: true, symbol: sym }, hit));
    }

    // Binance 兼容
    if (/\/api\/v3\/ticker\/(24hr|price)$/.test(p) || /\/ticker\/24hr$/.test(p) || /\/ticker\/price$/.test(p)) {
      const sym = (q.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (/\/ticker\/price$/.test(p)) {
        if (sym) {
          const hit = state.quotes.find((x) => x.symbol === sym);
          return sendJson(res, hit ? { symbol: sym, price: String(hit.price) } : { code: -1121, msg: 'Invalid symbol.' });
        }
        return sendJson(res, state.quotes.map((x) => ({ symbol: x.symbol, price: String(x.price) })));
      }
      return sendJson(res, binanceTicker(sym || null));
    }

    // OKX 兼容
    if (/\/api\/v5\/market\/tickers$/.test(p) || /\/market\/tickers$/.test(p)) {
      return sendJson(res, okxTicker());
    }

    if (p === '/probe') return sendHtml(res, probePage());
    if (p === '/probe.json') return sendJson(res, { count: reqLog.length, items: reqLog.slice().reverse() });

    // 未匹配：记录并回万能 JSON
    logRequest(req, url, body);
    return sendJson(res, kitchenSink());
  } catch (e) {
    return sendJson(res, { ok: false, error: String((e && e.message) || e) }, 500);
  }
}

// ---------------------------------------------------------------- 启动

server.listen(PORT, '0.0.0.0', () => {
  const msg = '[' + new Date().toISOString() + '] ' + CFG.siteName + ' listening on :' + PORT +
    ' | symbols=' + CFG.symbols.map((s) => s.sym).join(',') +
    ' | ws=' + FEEDCFG.wsUrl +
    ' | streams=' + FEEDCFG.streams +
    ' | push=' + FEEDCFG.pushMs + 'ms';
  console.log(msg);

  // 人民币汇率：启动取一次，之后每 10 分钟更新（/admin 里填了固定值就跳过联网）
  refreshCnyRate(true).catch(() => {});
  setInterval(() => { refreshCnyRate().catch(() => {}); }, RATE_TTL_MS).unref();

  // 主通道：直连币安合约 WebSocket（逐笔成交）
  startFeed();
  // 保底：WS 没数据时用批量 REST 补，保证不会停在旧价
  restFallback();
  setInterval(restFallback, Math.max(5, Number(FEEDCFG.restEverySec) || 30) * 1000);

  // 万一 WS 完全不通，8 秒后走一次老的多源链兜底
  setTimeout(() => {
    if (!state.quotes.length) {
      refresh().then(() => {
        console.log('多源兜底: ' + state.quotes.length + ' 个币种, 源=' + (state.cryptoSource || 'none'));
      }).catch(() => {});
    }
  }, 8000);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
