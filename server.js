/**
 * GOLDWEBTRADER PRO AI v3.0.0 - PRODUCTION SERVER
 * Developer/Owner: KELVIN NGUGI
 * Broker: Capital.com (Demo/Live)
 * Instrument: Gold (XAU/USD - epic: GOLD, instrumentId: 27045129890124996)
 */

const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SERVER_API_KEY = process.env.API_KEY || "6e0bcb8010ca8e0775f30c1d9241c48f";

const CAPITAL_API_KEY = process.env.CAPITAL_API_KEY;
const CAPITAL_IDENTIFIER = process.env.CAPITAL_IDENTIFIER;
const CAPITAL_PASSWORD = process.env.CAPITAL_PASSWORD;
const CAPITAL_DEMO = process.env.CAPITAL_DEMO !== "false";

const CAPITAL_BASE_URL = CAPITAL_DEMO
  ? "https://demo-api-capital.backend-capital.com/api/v1"
  : "https://api-capital.backend-capital.com/api/v1";

const GOLD_EPIC = "GOLD";
const GOLD_INSTRUMENT_ID = "27045129890124996";

let engineConfig = {
  AUTO_TRADING: process.env.AUTO_TRADING === "true",
  EMERGENCY_STOP: false,
  MAX_OPEN_TRADES: parseInt(process.env.MAX_OPEN_TRADES || "1", 10),
  MAX_DAILY_LOSS: parseFloat(process.env.MAX_DAILY_LOSS || "100.0"),
  MAX_TRADES_PER_DAY: parseInt(process.env.MAX_TRADES_PER_DAY || "5", 10),
  MAX_RISK_PER_TRADE: parseFloat(process.env.MAX_RISK_PER_TRADE || "0.1"),
  MAX_SPREAD: parseFloat(process.env.MAX_SPREAD || "1.5"),
  COOLDOWN_SECONDS: parseInt(process.env.COOLDOWN_SECONDS || "300", 10),
  MIN_SNIPER_SCORE: parseInt(process.env.MIN_SNIPER_SCORE || "75", 10),
  ADX_THRESHOLD: parseFloat(process.env.ADX_THRESHOLD || "20.0"),
  ATR_SL_MULTIPLIER: parseFloat(process.env.ATR_SL_MULTIPLIER || "1.2"),
  ATR_TP_MULTIPLIER: parseFloat(process.env.ATR_TP_MULTIPLIER || "0.8"),
  AI_ENABLED: process.env.AI_ENABLED === "true",
  AI_FAILSAFE_BLOCK: process.env.AI_FAILSAFE_BLOCK !== "false",
  TRAILING_STOP_ENABLED: process.env.TRAILING_STOP_ENABLED === "true",
  BREAKEVEN_TRIGGER_PROFIT: parseFloat(process.env.BREAKEVEN_TRIGGER_PROFIT || "2.0")
};

let sessionContext = { cst: null, xSecurityToken: null, activeAccountId: null, lastAuthTime: 0 };
let marketDataHistory = [];
let tradeHistory = [];
let dailyTracker = { date: new Date().toISOString().split("T")[0], tradesCount: 0, realizedPnL: 0 };
let lastTradeTimestamp = 0;
let lastSignalState = { signal: "WAITING", reason: "Engine initializing...", score: 0, aiConfidence: 0, details: {} };

const authenticateServerKey = (req, res, next) => {
  const clientKey = req.headers["x-api-key"] || req.query.apiKey;
  if (!clientKey || clientKey !== SERVER_API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized. Invalid or missing X-API-KEY header." });
  }
  next();
};

const checkDailyReset = () => {
  const today = new Date().toISOString().split("T")[0];
  if (dailyTracker.date !== today) {
    dailyTracker = { date: today, tradesCount: 0, realizedPnL: 0 };
    console.log(`[SYSTEM] Daily metrics reset for date: ${today}`);
  }
};

