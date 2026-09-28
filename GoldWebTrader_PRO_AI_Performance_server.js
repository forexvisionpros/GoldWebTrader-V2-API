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
  maxTradesPerDay: Number(process.env.MAX_TRADES_PER_DAY || "20"),
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS || 100),
  riskPercent: Number(process.env.RISK_PERCENT_PER_TRADE || 0.25),
  fixedSize: Number(process.env.MAX_RISK_PER_TRADE || 0.1),
  maxSpread: Number(process.env.MAX_SPREAD || 1.0),
  minScore: Number(process.env.MIN_SNIPER_SCORE || 85),
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
function brokerError(error) { return error.response?.data || error.code || error.message; }

async function getSession(force = false) {
  if (!force && session && Date.now() - session.created < 5 * 60 * 1000) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = axios.post(`${BASE_URL}/session`, {
    identifier: process.env.CAPITAL_IDENTIFIER,
    password: process.env.CAPITAL_PASSWORD
  }, { timeout: 10000, headers: { "X-CAP-API-KEY": process.env.CAPITAL_API_KEY } }).then(response => {
    session = { cst: response.headers.cst, securityToken: response.headers["x-security-token"], accountId: response.data.currentAccountId, account: response.data, created: Date.now() };
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
      return await axios({ method, url: `${BASE_URL}${url}`, data, timeout: 10000, headers: { CST: s.cst, "X-SECURITY-TOKEN": s.securityToken, "Content-Type": "application/json" } });
    } catch (error) {
      const status = error.response?.status;
      if (!retried && status === 401) { retried = true; session = null; continue; }
      if (status === 429 || status >= 500) error.message = `Broker temporary error (${status}): ${JSON.stringify(brokerError(error))}`;
      throw error;
    }
  }
}
async function price() {
  const response = await brokerRequest("GET", `/markets/${EPIC}`), m = response.data.marketDetails || response.data, s = m.snapshot || m;
  const bid = Number(s.bid), offer = Number(s.offer);
  if (!Number.isFinite(bid) || !Number.isFinite(offer)) throw new Error("Broker returned an invalid Gold quote");
  return { bid, offer, price: (bid + offer) / 2, spread: +(offer - bid).toFixed(2), high: Number(s.high), low: Number(s.low), time: Date.now() };
}
async function loadCandles() {
  const response = await brokerRequest("GET", `/prices/${EPIC}?resolution=${encodeURIComponent(RESOLUTION)}&max=200`), raw = response.data.prices || [];
  return raw.map((x, i) => ({ id: x.snapshotTime || x.snapshotTimeUTC || String(i), open: Number(x.openPrice?.bid ?? x.openPrice ?? x.open), high: Number(x.highPrice?.bid ?? x.highPrice ?? x.high), low: Number(x.lowPrice?.bid ?? x.lowPrice ?? x.low), close: Number(x.closePrice?.bid ?? x.closePrice ?? x.close), time: x.snapshotTime || x.snapshotTimeUTC || Date.now() + i }));
}
function ema(values, period) { if (values.length < period) return null; const k = 2 / (period + 1); let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period; for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k); return value; }
function rsi(values, period = 14) { if (values.length <= period) return 50; let gain = 0, loss = 0; for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; d >= 0 ? gain += d : loss -= d; } let avgGain = gain / period, avgLoss = loss / period || 1e-9; for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period; avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period; } const rs = avgGain / avgLoss; return 100 - 100 / (1 + rs); }
function atr(data, period = 14) { if (data.length < period + 1) return null; const tr = data.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - data[i].close), Math.abs(c.low - data[i].close))); let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period; for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]) / period; return value; }
function adx(data, period = 14) { if (data.length < period + 1) return null; const moves = data.slice(-period).map((c, i, a) => i ? Math.abs(c.close - a[i - 1].close) : 0); return Math.min(100, moves.reduce((a, b) => a + b, 0) / period * 10); }
function score(signal, m) { let value = 0; if ((signal === "BUY" && m.price > m.e50) || (signal === "SELL" && m.price < m.e50)) value += 20; if ((signal === "BUY" && m.e9 > m.e21) || (signal === "SELL" && m.e9 < m.e21)) value += 20; if ((signal === "BUY" && m.rsi > 55) || (signal === "SELL" && m.rsi < 45)) value += 15; if (m.atr && m.atr > 0) value += 10; return value; }
async function positions() { return (await brokerRequest("GET", "/positions")).data.positions || []; }
async function account() { return (await brokerRequest("GET", "/accounts")).data; }


