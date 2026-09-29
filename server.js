const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY;
const DEMO = process.env.CAPITAL_DEMO !== "false";
const BASE_URL = `${DEMO ? "https://demo-api-capital.backend-capital.com" : "https://api-capital.backend-capital.com"}/api/v1`;
const EPIC = process.env.GOLD_EPIC || "GOLD";
const RESOLUTION = process.env.STRATEGY_TIMEFRAME || "MINUTE_5";
const POLL_MS = Number(process.env.ENGINE_INTERVAL_MS || 10000);

if (process.env.NODE_ENV === "production" && !API_KEY) {
  throw new Error("API_KEY is required in production; refusing to start with an unsecured trading API.");
}

const config = {
  autoTrading: process.env.AUTO_TRADING === "true",
  emergencyStop: false,
  maxOpenTrades: Number(process.env.MAX_OPEN_TRADES || 1),
  maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY || 20),
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS || 100),
  riskPercent: Number(process.env.RISK_PERCENT_PER_TRADE || 0.25),
  fixedSize: Number(process.env.MAX_RISK_PER_TRADE || 0.1),
  maxSpread: Number(process.env.MAX_SPREAD || 1.0),
  minScore: Number(process.env.MIN_SNIPER_SCORE || 60),
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 1800),
  slAtr: Number(process.env.ATR_SL_MULTIPLIER || 1.2),
  tpAtr: Number(process.env.ATR_TP_MULTIPLIER || 0.8),
  maxAtr: Number(process.env.MAX_ATR || 8),
  minAtr: Number(process.env.MIN_ATR || 0.5),
  oneTradePerCandle: process.env.ONE_TRADE_PER_CANDLE !== "false"
};

let session = null;
let sessionPromise = null;
let candles = [];
let lastCandleId = null;
let lastTradeAt = 0;
let lastSignalId = null;
let lastSignal = { signal: "WAITING", reason: "Engine initializing", score: 0, details: {} };
let ledger = [];
let daily = { date: new Date().toISOString().slice(0, 10), count: 0, realizedPnL: 0 };
let cycleRunning = false;

function auth(req, res, next) {
  if (!API_KEY) return next();
  const supplied = req.get("x-api-key") || req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (supplied !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}
function resetDaily() {
  const date = new Date().toISOString().slice(0, 10);
  if (daily.date !== date) daily = { date, count: 0, realizedPnL: 0 };
}
function brokerError(error) { return error.response?.data || error.code || error.message; }
function finite(v) { return Number.isFinite(Number(v)); }

async function getSession(force = false) {
  if (!force && session && Date.now() - session.created < 5 * 60 * 1000) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = axios.post(`${BASE_URL}/session`, {
    identifier: process.env.CAPITAL_IDENTIFIER,
    password: process.env.CAPITAL_PASSWORD
  }, { timeout: 10000, headers: { "X-CAP-API-KEY": process.env.CAPITAL_API_KEY } }).then(response => {
    session = {
      cst: response.headers.cst,
      securityToken: response.headers["x-security-token"],
      accountId: response.data.currentAccountId,
      account: response.data,
      created: Date.now()
    };
    if (!session.cst || !session.securityToken) throw new Error("Broker session tokens were missing");
    return session;
  }).finally(() => { sessionPromise = null; });
  return sessionPromise;
}

async function brokerRequest(method, url, data) {
  let retried = false;
  for (;;) {
    try {
      const s = await getSession(retried);
      return await axios({
        method,
        url: `${BASE_URL}${url}`,
        data,
        timeout: 10000,
        headers: { CST: s.cst, "X-SECURITY-TOKEN": s.securityToken, "Content-Type": "application/json" }
      });
    } catch (error) {
      const status = error.response?.status;
      if (!retried && status === 401) { retried = true; session = null; continue; }
      if (status === 429 || status >= 500) error.message = `Broker temporary error (${status}): ${JSON.stringify(brokerError(error))}`;
      throw error;
    }
  }
}

async function price() {
  const response = await brokerRequest("GET", `/markets/${EPIC}`);
  const m = response.data.marketDetails || response.data;
  const s = m.snapshot || m;
  const bid = Number(s.bid), offer = Number(s.offer);
  if (!Number.isFinite(bid) || !Number.isFinite(offer)) throw new Error("Broker returned an invalid Gold quote");
  return { bid, offer, price: (bid + offer) / 2, spread: +(offer - bid).toFixed(2), high: Number(s.high), low: Number(s.low), time: Date.now() };
}

async function loadCandles() {
  const response = await brokerRequest("GET", `/prices/${EPIC}?resolution=${encodeURIComponent(RESOLUTION)}&max=200`);
  const raw = response.data.prices || [];
  return raw.map((x, i) => ({
    id: x.snapshotTime || x.snapshotTimeUTC || String(i),
    open: Number(x.openPrice?.bid ?? x.openPrice ?? x.open),
    high: Number(x.highPrice?.bid ?? x.highPrice ?? x.high),
    low: Number(x.lowPrice?.bid ?? x.lowPrice ?? x.low),
    close: Number(x.closePrice?.bid ?? x.closePrice ?? x.close),
    time: x.snapshotTime || x.snapshotTimeUTC || Date.now() + i
  })).filter(c => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period || 1e-9;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(data, period = 14) {
  if (data.length < period + 1) return null;
  const tr = data.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - data[i].close), Math.abs(c.low - data[i].close)));
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]) / period;
  return value;
}