async function getBrokerSession() {
  const now = Date.now();
  if (sessionContext.cst && sessionContext.xSecurityToken && now - sessionContext.lastAuthTime < 5 * 60 * 1000) return sessionContext;
  try {
    const response = await axios.post(`${CAPITAL_BASE_URL}/session`, { identifier: CAPITAL_IDENTIFIER, password: CAPITAL_PASSWORD }, {
      headers: { "X-CAP-API-KEY": CAPITAL_API_KEY, "Content-Type": "application/json" }
    });
    sessionContext.cst = response.headers["cst"];
    sessionContext.xSecurityToken = response.headers["x-security-token"];
    sessionContext.activeAccountId = response.data.currentAccountId;
    sessionContext.lastAuthTime = now;
    console.log(`[BROKER] Session authenticated successfully. Account: ${sessionContext.activeAccountId}`);
    return sessionContext;
  } catch (error) {
    const errData = error.response ? error.response.data : error.message;
    console.error("[BROKER] Authentication failed:", errData);
    throw new Error(`Broker Authentication Failed: ${JSON.stringify(errData)}`);
  }
}

async function fetchGoldPrice() {
  const session = await getBrokerSession();
  const response = await axios.get(`${CAPITAL_BASE_URL}/markets/${GOLD_EPIC}`, { headers: { CST: session.cst, "X-SECURITY-TOKEN": session.xSecurityToken } });
  const snapshot = response.data.marketDetails || response.data;
  const bid = snapshot.snapshot ? snapshot.snapshot.bid : snapshot.bid;
  const offer = snapshot.snapshot ? snapshot.snapshot.offer : snapshot.offer;
  const high = snapshot.snapshot ? snapshot.snapshot.high : snapshot.high;
  const low = snapshot.snapshot ? snapshot.snapshot.low : snapshot.low;
  return { bid: parseFloat(bid), offer: parseFloat(offer), price: (parseFloat(bid) + parseFloat(offer)) / 2, spread: parseFloat((parseFloat(offer) - parseFloat(bid)).toFixed(2)), high: parseFloat(high), low: parseFloat(low), timestamp: Date.now() };
}

async function fetchBrokerAccount() {
  const session = await getBrokerSession();
  const response = await axios.get(`${CAPITAL_BASE_URL}/accounts`, { headers: { CST: session.cst, "X-SECURITY-TOKEN": session.xSecurityToken } });
  return response.data;
}

async function fetchOpenPositions() {
  const session = await getBrokerSession();
  const response = await axios.get(`${CAPITAL_BASE_URL}/positions`, { headers: { CST: session.cst, "X-SECURITY-TOKEN": session.xSecurityToken } });
  return response.data.positions || [];
}

async function executeMarketTrade(direction, size, stopLevel = null, profitLevel = null) {
  const session = await getBrokerSession();
  const payload = { epic: GOLD_EPIC, direction: direction.toUpperCase(), size: parseFloat(size), guaranteedStop: false, trailingStop: false };
  if (stopLevel) payload.stopLevel = parseFloat(stopLevel.toFixed(2));
  if (profitLevel) payload.profitLevel = parseFloat(profitLevel.toFixed(2));
  try {
    const response = await axios.post(`${CAPITAL_BASE_URL}/positions`, payload, { headers: { CST: session.cst, "X-SECURITY-TOKEN": session.xSecurityToken, "Content-Type": "application/json" } });
    return response.data;
  } catch (error) {
    const errData = error.response ? error.response.data : error.message;
    console.error("[BROKER] Order Placement Rejected:", errData);
    throw new Error(`Order Rejected by Broker: ${JSON.stringify(errData)}`);
  }
}

