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
  maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY || 5),
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS || 100),
  riskPercent: Number(process.env.RISK_PERCENT_PER_TRADE || 0.25),
  fixedSize: Number(process.env.MAX_RISK_PER_TRADE || 0.1),
  maxSpread: Number(process.env.MAX_SPREAD || 1.5),
  minScore: Number(process.env.MIN_SNIPER_SCORE || 75),
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 300),
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
let trades = [];
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

function brokerError(error) {
  return error.response?.data || error.code || error.message;
}

async function getSession(force = false) {
  if (!force && session && Date.now() - session.created < 5 * 60 * 1000) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = axios.post(`${BASE_URL}/session`, {
    identifier: process.env.CAPITAL_IDENTIFIER,
    password: process.env.CAPITAL_PASSWORD
  }, {
    timeout: 10000,
    headers: { "X-CAP-API-KEY": process.env.CAPITAL_API_KEY }
  }).then(response => {
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
      return await axios({ method, url: `${BASE_URL}${url}`, data, timeout: 10000, headers: {
        CST: s.cst, "X-SECURITY-TOKEN": s.securityToken, "Content-Type": "application/json"
      }});
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
    close: Number(x.closePrice?.bid ?? x.closePrice ?? x.close)
  })).filter(x => [x.open, x.high, x.low, x.close].every(Number.isFinite));
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1); let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}
function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; d >= 0 ? gain += d : loss -= d; }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; ag = (ag * 13 + Math.max(d, 0)) / 14; al = (al * 13 + Math.max(-d, 0)) / 14; }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function atr(data, period = 14) {
  if (data.length < period + 1) return null;
  const tr = data.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - data[i].close), Math.abs(c.low - data[i].close)));
  return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function adx(data, period = 14) {
  if (data.length < period + 1) return null;
  const moves = data.slice(-period).map((c, i, a) => i ? Math.abs(c.close - a[i - 1].close) : 0);
  return Math.min(100, Math.max(0, moves.reduce((a, b) => a + b, 0) / period * 12));
}
function score(signal, m) {
  let value = 0;
  if ((signal === "BUY" && m.price > m.e50) || (signal === "SELL" && m.price < m.e50)) value += 20;
  if ((signal === "BUY" && m.e9 > m.e21) || (signal === "SELL" && m.e9 < m.e21)) value += 20;
  if ((signal === "BUY" && m.rsi > 55) || (signal === "SELL" && m.rsi < 45)) value += 15;
  if (m.adx >= 20) value += 15;
  if (m.atr >= config.minAtr && m.atr <= config.maxAtr) value += 10;
  if (m.spread <= config.maxSpread) value += 10;
  return value;
}

async function positions() { return (await brokerRequest("GET", "/positions")).data.positions || []; }
async function account() { return (await brokerRequest("GET", "/accounts")).data; }
async function place(direction, size, stop, limit) {
  const response = await brokerRequest("POST", "/positions", { epic: EPIC, direction, size, guaranteedStop: false, stopLevel: +stop.toFixed(2), profitLevel: +limit.toFixed(2) });
  return response.data;
}
async function close(dealId) { return (await brokerRequest("DELETE", `/positions/${encodeURIComponent(dealId)}`)).data; }

function riskApproved(openCount) {
  resetDaily();
  if (!config.autoTrading || config.emergencyStop) return [false, "Automated trading is disabled or stopped"];
  if (openCount >= config.maxOpenTrades) return [false, "Maximum open trades reached"];
  if (daily.count >= config.maxTradesPerDay) return [false, "Daily trade limit reached"];
  if (daily.realizedPnL <= -Math.abs(config.maxDailyLoss)) return [false, "Daily loss limit reached"];
  if ((Date.now() - lastTradeAt) / 1000 < config.cooldownSeconds) return [false, "Cooldown active"];
  return [true, "Risk checks passed"];
}