function adx(data, period = 14) {
  if (data.length < period * 2 + 1) return null;
  const tr = [], plus = [], minus = [];
  for (let i = 1; i < data.length; i++) {
    const c = data[i], p = data[i - 1];
    const up = c.high - p.high, down = p.low - c.low;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  let trS = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let pS = plus.slice(0, period).reduce((a, b) => a + b, 0);
  let mS = minus.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + plus[i];
      mS = mS - mS / period + minus[i];
    }
    const pdi = trS ? 100 * pS / trS : 0;
    const mdi = trS ? 100 * mS / trS : 0;
    dx.push((pdi + mdi) ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  if (dx.length < period) return null;
  let value = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) value = (value * (period - 1) + dx[i]) / period;
  return value;
}

function momentum(data, bars = 3) {
  if (data.length <= bars) return 0;
  return data[data.length - 1].close - data[data.length - 1 - bars].close;
}

function score(signal, m) {
  let value = 0;
  if ((signal === "BUY" && m.price > m.e50) || (signal === "SELL" && m.price < m.e50)) value += 20;
  if ((signal === "BUY" && m.e9 > m.e21) || (signal === "SELL" && m.e9 < m.e21)) value += 20;
  if ((signal === "BUY" && m.rsi > 55) || (signal === "SELL" && m.rsi < 45)) value += 15;
  if (m.adx >= 20) value += 15;
  if ((signal === "BUY" && m.momentum > 0) || (signal === "SELL" && m.momentum < 0)) value += 15;
  return value;
}

async function positions() { return (await brokerRequest("GET", "/positions")).data.positions || []; }
async function account() { return (await brokerRequest("GET", "/accounts")).data; }

async function place(direction, size, stop, limit) {
  const response = await brokerRequest("POST", "/positions", {
    epic: EPIC,
    direction,
    size,
    guaranteedStop: false,
    stopLevel: +stop.toFixed(2),
    profitLevel: +limit.toFixed(2)
  });
  return response.data;
}

async function confirm(dealReference) {
  if (!dealReference) return null;
  const response = await brokerRequest("GET", `/confirms/${encodeURIComponent(dealReference)}`);
  return response.data;
}

async function close(dealId) {
  return (await brokerRequest("DELETE", `/positions/${encodeURIComponent(dealId)}`)).data;
}

function numericPnlFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  const preferred = keys.find(k => /^(realised|realized)?(pnl|profit|profitandloss)$/i.test(k));
  if (preferred && finite(obj[preferred])) return Number(obj[preferred]);
  const nested = keys.find(k => /profit|pnl|realised|realized/i.test(k) && obj[k] && typeof obj[k] === "object");
  if (nested) {
    const n = numericPnlFromObject(obj[nested]);
    if (n !== null) return n;
  }
  for (const k of keys) {
    if (obj[k] && typeof obj[k] === "object") {
      const n = numericPnlFromObject(obj[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

function findDealId(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of ["dealId", "dealID", "dealReference"]) if (obj[k]) return String(obj[k]);
  for (const v of Object.values(obj)) if (v && typeof v === "object") { const found = findDealId(v); if (found) return found; }
  return null;
}

async function brokerCloseInfo(dealId) {
  const out = { pnl: null, closeLevel: null, source: null, raw: null };
  try {
    const a = await brokerRequest("GET", `/history/activity?lastPeriod=86400&dealId=${encodeURIComponent(dealId)}&detailed=true`);
    out.raw = a.data;
    out.pnl = numericPnlFromObject(a.data);
    if (finite(a.data?.level)) out.closeLevel = Number(a.data.level);
    out.source = "activity";
  } catch (e) {}
  if (out.pnl === null) {
    try {
      const t = await brokerRequest("GET", "/history/transactions?lastPeriod=86400");
      const rows = t.data?.transactions || t.data?.transaction || [];
      const arr = Array.isArray(rows) ? rows : [rows];
      const hit = arr.find(x => findDealId(x) === String(dealId));
      if (hit) {
        out.raw = hit;
        out.pnl = numericPnlFromObject(hit);
        if (finite(hit.level)) out.closeLevel = Number(hit.level);
        out.source = "transactions";
      }
    } catch (e) {}
  }
  return out;
}

function riskApproved(openCount) {
  resetDaily();
  if (!config.autoTrading || config.emergencyStop) return [false, "Automated trading is disabled or stopped"];
  if (openCount >= config.maxOpenTrades) return [false, `Open trade limit reached (${openCount}/${config.maxOpenTrades})`];
  if (daily.count >= config.maxTradesPerDay) return [false, `Daily trade limit reached (${daily.count}/${config.maxTradesPerDay})`];
  if (daily.realizedPnL <= -Math.abs(config.maxDailyLoss)) return [false, `Daily loss limit reached ($${Math.abs(daily.realizedPnL).toFixed(2)})`];
  if (lastTradeAt && Date.now() - lastTradeAt < config.cooldownSeconds * 1000) return [false, `Cooldown active (${Math.ceil((config.cooldownSeconds * 1000 - (Date.now() - lastTradeAt)) / 1000)}s)`];
  return [true, "OK"];
}

function upsertOpenFromBroker(p) {
  const dealId = p.position?.dealId;
  if (!dealId) return;
  const existing = ledger.find(t => t.dealId === String(dealId) && t.status === "OPEN");
  const pos = p.position || {};
  const market = p.market || {};
  if (existing) {
    existing.upl = finite(pos.upl) ? Number(pos.upl) : existing.upl;
    existing.lastSync = new Date().toISOString();
    existing.currentLevel = finite(pos.level) ? Number(pos.level) : existing.currentLevel;
    return;
  }
  ledger.unshift({
    id: `recovered-${dealId}`,
    dealId: String(dealId),
    direction: pos.direction,
    size: Number(pos.size),
    entry: Number(pos.level),
    stopLoss: null,
    takeProfit: null,
    openedAt: new Date().toISOString(),
    status: "OPEN",
    upl: finite(pos.upl) ? Number(pos.upl) : null,
    currentLevel: finite(pos.level) ? Number(pos.level) : null,
    epic: market.epic || EPIC,
    source: "broker-recovery",
    lastSync: new Date().toISOString()
  });
}

async function syncLedger() {
  const brokerPositions = await positions();
  const gold = brokerPositions.filter(p => (p.market?.epic || EPIC) === EPIC);
  const ids = new Set();
  for (const p of gold) {
    const dealId = p.position?.dealId;
    if (dealId) ids.add(String(dealId));
    upsertOpenFromBroker(p);
  }
  const openRows = ledger.filter(t => t.status === "OPEN");
  for (const trade of openRows) {
    if (ids.has(String(trade.dealId))) continue;
    const info = await brokerCloseInfo(trade.dealId);
    trade.status = "CLOSED";
    trade.closedAt = new Date().toISOString();
    trade.realizedPnL = info.pnl;
    trade.closeLevel = info.closeLevel;
    trade.closeInfoSource = info.source;
    if (info.pnl !== null) {
      resetDaily();
      daily.realizedPnL += Number(info.pnl);
    }
  }
  return gold;
}

async function executeSignal(signal, quote, m, current) {
  const signalId = `${current.id}:${signal}`;
  if (config.oneTradePerCandle && signalId === lastSignalId) return false;
  const open = (await positions()).filter(p => p.market?.epic === EPIC);
  const [allowed, reason] = riskApproved(open.length);
  if (!allowed) { lastSignal.reason = reason; return false; }
  if (m.atr < config.minAtr || m.atr > config.maxAtr) { lastSignal.reason = `ATR outside limits (${m.atr.toFixed(2)})`; return false; }
  if (quote.spread > config.maxSpread) { lastSignal.reason = `Spread too wide (${quote.spread})`; return false; }

  const stop = signal === "BUY" ? quote.price - m.atr * config.slAtr : quote.price + m.atr * config.slAtr;
  const limit = signal === "BUY" ? quote.price + m.atr * config.tpAtr : quote.price - m.atr * config.tpAtr;
  lastSignal.reason = "Opening broker position...";

  const result = await place(signal, config.fixedSize, stop, limit);
  const dealReference = result.dealReference || result.dealId || null;
  let confirmation = null;
  try { confirmation = await confirm(dealReference); } catch (e) { confirmation = { confirmationError: brokerError(e) }; }

  const affected = confirmation?.affectedDeals || result?.affectedDeals || [];
  const dealId = String(affected?.[0]?.dealId || confirmation?.dealId || result?.dealId || dealReference || `pending-${Date.now()}`);
  const trade = {
    id: `trade-${Date.now()}`,
    dealId,
    dealReference,
    direction: signal,
    size: config.fixedSize,
    entry: quote.price,
    stopLoss: +stop.toFixed(2),
    takeProfit: +limit.toFixed(2),
    spread: quote.spread,
    candle: current.id,
    openedAt: new Date().toISOString(),
    status: "OPEN",
    upl: null,
    realizedPnL: null,
    confirmation: confirmation ? {
      dealStatus: confirmation.dealStatus,
      level: confirmation.level,
      affectedDeals: confirmation.affectedDeals
    } : null
  };
  ledger.unshift(trade);
  lastSignalId = signalId;
  lastTradeAt = Date.now();
  daily.count++;
  lastSignal.reason = `BROKER TRADE OPENED · ${signal} · ${dealId}`;
  console.log("[TRADE OPEN]", JSON.stringify(trade));
  return true;
}

async function engineCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    resetDaily();
    const quote = await price();
    let brokerOpen = [];
    try { brokerOpen = await syncLedger(); } catch (e) { console.error("[LEDGER SYNC]", brokerError(e)); }
    const fresh = await loadCandles();
    if (fresh.length < 55) {
      lastSignal = { signal: "WAITING", reason: "Gathering broker candles", score: 0, details: { quote } };
      return;
    }
    candles = fresh;
    const current = candles[candles.length - 1];
    if (current.id === lastCandleId) return;
    lastCandleId = current.id;
    const values = candles.map(c => c.close);
    const m = {
      price: quote.price,
      spread: quote.spread,
      e9: ema(values, 9),
      e21: ema(values, 21),
      e50: ema(values, 50),
      rsi: rsi(values),
      atr: atr(candles),
      adx: adx(candles),
      momentum: momentum(candles),
      high: quote.high,
      low: quote.low
    };
    const signal = m.e9 > m.e21 && m.price > m.e50 && m.rsi > 55 ? "BUY" : m.e9 < m.e21 && m.price < m.e50 && m.rsi < 45 ? "SELL" : "WAITING";
    const points = signal === "WAITING" ? 0 : score(signal, m);
    lastSignal = { signal, reason: signal === "WAITING" ? "Indicators are not aligned" : `Score ${points}/85`, score: points, details: m, candle: current.id };
    if (signal === "WAITING") return;
    if (points < config.minScore) { lastSignal.reason = `Score ${points}/85 below minimum ${config.minScore}`; return; }
    if (!config.autoTrading || config.emergencyStop) { lastSignal.reason = "Auto trading is OFF"; return; }
    await executeSignal(signal, quote, m, current);
  } catch (error) {
    console.error("[ENGINE]", brokerError(error));
    lastSignal.reason = "Engine error; trade blocked";
  } finally {
    cycleRunning = false;
  }
}

function performanceRows() {
  const closed = ledger.filter(t => t.status === "CLOSED");
  const withPnl = closed.filter(t => finite(t.realizedPnL));
  const wins = withPnl.filter(t => Number(t.realizedPnL) > 0);
  const losses = withPnl.filter(t => Number(t.realizedPnL) < 0);
  const grossProfit = wins.reduce((a, t) => a + Number(t.realizedPnL), 0);
  const grossLoss = losses.reduce((a, t) => a + Number(t.realizedPnL), 0);
  const net = grossProfit + grossLoss;
  return {
    totalClosed: closed.length,
    pnlKnownTrades: withPnl.length,
    wins: wins.length,
    losses: losses.length,
    winRate: withPnl.length ? +(wins.length / withPnl.length * 100).toFixed(2) : null,
    grossProfit: +grossProfit.toFixed(2),
    grossLoss: +grossLoss.toFixed(2),
    netPnL: +net.toFixed(2),
    profitFactor: grossLoss < 0 ? +(grossProfit / Math.abs(grossLoss)).toFixed(2) : null,
    averageWin: wins.length ? +(grossProfit / wins.length).toFixed(2) : 0,
    averageLoss: losses.length ? +(grossLoss / losses.length).toFixed(2) : 0,
    openTrades: ledger.filter(t => t.status === "OPEN").length,
    unknownPnL: closed.length - withPnl.length,
    takeProfits: withPnl.filter(t => Number(t.realizedPnL) > 0).length,
    stopLosses: withPnl.filter(t => Number(t.realizedPnL) < 0).length,
    note: withPnl.length < closed.length ? "Some closed trades have no realized P/L field available from the broker history response." : ""
  };
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (req, res) => res.json({ ok: true, mode: DEMO ? "DEMO" : "LIVE", autoTrading: config.autoTrading, resolution: RESOLUTION }));
app.get("/engine/status", async (req, res) => {
  try {
    const [gold, currentPositions, accountInfo] = await Promise.all([price(), positions(), account()]);
    res.json({ ok: true, system: { mode: DEMO ? "DEMO" : "LIVE", autoTrading: config.autoTrading, resolution: RESOLUTION, quote: gold, positions: currentPositions, account: accountInfo, lastSignal, performance: performanceRows(), ledgerOpen: ledger.filter(t => t.status === "OPEN") } });
  } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); }
});
app.get("/engine/signal", (req, res) => res.json({ ok: true, signal: lastSignal }));
app.get("/engine/history", auth, (req, res) => res.json({ ok: true, history: ledger }));
app.get("/engine/ledger", auth, async (req, res) => { try { await syncLedger(); res.json({ ok: true, ledger, performance: performanceRows() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)), ledger, performance: performanceRows() }); } });
app.get("/engine/performance", auth, async (req, res) => { try { await syncLedger(); res.json({ ok: true, performance: performanceRows(), daily, ledger: ledger.slice(0, 100) }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)), performance: performanceRows() }); } });
app.post("/engine/start", auth, (req, res) => { config.autoTrading = true; config.emergencyStop = false; res.json({ ok: true, message: "Automated trading enabled", config }); });
app.post("/engine/stop", auth, (req, res) => { config.autoTrading = false; config.emergencyStop = true; res.json({ ok: true, message: "Emergency stop activated", config }); });
app.post("/engine/config", auth, (req, res) => {
  const allowed = ["maxOpenTrades", "maxTradesPerDay", "maxDailyLoss", "riskPercent", "maxSpread", "minScore", "cooldownSeconds", "slAtr", "tpAtr", "maxAtr", "minAtr", "fixedSize"];
  const updates = {};
  for (const key of allowed) if (req.body[key] !== undefined) updates[key] = Number(req.body[key]);
  Object.assign(config, updates);
  res.json({ ok: true, config });
});
app.get("/capital/price", auth, async (req, res) => { try { res.json({ ok: true, gold: await price() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.get("/capital/account", auth, async (req, res) => { try { res.json({ ok: true, account: await account() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.get("/capital/positions", auth, async (req, res) => { try { res.json({ ok: true, positions: await positions() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.post("/capital/trade", auth, async (req, res) => { try { const { direction, size, stopLevel, profitLevel } = req.body; const result = await place(direction, Number(size), Number(stopLevel), Number(profitLevel)); let confirmation = null; try { confirmation = await confirm(result.dealReference); } catch (e) { confirmation = { confirmationError: brokerError(e) }; } res.json({ ok: true, result, confirmation }); } catch (e) { res.status(400).json({ ok: false, error: String(brokerError(e)) }); } });
app.delete("/capital/positions/:dealId", auth, async (req, res) => { try { res.json({ ok: true, result: await close(req.params.dealId) }); } catch (e) { res.status(400).json({ ok: false, error: String(brokerError(e)) }); } });

app.get("/performance", (req, res) => {
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>GoldWebTrader PRO AI Performance</title><style>body{font-family:Arial,sans-serif;background:#0b1020;color:#fff;margin:0;padding:20px}h1{font-size:24px}input,button{padding:12px;border-radius:8px;border:1px solid #334;background:#121a2e;color:#fff}button{cursor:pointer}button{margin-left:6px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:18px}.card{background:#121a2e;border:1px solid #263451;border-radius:12px;padding:14px}.v{font-size:22px;font-weight:bold;margin-top:6px}.muted{color:#9ca9c5;font-size:13px}.ok{margin:14px 0;padding:10px;border-radius:8px;background:#132a22;color:#8ef0bf}.warn{background:#302715;color:#ffd98a}.table{margin-top:18px;overflow:auto}table{width:100%;border-collapse:collapse;background:#121a2e}th,td{padding:9px;border-bottom:1px solid #263451;text-align:left;white-space:nowrap}</style></head><body><h1>📊 GOLDWEBTRADER PRO AI</h1><div class="muted">Capital.com Gold automated trade ledger</div><p><input id="key" type="password" placeholder="Dashboard API Key"><button onclick="save()">🔐 Save Key</button><button onclick="load()">🔄 Refresh</button></p><div id="msg" class="ok">Enter your Dashboard API Key.</div><div id="grid" class="grid"></div><div id="table" class="table"></div><script>const K='gold_api_key';function save(){localStorage.setItem(K,document.getElementById('key').value);load()}async function load(){const k=localStorage.getItem(K)||document.getElementById('key').value;if(!k){msg('Enter your Dashboard API Key.','warn');return}document.getElementById('key').value=k;try{const r=await fetch('/engine/performance',{headers:{'x-api-key':k}});const j=await r.json();if(!r.ok)throw new Error(j.error||'Unauthorized');const p=j.performance;msg('Ledger synced · '+new Date().toLocaleTimeString());const cards=[['Total Closed',p.totalClosed],['P/L Known',p.pnlKnownTrades],['Win Rate',p.winRate===null?'—':p.winRate+'%'],['Wins',p.wins],['Losses',p.losses],['Gross Profit','$'+p.grossProfit.toFixed(2)],['Gross Loss','$'+p.grossLoss.toFixed(2)],['Net P/L','$'+p.netPnL.toFixed(2)],['Profit Factor',p.profitFactor===null?'—':p.profitFactor],['Average Win','$'+p.averageWin.toFixed(2)],['Average Loss','$'+p.averageLoss.toFixed(2)],['Open Trades',p.openTrades],['Unknown P/L',p.unknownPnL]];grid.innerHTML=cards.map(x=>'<div class="card"><div class="muted">'+x[0]+'</div><div class="v">'+x[1]+'</div></div>').join('');if(p.note)msg(p.note,'warn');const rows=(j.ledger||[]).map(t=>'<tr><td>'+t.status+'</td><td>'+t.direction+'</td><td>'+t.size+'</td><td>'+t.entry+'</td><td>'+(t.realizedPnL===null?'—':t.realizedPnL.toFixed(2))+'</td><td>'+t.dealId+'</td></tr>').join('');table.innerHTML='<table><thead><tr><th>Status</th><th>Side</th><th>Size</th><th>Entry</th><th>Realized P/L</th><th>Deal ID</th></tr></thead><tbody>'+rows+'</tbody></table>'}catch(e){msg(e.message,'warn')}}function msg(t,c){const m=document.getElementById('msg');m.textContent=t;m.className=c==='warn'?'warn':''}load()</script></body></html>`);
});

app.use(express.static(path.join(__dirname, "public")));
setInterval(engineCycle, POLL_MS);
app.listen(PORT, () => console.log(`GoldWebTrader Pro AI listening on ${PORT} (${DEMO ? "DEMO" : "LIVE"})`));