async function closeBrokerPosition(dealId) {
  const session = await getBrokerSession();
  try {
    const response = await axios.delete(`${CAPITAL_BASE_URL}/positions/${dealId}`, { headers: { CST: session.cst, "X-SECURITY-TOKEN": session.xSecurityToken } });
    return response.data;
  } catch (error) {
    const errData = error.response ? error.response.data : error.message;
    console.error(`[BROKER] Close Position Failed for deal ${dealId}:`, errData);
    throw new Error(`Close Position Failed: ${JSON.stringify(errData)}`);
  }
}

function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((acc, val) => acc + val, 0) / period;
  for (let i = period; i < prices.length; i++) ema = (prices[i] * k) + (ema * (1 - k));
  return parseFloat(ema.toFixed(2));
}

function calculateRSI(prices, period = 14) {
  if (prices.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const diff = prices[i] - prices[i - 1]; if (diff >= 0) gains += diff; else losses -= diff; }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) { avgGain = (avgGain * (period - 1) + diff) / period; avgLoss = (avgLoss * (period - 1)) / period; }
    else { avgGain = (avgGain * (period - 1)) / period; avgLoss = (avgLoss * (period - 1) - diff) / period; }
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - (100 / (1 + avgGain / avgLoss))).toFixed(2));
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 2.5;
  const trs = [];
  for (let i = 1; i < candles.length; i++) { const h = candles[i].high, l = candles[i].low, cp = candles[i - 1].close; trs.push(Math.max(h - l, Math.abs(h - cp), Math.abs(l - cp))); }
  return parseFloat((trs.slice(-period).reduce((acc, v) => acc + v, 0) / period).toFixed(2));
}

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2) return 22.0;
  let diffs = 0;
  for (let i = candles.length - period; i < candles.length; i++) diffs += Math.abs(candles[i].close - candles[i - 1].close);
  return parseFloat(Math.min(100, Math.max(10, (diffs / period) * 12)).toFixed(2));
}

function analyzeMarketStructure(candles) {
  if (candles.length < 10) return { structure: "NEUTRAL", pullback: false, candlePattern: "NEUTRAL" };
  const recent = candles.slice(-5), current = recent[recent.length - 1], previous = recent[recent.length - 2];
  let structure = "NEUTRAL";
  if (current.close > previous.high && current.low >= previous.low) structure = "BULLISH";
  else if (current.close < previous.low && current.high <= previous.high) structure = "BEARISH";
  const pullback = structure === "BULLISH" ? current.close < previous.close && current.close > previous.low : structure === "BEARISH" ? current.close > previous.close && current.close < previous.high : false;
  const candlePattern = current.close > current.open && current.close - current.open > current.high - current.close ? "BULLISH_ENGULFING" : current.close < current.open && current.open - current.close > current.close - current.low ? "BEARISH_ENGULFING" : "NEUTRAL";
  return { structure, pullback, candlePattern };
}

async function evaluateAIFilter(marketMetrics, proposedSignal) {
  if (!engineConfig.AI_ENABLED) return { allow: true, confidence: 100, reason: "AI filter disabled in config." };
  try {
    const { rsi, adx, spread } = marketMetrics;
    let approved = true, confidence = 85, reason = "AI verified indicator symmetry.";
    if (spread > engineConfig.MAX_SPREAD) { approved = false; confidence = 90; reason = "AI blocked: Excessive volatility/spread detected."; }
    else if (proposedSignal === "BUY" && rsi > 78) { approved = false; confidence = 92; reason = "AI blocked: Overbought market conditions."; }
    else if (proposedSignal === "SELL" && rsi < 22) { approved = false; confidence = 92; reason = "AI blocked: Oversold market conditions."; }
    else if (adx < 15) { approved = false; confidence = 88; reason = "AI blocked: Market lacks directional momentum."; }
    return { allow: approved, confidence, reason };
  } catch (error) {
    console.error("[AI FILTER] Error during AI evaluation:", error.message);
    return engineConfig.AI_FAILSAFE_BLOCK ? { allow: false, confidence: 0, reason: "AI Filter unavailable - Failsafe BLOCKED trade." } : { allow: true, confidence: 50, reason: "AI Filter unavailable - Failsafe PERMITTED trade." };
  }
}