async function engineCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    const quote = await price();
    const fresh = await loadCandles();
    if (fresh.length < 55) { lastSignal = { signal: "WAITING", reason: "Gathering broker candles", score: 0, details: { quote } }; return; }
    candles = fresh;
    const current = candles[candles.length - 1];
    if (current.id === lastCandleId) return;
    lastCandleId = current.id;
    const values = candles.map(c => c.close), m = { price: quote.price, spread: quote.spread, e9: ema(values, 9), e21: ema(values, 21), e50: ema(values, 50), rsi: rsi(values), atr: atr(candles), adx: adx(candles) };
    const signal = m.e9 > m.e21 && m.price > m.e50 && m.rsi > 55 ? "BUY" : m.e9 < m.e21 && m.price < m.e50 && m.rsi < 45 ? "SELL" : "WAITING";
    const points = signal === "WAITING" ? 0 : score(signal, m);
    lastSignal = { signal, reason: signal === "WAITING" ? "Indicators are not aligned" : `Score ${points}/${config.minScore}`, score: points, details: m, candle: current.id };
    if (signal === "WAITING" || points < config.minScore || quote.spread > config.maxSpread || !m.atr) return;
    const signalId = `${current.id}:${signal}`;
    if (config.oneTradePerCandle && signalId === lastSignalId) return;
    const open = (await positions()).filter(p => p.market?.epic === EPIC);
    const [allowed, reason] = riskApproved(open.length);
    if (!allowed) { lastSignal.reason = reason; return; }
    const s = signal === "BUY" ? quote.price - m.atr * config.slAtr : quote.price + m.atr * config.slAtr;
    const t = signal === "BUY" ? quote.price + m.atr * config.tpAtr : quote.price - m.atr * config.tpAtr;
    const result = await place(signal, config.fixedSize, s, t);
    lastSignalId = signalId; lastTradeAt = Date.now(); daily.count++;
    trades.unshift({ time: new Date().toISOString(), direction: signal, size: config.fixedSize, entry: quote.price, stopLoss: s, takeProfit: t, score: points, dealReference: result.dealReference || result.dealId });
    lastSignal.reason = "Trade placed with broker-side TP and SL";
  } catch (error) { console.error("[ENGINE]", brokerError(error)); lastSignal.reason = "Engine error; trade blocked"; }
  finally { cycleRunning = false; }
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (req, res) => res.json({ ok: true, mode: DEMO ? "DEMO" : "LIVE", autoTrading: config.autoTrading, resolution: RESOLUTION }));
app.get("/engine/status", async (req, res) => { try { res.json({ ok: true, system: { mode: DEMO ? "DEMO" : "LIVE", autoTrading: config.autoTrading, emergencyStop: config.emergencyStop, resolution: RESOLUTION }, signal: lastSignal, daily, positions: await positions() }); } catch (e) { res.status(500).json({ ok: false, error: String(brokerError(e)) }); } });
app.get("/engine/signal", (req, res) => res.json({ ok: true, signal: lastSignal }));
app.get("/engine/history", auth, (req, res) => res.json({ ok: true, history: trades }));
app.post("/engine/start", auth, (req, res) => { config.autoTrading = true; config.emergencyStop = false; res.json({ ok: true, config }); });
app.post("/engine/stop", auth, (req, res) => { config.autoTrading = false; config.emergencyStop = true; res.json({ ok: true, config }); });
app.post("/engine/config", auth, (req, res) => { const allowed = ["maxOpenTrades", "maxTradesPerDay", "maxDailyLoss", "riskPercent", "maxSpread", "minScore", "cooldownSeconds", "slAtr", "tpAtr"]; for (const key of allowed) if (req.body[key] !== undefined) config[key] = Number(req.body[key]); res.json({ ok: true, config }); });
app.get("/capital/price", auth, async (req, res) => { try { res.json({ ok: true, gold: await price() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.get("/capital/account", auth, async (req, res) => { try { res.json({ ok: true, account: await account() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.get("/capital/positions", auth, async (req, res) => { try { res.json({ ok: true, positions: await positions() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.post("/capital/trade", auth, async (req, res) => { try { const { direction, size, stopLevel, profitLevel } = req.body; res.json({ ok: true, result: await place(direction, Number(size), Number(stopLevel), Number(profitLevel)) }); } catch (e) { res.status(400).json({ ok: false, error: String(brokerError(e)) }); } });
app.delete("/capital/positions/:dealId", auth, async (req, res) => { try { res.json({ ok: true, result: await close(req.params.dealId) }); } catch (e) { res.status(400).json({ ok: false, error: String(brokerError(e)) }); } });
app.use(express.static(path.join(__dirname, "public")));

setInterval(engineCycle, POLL_MS);
app.listen(PORT, () => console.log(`GoldWebTrader Pro AI listening on ${PORT} (${DEMO ? "DEMO" : "LIVE"})`));