// ============================================================
// PERFORMANCE / BROKER HISTORY
// Capital.com exposes account activity and transaction history.
// The API limits history/activity date windows to 1 day, so this
// dashboard deliberately reports a selectable 24-hour window.
// ============================================================
async function historyTransactions(lastPeriod = 86400) {
  const period = Math.max(60, Math.min(Number(lastPeriod) || 86400, 86400));
  const response = await brokerRequest("GET", `/history/transactions?lastPeriod=${period}&type=TRADE`);
  return Array.isArray(response.data?.transactions) ? response.data.transactions : [];
}

async function historyActivity(lastPeriod = 86400) {
  const period = Math.max(60, Math.min(Number(lastPeriod) || 86400, 86400));
  const response = await brokerRequest(
    "GET",
    `/history/activity?lastPeriod=${period}&detailed=true&filter=epic==${encodeURIComponent(EPIC)}`
  );
  return Array.isArray(response.data?.activities) ? response.data.activities : [];
}

function numberFrom(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function nestedObjects(obj) {
  return [obj, obj?.details, obj?.activityDetails, obj?.deal, obj?.position, obj?.transaction].filter(Boolean);
}

function extractPnL(item) {
  const keys = [
    "profitLoss", "profit", "pnl", "PnL", "realizedProfitLoss", "realisedProfitLoss",
    "profitAndLoss", "cashAmount", "cashTransactionAmount", "amount"
  ];
  for (const obj of nestedObjects(item)) {
    const n = numberFrom(obj, keys);
    if (n !== null) return n;
  }
  return null;
}

function extractDate(item) {
  for (const obj of nestedObjects(item)) {
    for (const key of ["dateUTC", "dateUtc", "date", "timestamp", "time"]) {
      if (obj?.[key]) return obj[key];
    }
  }
  return null;
}

function extractDealId(item) {
  for (const obj of nestedObjects(item)) {
    for (const key of ["dealId", "dealReference", "reference"]) {
      if (obj?.[key]) return String(obj[key]);
    }
  }
  return null;
}

function extractDirection(item) {
  for (const obj of nestedObjects(item)) {
    if (obj?.direction) return String(obj.direction).toUpperCase();
  }
  return null;
}

function extractSource(item) {
  return String(item?.source || item?.details?.source || "").toUpperCase();
}

async function performance(lastPeriod = 86400) {
  resetDaily();
  const period = Math.max(60, Math.min(Number(lastPeriod) || 86400, 86400));
  const [transactions, activities, accountInfo] = await Promise.all([
    historyTransactions(period),
    historyActivity(period),
    account()
  ]);

  const goldTransactions = transactions.filter(t => {
    const name = String(t.instrumentName || t.epic || "").toUpperCase();
    return !name || name === EPIC || name === "GOLD";
  });

  const goldActivities = activities.filter(a => {
    const epic = String(a.epic || a.details?.epic || "").toUpperCase();
    return !epic || epic === EPIC;
  });

  const closedEvents = goldActivities.filter(a => {
    const status = String(a.status || "").toUpperCase();
    const type = String(a.type || "").toUpperCase();
    return status === "EXECUTED" && type === "POSITION";
  });

  const tpCount = closedEvents.filter(a => extractSource(a) === "TP").length;
  const slCount = closedEvents.filter(a => extractSource(a) === "SL").length;

  const pnlValues = [];
  for (const item of [...goldTransactions, ...closedEvents]) {
    const pnl = extractPnL(item);
    if (pnl !== null && Math.abs(pnl) < 1000000) pnlValues.push({ item, pnl });
  }

  // Avoid double-counting if the same deal appears in both endpoints.
  const seen = new Set();
  let realizedPnL = 0;
  let pnlCount = 0;
  for (const row of pnlValues) {
    const id = extractDealId(row.item);
    const key = id ? `${id}:${row.pnl}` : `${extractDate(row.item)}:${row.pnl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    realizedPnL += row.pnl;
    pnlCount++;
  }

  const wins = pnlValues.filter(x => x.pnl > 0).length;
  const losses = pnlValues.filter(x => x.pnl < 0).length;
  const grossProfit = pnlValues.filter(x => x.pnl > 0).reduce((a, x) => a + x.pnl, 0);
  const grossLoss = Math.abs(pnlValues.filter(x => x.pnl < 0).reduce((a, x) => a + x.pnl, 0));
  const totalClosed = Math.max(pnlCount, tpCount + slCount);
  const winRate = pnlCount ? (wins / pnlCount) * 100 : null;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  return {
    ok: true,
    periodSeconds: period,
    periodLabel: period >= 86400 ? "24 Hours" : `${Math.round(period / 3600)} Hours`,
    epic: EPIC,
    currency: accountInfo?.currencyIsoCode || accountInfo?.currency || "USD",
    totalClosedTrades: totalClosed,
    wins,
    losses,
    winRate: winRate === null ? null : +winRate.toFixed(2),
    grossProfit: +grossProfit.toFixed(2),
    grossLoss: +grossLoss.toFixed(2),
    realizedPnL: +realizedPnL.toFixed(2),
    profitFactor: profitFactor === null ? null : +profitFactor.toFixed(2),
    averageWin: wins ? +(grossProfit / wins).toFixed(2) : 0,
    averageLoss: losses ? +(grossLoss / losses).toFixed(2) : 0,
    takeProfits: tpCount,
    stopLosses: slCount,
    pnlDataAvailable: pnlCount > 0,
    brokerTransactionCount: goldTransactions.length,
    brokerActivityCount: goldActivities.length,
    account: accountInfo,
    note: pnlCount ? "Realized P/L calculated from broker history fields returned by Capital.com." : "Capital.com history returned trade/activity records but no usable realized P/L field; counts remain available."
  };
}

const performanceHtml = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GoldWebTrader Performance</title>
<style>
body{margin:0;background:#080d19;color:#f5f7ff;font-family:system-ui,sans-serif;padding:18px}.wrap{max-width:1050px;margin:auto}
.card{background:#121a2b;border:1px solid #263451;border-radius:18px;padding:18px;margin-bottom:15px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stat{background:#0d1424;border-radius:14px;padding:14px}.num{font-size:24px;font-weight:800;margin-top:5px}
.muted{color:#9aa8c2}.good{color:#65d98a}.bad{color:#ff8585}.btn{padding:12px 16px;border:0;border-radius:10px;background:#6658e8;color:white;font-weight:700}
@media(max-width:750px){.grid{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
<div class="card"><h1>📊 GOLDWEBTRADER PRO AI</h1><p class="muted">Capital.com Gold performance · 24-hour broker history</p><button class="btn" onclick="load()">🔄 Refresh</button><p id="status" class="muted">Loading...</p></div>
<div class="grid">
<div class="stat">Total Closed<div id="total" class="num">—</div></div><div class="stat">Win Rate<div id="winrate" class="num">—</div></div>
<div class="stat">Wins<div id="wins" class="num">—</div></div><div class="stat">Losses<div id="losses" class="num">—</div></div>
<div class="stat">Gross Profit<div id="gp" class="num good">—</div></div><div class="stat">Gross Loss<div id="gl" class="num bad">—</div></div>
<div class="stat">Net P/L<div id="net" class="num">—</div></div><div class="stat">Profit Factor<div id="pf" class="num">—</div></div>
<div class="stat">Average Win<div id="aw" class="num">—</div></div><div class="stat">Average Loss<div id="al" class="num">—</div></div>
<div class="stat">Take Profits<div id="tp" class="num">—</div></div><div class="stat">Stop Losses<div id="sl" class="num">—</div></div>
</div><div class="card"><h2>Broker data</h2><p id="note" class="muted">—</p></div></div>
<script>
const money=n=>n===null||n===undefined?'—':'$'+Number(n).toFixed(2); const val=n=>n===null||n===undefined?'—':n;
async function load(){try{const r=await fetch('/engine/performance');const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');
 document.getElementById('total').textContent=val(d.totalClosedTrades);document.getElementById('winrate').textContent=d.winRate==null?'—':d.winRate+'%';
 document.getElementById('wins').textContent=d.wins;document.getElementById('losses').textContent=d.losses;document.getElementById('gp').textContent=money(d.grossProfit);document.getElementById('gl').textContent=money(-d.grossLoss);document.getElementById('net').textContent=money(d.realizedPnL);document.getElementById('pf').textContent=val(d.profitFactor);document.getElementById('aw').textContent=money(d.averageWin);document.getElementById('al').textContent=money(-d.averageLoss);document.getElementById('tp').textContent=d.takeProfits;document.getElementById('sl').textContent=d.stopLosses;document.getElementById('note').textContent=d.note;document.getElementById('status').textContent='Broker history loaded · '+d.periodLabel;}
catch(e){document.getElementById('status').textContent='Error: '+e.message;}}load();setInterval(load,30000);
</script></body></html>`;
async function place(direction, size, stop, limit) { return (await brokerRequest("POST", "/positions", { epic: EPIC, direction, size, guaranteedStop: false, stopLevel: +stop.toFixed(2), profitLevel: +limit.toFixed(2) })).data; }
async function close(dealId) { return (await brokerRequest("DELETE", `/positions/${encodeURIComponent(dealId)}`)).data; }
function riskApproved(openCount) { resetDaily(); if (!config.autoTrading || config.emergencyStop) return [false, "Automated trading is disabled or stopped"]; if (openCount >= config.maxOpenTrades) return [false, `Open trade limit reached (${openCount}/${config.maxOpenTrades})`]; if (daily.count >= config.maxTradesPerDay) return [false, `Daily trade limit reached (${daily.count}/${config.maxTradesPerDay})`]; return [true, "OK"]; }

async function engineCycle() {
  if (cycleRunning) return; cycleRunning = true;
  try {
    const quote = await price(), fresh = await loadCandles();
    if (fresh.length < 55) { lastSignal = { signal: "WAITING", reason: "Gathering broker candles", score: 0, details: { quote } }; return; }
    candles = fresh; const current = candles[candles.length - 1]; if (current.id === lastCandleId) return; lastCandleId = current.id;
    const values = candles.map(c => c.close), m = { price: quote.price, spread: quote.spread, e9: ema(values, 9), e21: ema(values, 21), e50: ema(values, 50), rsi: rsi(values), atr: atr(candles), high: quote.high, low: quote.low };
    const signal = m.e9 > m.e21 && m.price > m.e50 && m.rsi > 55 ? "BUY" : m.e9 < m.e21 && m.price < m.e50 && m.rsi < 45 ? "SELL" : "WAITING", points = signal === "WAITING" ? 0 : score(signal, m);
    lastSignal = { signal, reason: signal === "WAITING" ? "Indicators are not aligned" : `Score ${points}/${config.minScore}`, score: points, details: m, candle: current.id };
    if (signal === "WAITING" || points < config.minScore || quote.spread > config.maxSpread || !m.atr) return;
    const signalId = `${current.id}:${signal}`; if (config.oneTradePerCandle && signalId === lastSignalId) return;
    const open = (await positions()).filter(p => p.market?.epic === EPIC), [allowed, reason] = riskApproved(open.length); if (!allowed) { lastSignal.reason = reason; return; }
    const s = signal === "BUY" ? quote.price - m.atr * config.slAtr : quote.price + m.atr * config.slAtr, t = signal === "BUY" ? quote.price + m.atr * config.tpAtr : quote.price - m.atr * config.tpAtr;
    lastSignalId = signalId; lastTradeAt = Date.now(); daily.count++; trades.unshift({ time: new Date().toISOString(), direction: signal, size: config.fixedSize, entry: quote.price, stopLoss: s, takeProfit: t, spread: quote.spread, candle: current.id });
  } catch (error) { console.error("[ENGINE]", brokerError(error)); lastSignal.reason = "Engine error; trade blocked"; } finally { cycleRunning = false; }
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (req, res) => res.json({ ok: true, mode: DEMO ? "DEMO" : "LIVE", autoTrading: config.autoTrading, resolution: RESOLUTION }));
app.get("/engine/status", async (req, res) => { try { const [gold, currentPositions, accountInfo] = await Promise.all([price(), positions(), account()]); res.json({ ok: true, system: { mode: DEMO ? "DEMO" : "LIVE", autoTrading: config.autoTrading, resolution: RESOLUTION, quote: gold, positions: currentPositions, account: accountInfo, lastSignal, inMemoryTrades: trades.length } }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.get("/engine/signal", (req, res) => res.json({ ok: true, signal: lastSignal }));
app.get("/engine/history", auth, (req, res) => res.json({ ok: true, history: trades }));
app.get("/engine/performance", auth, async (req, res) => { try { res.json(await performance(req.query.period || 86400)); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.get("/performance", (req, res) => res.type("html").send(performanceHtml));
app.post("/engine/start", auth, (req, res) => { config.autoTrading = true; config.emergencyStop = false; res.json({ ok: true, message: "Automated trading enabled", config }); });
app.post("/engine/stop", auth, (req, res) => { config.autoTrading = false; config.emergencyStop = true; res.json({ ok: true, message: "Emergency stop activated", config }); });
app.post("/engine/config", auth, (req, res) => { const allowed = ["maxOpenTrades", "maxTradesPerDay", "maxDailyLoss", "riskPercent", "maxSpread", "minScore", "cooldownSeconds", "slAtr", "tpAtr"]; const updates = {}; for (const key of allowed) if (req.body[key] !== undefined) updates[key] = Number(req.body[key]); Object.assign(config, updates); res.json({ ok: true, config }); });
app.get("/capital/price", auth, async (req, res) => { try { res.json({ ok: true, gold: await price() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.get("/capital/account", auth, async (req, res) => { try { res.json({ ok: true, account: await account() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.get("/capital/positions", auth, async (req, res) => { try { res.json({ ok: true, positions: await positions() }); } catch (e) { res.status(502).json({ ok: false, error: String(brokerError(e)) }); } });
app.post("/capital/trade", auth, async (req, res) => { try { const { direction, size, stopLevel, profitLevel } = req.body; res.json({ ok: true, result: await place(direction, Number(size), Number(stopLevel), Number(profitLevel)) }); } catch (e) { res.status(400).json({ ok: false, error: String(brokerError(e)) }); } });
app.delete("/capital/positions/:dealId", auth, async (req, res) => { try { res.json({ ok: true, result: await close(req.params.dealId) }); } catch (e) { res.status(400).json({ ok: false, error: String(brokerError(e)) }); } });
app.use(express.static(path.join(__dirname, "public")));
setInterval(engineCycle, POLL_MS);
app.listen(PORT, () => console.log(`GoldWebTrader Pro AI listening on ${PORT} (${DEMO ? "DEMO" : "LIVE"})`));