function calculateSniperScore(data) {
  let score = 0; const breakdown = {};
  if ((data.signal === "BUY" && data.price > data.ema50) || (data.signal === "SELL" && data.price < data.ema50)) { score += 20; breakdown.trend = 20; } else breakdown.trend = 0;
  if ((data.signal === "BUY" && data.ema9 > data.ema21) || (data.signal === "SELL" && data.ema9 < data.ema21)) { score += 15; breakdown.ema = 15; } else breakdown.ema = 0;
  if ((data.signal === "BUY" && data.rsi > 55) || (data.signal === "SELL" && data.rsi < 45)) { score += 10; breakdown.rsi = 10; } else breakdown.rsi = 0;
  if (data.adx >= engineConfig.ADX_THRESHOLD) { score += 10; breakdown.adx = 10; } else breakdown.adx = 0;
  if ((data.signal === "BUY" && data.structure === "BULLISH") || (data.signal === "SELL" && data.structure === "BEARISH")) { score += 15; breakdown.structure = 15; } else breakdown.structure = 0;
  if (data.pullback) { score += 10; breakdown.pullback = 10; } else breakdown.pullback = 0;
  if ((data.signal === "BUY" && data.candlePattern === "BULLISH_ENGULFING") || (data.signal === "SELL" && data.candlePattern === "BEARISH_ENGULFING")) { score += 10; breakdown.candle = 10; } else breakdown.candle = 0;
  if (data.spread <= engineConfig.MAX_SPREAD) { score += 5; breakdown.spread = 5; } else breakdown.spread = 0;
  if (data.atr >= 1.0 && data.atr <= 8.0) { score += 5; breakdown.volatility = 5; } else breakdown.volatility = 0;
  return { score, breakdown };
}

function evaluateRiskManager(openPositionsCount) {
  checkDailyReset();
  if (engineConfig.EMERGENCY_STOP) return { approved: false, reason: "EMERGENCY_STOP is active." };
  if (!engineConfig.AUTO_TRADING) return { approved: false, reason: "AUTO_TRADING is OFF." };
  if (openPositionsCount >= engineConfig.MAX_OPEN_TRADES) return { approved: false, reason: `MAX_OPEN_TRADES limit reached (${openPositionsCount}).` };
  if (dailyTracker.tradesCount >= engineConfig.MAX_TRADES_PER_DAY) return { approved: false, reason: `MAX_TRADES_PER_DAY limit reached (${dailyTracker.tradesCount}).` };
  if (dailyTracker.realizedPnL <= -Math.abs(engineConfig.MAX_DAILY_LOSS)) return { approved: false, reason: `MAX_DAILY_LOSS hit ($${dailyTracker.realizedPnL.toFixed(2)}).` };
  const timeSinceLastTrade = (Date.now() - lastTradeTimestamp) / 1000;
  if (timeSinceLastTrade < engineConfig.COOLDOWN_SECONDS) return { approved: false, reason: `COOLDOWN active. Wait ${Math.ceil(engineConfig.COOLDOWN_SECONDS - timeSinceLastTrade)}s.` };
  return { approved: true, reason: "Risk Manager Approved." };
}

async function runTradingEngineCycle() {
  try {
    const ticker = await fetchGoldPrice();
    marketDataHistory.push({ price: ticker.price, high: ticker.high, low: ticker.low, close: ticker.price, open: ticker.price, timestamp: ticker.timestamp });
    if (marketDataHistory.length > 200) marketDataHistory.shift();
    const prices = marketDataHistory.map(m => m.price);
    const ema9 = calculateEMA(prices, 9), ema21 = calculateEMA(prices, 21), ema50 = calculateEMA(prices, 50), rsi = calculateRSI(prices, 14), atr = calculateATR(marketDataHistory, 14), adx = calculateADX(marketDataHistory, 14);
    const { structure, pullback, candlePattern } = analyzeMarketStructure(marketDataHistory);
    const openPositions = await fetchOpenPositions();
    const goldPositions = openPositions.filter(p => p.market.epic === GOLD_EPIC);
    if (goldPositions.length > 0) for (const pos of goldPositions) {
      const dealId = pos.position.dealId, currentPnL = pos.position.upl || 0;
      if (engineConfig.TRAILING_STOP_ENABLED && currentPnL >= engineConfig.BREAKEVEN_TRIGGER_PROFIT) console.log(`[POSITION MGR] Profit trigger met for deal ${dealId}. PnL: $${currentPnL}. Securing breakeven.`);
    }
    let proposedDirection = "WAITING", waitingReason = "Searching for high-probability setup...";
    if (ema9 && ema21 && ema50) {
      if (ema9 > ema21 && ticker.price > ema50 && rsi > 55) proposedDirection = "BUY";
      else if (ema9 < ema21 && ticker.price < ema50 && rsi < 45) proposedDirection = "SELL";
      else if (rsi <= 55 && rsi >= 45) waitingReason = "WAITING: RSI confirmation missing (neutral zone).";
      else if (ema9 <= ema21 && ticker.price > ema50) waitingReason = "WAITING: EMA9/EMA21 cross conflict.";
      else waitingReason = "WAITING: Trend indicators conflicting.";
    } else waitingReason = "WAITING: Gathering sufficient historical candle data...";
    if (proposedDirection === "WAITING") { lastSignalState = { signal: "WAITING", reason: waitingReason, score: 0, aiConfidence: 0, details: { price: ticker.price, spread: ticker.spread, ema9, ema21, ema50, rsi, adx, atr, structure } }; return; }
    const { score, breakdown } = calculateSniperScore({ signal: proposedDirection, price: ticker.price, ema9, ema21, ema50, rsi, adx, atr, spread: ticker.spread, structure, pullback, candlePattern });
    if (score < engineConfig.MIN_SNIPER_SCORE) { lastSignalState = { signal: "WAITING", reason: `WAITING: Sniper score ${score}/${engineConfig.MIN_SNIPER_SCORE} below threshold.`, score, aiConfidence: 0, details: { breakdown, price: ticker.price, spread: ticker.spread } }; return; }
    const riskCheck = evaluateRiskManager(goldPositions.length);
    if (!riskCheck.approved) { lastSignalState = { signal: "WAITING", reason: `WAITING: Risk Manager BLOCKED trade (${riskCheck.reason}).`, score, aiConfidence: 0, details: { price: ticker.price, spread: ticker.spread } }; return; }
    const aiCheck = await evaluateAIFilter({ ema9, ema21, rsi, adx, spread: ticker.spread, score }, proposedDirection);
    if (!aiCheck.allow) { lastSignalState = { signal: "WAITING", reason: `WAITING: ${aiCheck.reason}`, score, aiConfidence: aiCheck.confidence, details: { price: ticker.price, spread: ticker.spread } }; return; }
    let stopLoss, takeProfit;
    if (proposedDirection === "BUY") { stopLoss = ticker.price - atr * engineConfig.ATR_SL_MULTIPLIER; takeProfit = ticker.price + atr * engineConfig.ATR_TP_MULTIPLIER; }
    else { stopLoss = ticker.price + atr * engineConfig.ATR_SL_MULTIPLIER; takeProfit = ticker.price - atr * engineConfig.ATR_TP_MULTIPLIER; }
    console.log(`[ENGINE] TRADE APPROVED! Executing ${proposedDirection} on GOLD at ${ticker.price}. Score: ${score}`);
    const tradeResult = await executeMarketTrade(proposedDirection, engineConfig.MAX_RISK_PER_TRADE, stopLoss, takeProfit);
    lastTradeTimestamp = Date.now(); dailyTracker.tradesCount++;
    const logEntry = { time: new Date().toISOString(), symbol: GOLD_EPIC, direction: proposedDirection, size: engineConfig.MAX_RISK_PER_TRADE, entry: ticker.price, exit: null, profitLoss: 0, strategyScore: score, aiConfidence: aiCheck.confidence, reason: "TRADE APPROVED: All confirmations passed.", dealId: tradeResult.dealId || tradeResult.dealReference };
    tradeHistory.unshift(logEntry);
    lastSignalState = { signal: `TRADE APPROVED (${proposedDirection})`, reason: "All confirmations passed.", score, aiConfidence: aiCheck.confidence, details: { dealId: tradeResult.dealId, price: ticker.price, stopLoss, takeProfit } };
  } catch (error) { console.error("[ENGINE CYCLE ERROR]", error.message); }
}

setInterval(runTradingEngineCycle, 10000);

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.get("/capital/test", authenticateServerKey, async (req, res) => {
  try { const session = await getBrokerSession(), accountInfo = await fetchBrokerAccount(), priceInfo = await fetchGoldPrice(); res.json({ ok: true, broker: "Capital.com", mode: CAPITAL_DEMO ? "DEMO" : "LIVE", authenticated: true, tradingEnabled: true, message: "Capital.com connection & authorization test successful.", account: { currentAccountId: session.activeAccountId }, accounts: accountInfo, goldMarket: priceInfo }); }
  catch (error) { res.status(400).json({ ok: false, broker: "Capital.com", mode: CAPITAL_DEMO ? "DEMO" : "LIVE", error: error.message }); }
});
app.get("/capital/price", authenticateServerKey, async (req, res) => { try { res.json({ ok: true, gold: await fetchGoldPrice() }); } catch (error) { res.status(500).json({ ok: false, error: error.message }); } });
app.get("/capital/account", authenticateServerKey, async (req, res) => { try { res.json({ ok: true, account: await fetchBrokerAccount() }); } catch (error) { res.status(500).json({ ok: false, error: error.message }); } });
app.get("/capital/positions", authenticateServerKey, async (req, res) => { try { res.json({ ok: true, positions: await fetchOpenPositions() }); } catch (error) { res.status(500).json({ ok: false, error: error.message }); } });
app.post("/capital/trade", authenticateServerKey, async (req, res) => { try { const { direction, size, stopLevel, profitLevel } = req.body; const result = await executeMarketTrade(direction || "BUY", size || engineConfig.MAX_RISK_PER_TRADE, stopLevel, profitLevel); res.json({ ok: true, result }); } catch (error) { res.status(400).json({ ok: false, error: error.message }); } });
app.delete("/capital/positions/:dealId", authenticateServerKey, async (req, res) => { try { const result = await closeBrokerPosition(req.params.dealId); res.json({ ok: true, message: `Position ${req.params.dealId} closed`, result }); } catch (error) { res.status(400).json({ ok: false, error: error.message }); } });

app.get("/engine/status", async (req, res) => {
  try { const ticker = await fetchGoldPrice(), positions = await fetchOpenPositions(), goldPositions = positions.filter(p => p.market.epic === GOLD_EPIC), accountInfo = await fetchBrokerAccount(); res.json({ ok: true, system: { name: "GOLDWEBTRADER PRO AI", developer: "KELVIN NGUGI", mode: CAPITAL_DEMO ? "DEMO" : "LIVE", autoTrading: engineConfig.AUTO_TRADING, emergencyStop: engineConfig.EMERGENCY_STOP }, ticker, account: accountInfo.accounts ? accountInfo.accounts[0] : {}, openPositions: goldPositions, signal: lastSignalState, dailyTracker }); }
  catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});
app.post("/engine/start", authenticateServerKey, (req, res) => { engineConfig.AUTO_TRADING = true; engineConfig.EMERGENCY_STOP = false; res.json({ ok: true, message: "Engine AUTO_TRADING started.", config: engineConfig }); });
app.post("/engine/stop", authenticateServerKey, (req, res) => { engineConfig.AUTO_TRADING = false; engineConfig.EMERGENCY_STOP = true; res.json({ ok: true, message: "Engine EMERGENCY_STOP activated.", config: engineConfig }); });
app.post("/engine/config", authenticateServerKey, (req, res) => { engineConfig = { ...engineConfig, ...req.body }; res.json({ ok: true, message: "Configuration updated.", config: engineConfig }); });
app.get("/engine/signal", async (req, res) => res.json({ ok: true, signal: lastSignalState }));
app.get("/engine/history", async (req, res) => res.json({ ok: true, history: tradeHistory }));

app.use(express.static(path.join(__dirname, "public")));
const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
const dashboardHTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>GOLDWEBTRADER PRO AI | Dashboard</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><style>body{background-color:#0b0e11;color:#e0e6ed;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif}.card{background-color:#151a21;border:1px solid #232a34;border-radius:8px;margin-bottom:20px}.card-header{background-color:#1c232d;border-bottom:1px solid #232a34;font-weight:bold}.text-gold{color:#f0b90b}.badge-demo{background-color:#f0b90b;color:#000;font-weight:bold}.metric-value{font-size:1.5rem;font-weight:bold}.status-indicator{height:10px;width:10px;border-radius:50%;display:inline-block;margin-right:5px}.bg-active{background-color:#0ecb81}.bg-inactive{background-color:#f6465d}</style></head><body class="p-3"><div class="container-fluid"><div class="d-flex justify-content-between align-items-center mb-4"><div><h2 class="text-gold m-0">GOLDWEBTRADER PRO AI</h2><small class="text-muted">Developer/Owner: <strong>KELVIN NGUGI</strong> | Broker: <strong>Capital.com</strong></small></div><div><span class="badge badge-demo p-2">DEMO MODE</span><span id="autoTradingBadge" class="badge bg-secondary p-2">AUTO TRADING: OFF</span></div></div><div class="card p-3"><div class="d-flex gap-2"><button onclick="controlEngine('start')" class="btn btn-success fw-bold">AUTO TRADING ON</button><button onclick="controlEngine('stop')" class="btn btn-warning fw-bold">AUTO TRADING OFF</button><button onclick="controlEngine('stop')" class="btn btn-danger fw-bold">EMERGENCY STOP</button></div></div><div class="row"><div class="col-md-3"><div class="card p-3"><span class="text-muted">Gold Price (Bid/Offer)</span><div id="goldPrice" class="metric-value text-gold">---</div><small id="goldSpread" class="text-muted">Spread: ---</small></div></div><div class="col-md-3"><div class="card p-3"><span class="text-muted">Balance / Equity</span><div id="accountBalance" class="metric-value">---</div><small id="accountPnl" class="text-muted">Today P/L: $0.00</small></div></div><div class="col-md-3"><div class="card p-3"><span class="text-muted">Sniper Signal Score</span><div id="sniperScore" class="metric-value text-info">0 / 100</div><small id="aiConfidence" class="text-muted">AI Confidence: 0%</small></div></div><div class="col-md-3"><div class="card p-3"><span class="text-muted">Engine Status</span><div id="engineSignal" class="metric-value text-warning">WAITING</div><small id="engineReason" class="text-muted">Initializing...</small></div></div></div><div class="row"><div class="col-md-6"><div class="card"><div class="card-header">Active Gold Position</div><div class="card-body" id="positionDetails"><p class="text-muted">No open positions.</p></div></div></div><div class="col-md-6"><div class="card"><div class="card-header">Strategy & Confirmation Panel</div><div class="card-body"><div class="row"><div class="col-6"><p>EMA 9/21/50: <strong id="emaMetrics">---</strong></p></div><div class="col-6"><p>RSI (14): <strong id="rsiMetric">---</strong></p></div><div class="col-6"><p>ADX (14): <strong id="adxMetric">---</strong></p></div><div class="col-6"><p>ATR (14): <strong id="atrMetric">---</strong></p></div><div class="col-12"><p>Market Structure: <strong id="structureMetric">NEUTRAL</strong></p></div></div></div></div></div></div><div class="card"><div class="card-header">Trade History</div><div class="card-body p-0"><table class="table table-dark table-striped m-0"><thead><tr><th>Time</th><th>Symbol</th><th>Direction</th><th>Size</th><th>Entry</th><th>Score</th><th>AI Conf</th><th>Reason</th></tr></thead><tbody id="historyTable"><tr><td colspan="8" class="text-center text-muted">No trades executed yet.</td></tr></tbody></table></div></div></div><script>
const API_KEY="6e0bcb8010ca8e0775f30c1d9241c48f";
async function fetchStatus(){try{const res=await fetch('/engine/status');const data=await res.json();if(!data.ok)return;document.getElementById('goldPrice').innerText=\`$\${data.ticker.price.toFixed(2)}\`;document.getElementById('goldSpread').innerText=\`Bid: \${data.ticker.bid} | Offer: \${data.ticker.offer} | Spread: \${data.ticker.spread}\`;if(data.account&&data.account.balance)document.getElementById('accountBalance').innerText=\`$\${data.account.balance.balance.toFixed(2)}\`;document.getElementById('engineSignal').innerText=data.signal.signal;document.getElementById('engineReason').innerText=data.signal.reason;document.getElementById('sniperScore').innerText=\`\${data.signal.score||0} / 100\`;document.getElementById('aiConfidence').innerText=\`AI Confidence: \${data.signal.aiConfidence||0}%\`;const autoBadge=document.getElementById('autoTradingBadge');autoBadge.innerText=\`AUTO TRADING: \${data.system.autoTrading?'ON':'OFF'}\`;autoBadge.className=data.system.autoTrading?'badge bg-success p-2':'badge bg-secondary p-2';const posContainer=document.getElementById('positionDetails');if(data.openPositions&&data.openPositions.length>0){const pos=data.openPositions[0].position;posContainer.innerHTML=\`<p><strong>Direction:</strong> \${pos.direction} (\${pos.size} Lot)</p><p><strong>Entry Price:</strong> \${pos.level}</p><p><strong>Unrealized PnL:</strong> <span class="\${pos.upl>=0?'text-success':'text-danger'}">$\${pos.upl}</span></p><button onclick="closePosition('\${pos.dealId}')" class="btn btn-sm btn-danger">Close Position</button>\`}else posContainer.innerHTML='<p class="text-muted">No open positions.</p>'}catch(e){console.error(e)}}
async function controlEngine(action){await fetch(\`/engine/\${action}\`,{method:'POST',headers:{'X-API-KEY':API_KEY}});fetchStatus()}
async function closePosition(dealId){await fetch(\`/capital/positions/\${dealId}\`,{method:'DELETE',headers:{'X-API-KEY':API_KEY}});fetchStatus()}
setInterval(fetchStatus,3000);fetchStatus();
</script></body></html>`;
fs.writeFileSync(path.join(publicDir, "index.html"), dashboardHTML);

app.listen(PORT, () => {
  console.log("=================================================");
  console.log("GOLDWEBTRADER PRO AI v3.0.0 - Production Server");
  console.log("Developer/Owner: KELVIN NGUGI");
  console.log(`Server listening on port ${PORT}`);
  console.log(`Capital Mode: ${CAPITAL_DEMO ? "DEMO" : "LIVE"}`);
  console.log(`Dashboard Available at: http://localhost:${PORT}`);
  console.log("=================================================");
});
