const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const app = express();
app.use(express.json({ limit: "32kb" }));

// ============================================================
// GOLDWEBTRADER PRO AI
// Capital.com DEMO / LIVE REST engine
// Complete replacement server.js
//
// Keeps the existing Capital.com authentication and endpoints,
// while adding a real historical-candle indicator engine.
//
// IMPORTANT:
// - Keep CAPITAL_API_KEY, CAPITAL_IDENTIFIER and CAPITAL_PASSWORD
//   in Render Environment Variables. Never put credentials here.
// - CAPITAL_DEMO defaults to DEMO.
// - AUTO_TRADING defaults to OFF.
// ============================================================

const PORT = Number(process.env.PORT || 10000);
const DASHBOARD_API_KEY = process.env.API_KEY || "";

const DEMO = process.env.CAPITAL_DEMO !== "false";
const BASE_URL = `${
  DEMO
    ? "https://demo-api-capital.backend-capital.com"
    : "https://api-capital.backend-capital.com"
}/api/v1`;

const EPIC = process.env.GOLD_EPIC || "GOLD";
const RESOLUTION = process.env.STRATEGY_TIMEFRAME || "MINUTE_5";
const POLL_MS = Math.max(5000, Number(process.env.ENGINE_INTERVAL_MS || 10000));

if (process.env.NODE_ENV === "production" && !DASHBOARD_API_KEY) {
  throw new Error(
    "API_KEY is required in production; refusing to start with an unsecured dashboard trading API."
  );
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
  minScore: Number(process.env.MIN_SNIPER_SCORE || 85),

  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 1800),

  slAtr: Number(process.env.ATR_SL_MULTIPLIER || 1.2),
  tpAtr: Number(process.env.ATR_TP_MULTIPLIER || 0.8),

  maxAtr: Number(process.env.MAX_ATR || 8),
  minAtr: Number(process.env.MIN_ATR || 0.5),

  minOrderDistance: Number(process.env.MIN_ORDER_DISTANCE || 1.0),

  oneTradePerCandle: process.env.ONE_TRADE_PER_CANDLE !== "false"
};

let session = null;
let sessionPromise = null;

let candles = [];
let lastCandleId = null;
let lastTradeAt = 0;
let lastSignalId = null;

let lastSignal = {
  signal: "WAITING",
  reason: "Engine initializing",
  score: 0,
  maxScore: 85,
  details: {}
};

let trades = [];

let daily = {
  date: new Date().toISOString().slice(0, 10),
  count: 0,
  realizedPnL: 0
};

let cycleRunning = false;

// ============================================================
// AUTH
// ============================================================

function auth(req, res, next) {
  if (!DASHBOARD_API_KEY) return next();

  const supplied =
    req.get("x-api-key") ||
    req.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (supplied !== DASHBOARD_API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  next();
}

// ============================================================
// HELPERS
// ============================================================

function resetDaily() {
  const date = new Date().toISOString().slice(0, 10);

  if (daily.date !== date) {
    daily = {
      date,
      count: 0,
      realizedPnL: 0
    };
  }
}

function brokerError(error) {
  return (
    error?.response?.data ||
    error?.code ||
    error?.message ||
    String(error)
  );
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function pickPrice(value) {
  if (value && typeof value === "object") {
    return num(
      value.bid ??
        value.ask ??
        value.mid ??
        value.price ??
        value.value
    );
  }

  return num(value);
}

function positionEpic(p) {
  return (
    p?.market?.epic ||
    p?.epic ||
    p?.position?.epic ||
    p?.marketName ||
    null
  );
}

function publicTrade(t) {
  return { ...t };
}

// ============================================================
// CAPITAL.COM SESSION
// ============================================================

async function getSession(force = false) {
  if (
    !force &&
    session &&
    Date.now() - session.created < 5 * 60 * 1000
  ) {
    return session;
  }

  if (sessionPromise) return sessionPromise;

  const identifier = process.env.CAPITAL_IDENTIFIER;
  const password = process.env.CAPITAL_PASSWORD;
  const capitalApiKey = process.env.CAPITAL_API_KEY;

  if (!identifier || !password || !capitalApiKey) {
    throw new Error(
      "Missing CAPITAL_IDENTIFIER, CAPITAL_PASSWORD or CAPITAL_API_KEY."
    );
  }

  sessionPromise = axios
    .post(
      `${BASE_URL}/session`,
      {
        identifier,
        password
      },
      {
        timeout: 10000,
        headers: {
          "X-CAP-API-KEY": capitalApiKey,
          "Content-Type": "application/json"
        }
      }
    )
    .then((response) => {
      const cst = response.headers.cst;
      const securityToken = response.headers["x-security-token"];

      if (!cst || !securityToken) {
        throw new Error("Broker session tokens were missing.");
      }

      session = {
        cst,
        securityToken,
        accountId: response.data.currentAccountId,
        account: response.data,
        created: Date.now()
      };

      return session;
    })
    .finally(() => {
      sessionPromise = null;
    });

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
        headers: {
          CST: s.cst,
          "X-SECURITY-TOKEN": s.securityToken,
          "Content-Type": "application/json"
        }
      });
    } catch (error) {
      const status = error?.response?.status;

      if (!retried && status === 401) {
        retried = true;
        session = null;
        continue;
      }

      if (status === 429 || status >= 500) {
        error.message = `Broker temporary error (${status}): ${JSON.stringify(
          brokerError(error)
        )}`;
      }

      throw error;
    }
  }
}

// ============================================================
// MARKET DATA
// ============================================================

async function getMarket() {
  const response = await brokerRequest(
    "GET",
    `/markets/${encodeURIComponent(EPIC)}`
  );

  return response.data?.marketDetails || response.data;
}

async function price() {
  const m = await getMarket();
  const s = m?.snapshot || m;

  const bid = pickPrice(s?.bid);
  const offer = pickPrice(s?.offer);

  if (!Number.isFinite(bid) || !Number.isFinite(offer)) {
    throw new Error("Broker returned an invalid Gold quote.");
  }

  return {
    bid,
    offer,
    price: (bid + offer) / 2,
    spread: round(offer - bid, 2),
    high: pickPrice(s?.high),
    low: pickPrice(s?.low),
    marketStatus: m?.marketStatus || s?.marketStatus || null,
    instrumentName: m?.instrumentName || null,
    instrumentId: m?.instrumentId || null,
    tickSize: num(m?.tickSize),
    time: Date.now()
  };
}

async function loadCandles() {
  const response = await brokerRequest(
    "GET",
    `/prices/${encodeURIComponent(EPIC)}?resolution=${encodeURIComponent(
      RESOLUTION
    )}&max=200`
  );

  const raw = Array.isArray(response.data?.prices)
    ? response.data.prices
    : [];

  const parsed = raw
    .map((x, i) => {
      const open = pickPrice(x?.openPrice ?? x?.open);
      const high = pickPrice(x?.highPrice ?? x?.high);
      const low = pickPrice(x?.lowPrice ?? x?.low);
      const close = pickPrice(x?.closePrice ?? x?.close);

      const time =
        x?.snapshotTimeUTC ||
        x?.snapshotTime ||
        x?.time ||
        null;

      return {
        id: String(time || i),
        open,
        high,
        low,
        close,
        time
      };
    })
    .filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    )
    .sort((a, b) => {
      const ta = Date.parse(a.time) || Number(a.time) || 0;
      const tb = Date.parse(b.time) || Number(b.time) || 0;
      return ta - tb;
    });

  // Remove duplicate candle IDs.
  const unique = [];
  const seen = new Set();

  for (const c of parsed) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      unique.push(c);
    }
  }

  return unique.slice(-200);
}

// ============================================================
// INDICATORS
// ============================================================

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let value =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }

  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(data, period = 14) {
  if (data.length < period + 1) return null;

  const tr = [];

  for (let i = 1; i < data.length; i++) {
    const current = data[i];
    const previous = data[i - 1];

    tr.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  let value =
    tr.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < tr.length; i++) {
    value = (value * (period - 1) + tr[i]) / period;
  }

  return value;
}

// Wilder ADX(14).
function adx(data, period = 14) {
  if (data.length < period * 2 + 1) return null;

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < data.length; i++) {
    const current = data[i];
    const previous = data[i - 1];

    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(
      downMove > upMove && downMove > 0 ? downMove : 0
    );

    tr.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  if (tr.length < period * 2) return null;

  let tr14 = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plus14 = plusDM
    .slice(0, period)
    .reduce((a, b) => a + b, 0);
  let minus14 = minusDM
    .slice(0, period)
    .reduce((a, b) => a + b, 0);

  const dx = [];

  for (let i = period; i < tr.length; i++) {
    tr14 = tr14 - tr14 / period + tr[i];
    plus14 = plus14 - plus14 / period + plusDM[i];
    minus14 = minus14 - minus14 / period + minusDM[i];

    const plusDI = tr14 ? (100 * plus14) / tr14 : 0;
    const minusDI = tr14 ? (100 * minus14) / tr14 : 0;

    const denominator = plusDI + minusDI;

    dx.push(
      denominator
        ? (100 * Math.abs(plusDI - minusDI)) / denominator
        : 0
    );
  }

  if (dx.length < period) return null;

  let adxValue =
    dx.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dx.length; i++) {
    adxValue =
      (adxValue * (period - 1) + dx[i]) / period;
  }

  return adxValue;
}

// ============================================================
// MARKET STRUCTURE / SIGNAL SCORE
// ============================================================

function marketStructure(data) {
  if (data.length < 6) {
    return {
      bullish: false,
      bearish: false,
      label: "INSUFFICIENT_DATA"
    };
  }

  const recent = data.slice(-6);
  const previous = data.slice(-12, -6);

  const recentHigh = Math.max(...recent.map((c) => c.high));
  const recentLow = Math.min(...recent.map((c) => c.low));

  const previousHigh =
    previous.length
      ? Math.max(...previous.map((c) => c.high))
      : recentHigh;

  const previousLow =
    previous.length
      ? Math.min(...previous.map((c) => c.low))
      : recentLow;

  const bullish =
    recentHigh > previousHigh && recentLow > previousLow;

  const bearish =
    recentHigh < previousHigh && recentLow < previousLow;

  return {
    bullish,
    bearish,
    label: bullish
      ? "HIGHER_HIGH_HIGHER_LOW"
      : bearish
      ? "LOWER_HIGH_LOWER_LOW"
      : "RANGE"
  };
}

function momentum(data, bars = 3) {
  if (data.length <= bars) return null;

  const previous = data[data.length - 1 - bars].close;
  const current = data[data.length - 1].close;

  return current - previous;
}

function candleQuality(candle) {
  if (!candle) {
    return {
      bullish: false,
      bearish: false,
      bodyRatio: 0
    };
  }

  const range = candle.high - candle.low;

  if (range <= 0) {
    return {
      bullish: false,
      bearish: false,
      bodyRatio: 0
    };
  }

  const body = Math.abs(candle.close - candle.open);

  return {
    bullish: candle.close > candle.open,
    bearish: candle.close < candle.open,
    bodyRatio: body / range
  };
}

function scoreSignal(signal, m) {
  let score = 0;
  const breakdown = {};

  // 20: price vs EMA50
  const trend =
    signal === "BUY"
      ? m.price > m.e50
      : m.price < m.e50;

  breakdown.trend = trend ? 20 : 0;
  score += breakdown.trend;

  // 20: EMA9 vs EMA21
  const emaAlignment =
    signal === "BUY"
      ? m.e9 > m.e21
      : m.e9 < m.e21;

  breakdown.ema = emaAlignment ? 20 : 0;
  score += breakdown.ema;

  // 15: RSI
  const rsiAlignment =
    signal === "BUY"
      ? m.rsi > 55
      : m.rsi < 45;

  breakdown.rsi = rsiAlignment ? 15 : 0;
  score += breakdown.rsi;

  // 10: ADX
  const adxGood = Number.isFinite(m.adx) && m.adx >= 20;
  breakdown.adx = adxGood ? 10 : 0;
  score += breakdown.adx;

  // 10: structure
  const structureGood =
    signal === "BUY"
      ? m.structure.bullish
      : m.structure.bearish;

  breakdown.structure = structureGood ? 10 : 0;
  score += breakdown.structure;

  // 5: momentum
  const momentumGood =
    signal === "BUY"
      ? m.momentum > 0
      : m.momentum < 0;

  breakdown.momentum = momentumGood ? 5 : 0;
  score += breakdown.momentum;

  // 5: current candle quality
  const candleGood =
    signal === "BUY"
      ? m.candle.bullish && m.candle.bodyRatio >= 0.35
      : m.candle.bearish && m.candle.bodyRatio >= 0.35;

  breakdown.candle = candleGood ? 5 : 0;
  score += breakdown.candle;

  return {
    score,
    maxScore: 85,
    breakdown
  };
}

function chooseCandidate(m) {
  if (m.e9 > m.e21 && m.price > m.e50) return "BUY";
  if (m.e9 < m.e21 && m.price < m.e50) return "SELL";
  return "WAITING";
}

function waitingReason(signal, m) {
  const reasons = [];

  if (signal === "WAITING") {
    if (!(m.e9 > m.e21) && !(m.e9 < m.e21)) {
      reasons.push("EMA9/EMA21 are not clearly aligned");
    }

    if (
      !(
        (m.price > m.e50 && m.e9 > m.e21) ||
        (m.price < m.e50 && m.e9 < m.e21)
      )
    ) {
      reasons.push("price/EMA50 trend confirmation missing");
    }
  }

  if (!Number.isFinite(m.rsi)) reasons.push("RSI unavailable");
  else if (signal === "BUY" && m.rsi <= 55) reasons.push(`RSI ${round(m.rsi, 1)} <= 55`);
  else if (signal === "SELL" && m.rsi >= 45) reasons.push(`RSI ${round(m.rsi, 1)} >= 45`);

  if (!Number.isFinite(m.adx)) reasons.push("ADX unavailable");
  else if (m.adx < 20) reasons.push(`ADX ${round(m.adx, 1)} < 20`);

  if (!m.structure.bullish && !m.structure.bearish) {
    reasons.push("market structure is ranging");
  } else if (
    signal === "BUY" &&
    !m.structure.bullish
  ) {
    reasons.push("bullish structure not confirmed");
  } else if (
    signal === "SELL" &&
    !m.structure.bearish
  ) {
    reasons.push("bearish structure not confirmed");
  }

  if (Number.isFinite(m.spread) && m.spread > config.maxSpread) {
    reasons.push(
      `spread ${round(m.spread, 2)} > ${config.maxSpread}`
    );
  }

  if (Number.isFinite(m.atr)) {
    if (m.atr < config.minAtr) {
      reasons.push(`ATR ${round(m.atr, 2)} below minimum`);
    }

    if (m.atr > config.maxAtr) {
      reasons.push(`ATR ${round(m.atr, 2)} above maximum`);
    }
  }

  return reasons.length ? reasons.join(" · ") : "Waiting for confirmation";
}

// ============================================================
// BROKER TRADING
// ============================================================

async function positions() {
  const response = await brokerRequest("GET", "/positions");
  return response.data?.positions || [];
}

async function account() {
  return (await brokerRequest("GET", "/accounts")).data;
}

async function place(direction, size, stop, limit) {
  const body = {
    epic: EPIC,
    direction,
    size,
    guaranteedStop: false,
    stopLevel: round(stop, 2),
    profitLevel: round(limit, 2)
  };

  const response = await brokerRequest("POST", "/positions", body);

  const result = response.data;

  // Capital.com documents that a successful POST returns a dealReference
  // and that the deal should then be confirmed.
  if (result?.dealReference) {
    try {
      const confirmation = await brokerRequest(
        "GET",
        `/confirms/${encodeURIComponent(result.dealReference)}`
      );

      return {
        ...result,
        confirmation: confirmation.data
      };
    } catch (e) {
      return {
        ...result,
        confirmationError: brokerError(e)
      };
    }
  }

  return result;
}

async function close(dealId) {
  return (
    await brokerRequest(
      "DELETE",
      `/positions/${encodeURIComponent(dealId)}`
    )
  ).data;
}

// ============================================================
// RISK
// ============================================================

function riskApproved(openCount, spread, atrValue) {
  resetDaily();

  if (!config.autoTrading || config.emergencyStop) {
    return [false, "Automated trading is disabled or stopped"];
  }

  if (openCount >= config.maxOpenTrades) {
    return [
      false,
      `Open trade limit reached (${openCount}/${config.maxOpenTrades})`
    ];
  }

  if (daily.count >= config.maxTradesPerDay) {
    return [
      false,
      `Daily trade limit reached (${daily.count}/${config.maxTradesPerDay})`
    ];
  }

  if (daily.realizedPnL <= -Math.abs(config.maxDailyLoss)) {
    return [
      false,
      `Daily loss limit reached ($${round(
        Math.abs(daily.realizedPnL),
        2
      )})`
    ];
  }

  if (spread > config.maxSpread) {
    return [
      false,
      `Spread too high (${round(spread, 2)} > ${config.maxSpread})`
    ];
  }

  if (!Number.isFinite(atrValue)) {
    return [false, "ATR unavailable"];
  }

  if (atrValue < config.minAtr) {
    return [
      false,
      `ATR too low (${round(atrValue, 2)} < ${config.minAtr})`
    ];
  }

  if (atrValue > config.maxAtr) {
    return [
      false,
      `ATR too high (${round(atrValue, 2)} > ${config.maxAtr})`
    ];
  }

  if (
    lastTradeAt &&
    Date.now() - lastTradeAt <
      config.cooldownSeconds * 1000
  ) {
    const remaining = Math.ceil(
      (config.cooldownSeconds * 1000 -
        (Date.now() - lastTradeAt)) /
        1000
    );

    return [
      false,
      `Cooldown active (${remaining}s remaining)`
    ];
  }

  return [true, "OK"];
}

// ============================================================
// ENGINE
// ============================================================

async function engineCycle() {
  if (cycleRunning) return;

  cycleRunning = true;

  try {
    resetDaily();

    const [quote, fresh] = await Promise.all([
      price(),
      loadCandles()
    ]);

    if (fresh.length < 55) {
      candles = fresh;

      lastSignal = {
        signal: "WAITING",
        reason: `Gathering broker candles (${fresh.length}/55 minimum)`,
        score: 0,
        maxScore: 85,
        details: {
          quote,
          candles: fresh.length
        }
      };

      return;
    }

    candles = fresh;

    const current = candles[candles.length - 1];
    const values = candles.map((c) => c.close);

    const structure = marketStructure(candles);
    const m = {
      price: quote.price,
      bid: quote.bid,
      offer: quote.offer,
      spread: quote.spread,

      e9: ema(values, 9),
      e21: ema(values, 21),
      e50: ema(values, 50),

      rsi: rsi(values, 14),
      adx: adx(candles, 14),
      atr: atr(candles, 14),

      structure,
      momentum: momentum(candles, 3),
      candle: candleQuality(current),

      candleId: current.id,
      candleTime: current.time,

      candles: candles.length
    };

    const candidate = chooseCandidate(m);
    const scored =
      candidate === "WAITING"
        ? { score: 0, maxScore: 85, breakdown: {} }
        : scoreSignal(candidate, m);

    const newCandle = current.id !== lastCandleId;

    const formattedDetails = {
      ...m,
      e9: round(m.e9, 2),
      e21: round(m.e21, 2),
      e50: round(m.e50, 2),
      rsi: round(m.rsi, 2),
      adx: round(m.adx, 2),
      atr: round(m.atr, 2),
      momentum: round(m.momentum, 2)
    };

    let signal = candidate;
    let reason =
      candidate === "WAITING"
        ? waitingReason(candidate, m)
        : waitingReason(candidate, m);

    if (candidate !== "WAITING") {
      if (scored.score < config.minScore) {
        signal = "WAITING";
        reason = `Score ${scored.score}/85 below minimum ${config.minScore} · ${waitingReason(
          candidate,
          m
        )}`;
      } else if (m.spread > config.maxSpread) {
        signal = "WAITING";
        reason = `Spread ${round(
          m.spread,
          2
        )} is above maximum ${config.maxSpread}`;
      } else if (
        !Number.isFinite(m.atr) ||
        m.atr < config.minAtr ||
        m.atr > config.maxAtr
      ) {
        signal = "WAITING";
        reason = `ATR ${round(
          m.atr,
          2
        )} is outside ${config.minAtr}-${config.maxAtr}`;
      } else {
        reason = `Confirmed ${candidate} · Score ${scored.score}/85`;
      }
    }

    lastSignal = {
      signal,
      candidate,
      reason,
      score: scored.score,
      maxScore: 85,
      details: formattedDetails,
      breakdown: scored.breakdown,
      candle: current.id,
      newCandle,
      updatedAt: new Date().toISOString()
    };

    // A trade is evaluated once per completed/new candle when enabled.
    if (!newCandle) return;

    if (signal === "WAITING") return;

    const signalId = `${current.id}:${signal}`;

    if (
      config.oneTradePerCandle &&
      signalId === lastSignalId
    ) {
      return;
    }

    const open = (
      await positions()
    ).filter((p) => positionEpic(p) === EPIC);

    const [allowed, riskReason] = riskApproved(
      open.length,
      quote.spread,
      m.atr
    );

    if (!allowed) {
      lastSignal.signal = "WAITING";
      lastSignal.reason = riskReason;
      return;
    }

    const distanceSL = Math.max(
      m.atr * config.slAtr,
      config.minOrderDistance
    );

    const distanceTP = Math.max(
      m.atr * config.tpAtr,
      config.minOrderDistance
    );

    const stop =
      signal === "BUY"
        ? quote.price - distanceSL
        : quote.price + distanceSL;

    const target =
      signal === "BUY"
        ? quote.price + distanceTP
        : quote.price - distanceTP;

    lastSignalId = signalId;

    // Do not mark a trade as executed until the broker request succeeds.
    if (config.autoTrading && !config.emergencyStop) {
      const result = await place(
        signal,
        config.fixedSize,
        stop,
        target
      );

      const confirmed =
        result?.confirmation?.dealStatus === "ACCEPTED" ||
        result?.confirmation?.status === "ACCEPTED" ||
        result?.confirmation?.status === "OPEN" ||
        result?.dealId ||
        result?.affectedDeals?.length;

      trades.unshift({
        time: new Date().toISOString(),
        direction: signal,
        size: config.fixedSize,
        entry: quote.price,
        stopLoss: round(stop, 2),
        takeProfit: round(target, 2),
        spread: quote.spread,
        score: scored.score,
        candle: current.id,
        status: confirmed ? "OPENED" : "SUBMITTED",
        brokerResult: result
      });

      trades = trades.slice(0, 100);

      daily.count += 1;
      lastTradeAt = Date.now();

      lastSignal.reason = confirmed
        ? `${signal} opened · Score ${scored.score}/85`
        : `${signal} submitted · broker confirmation pending`;
    }
  } catch (error) {
    console.error("[ENGINE]", brokerError(error));

    lastSignal = {
      ...lastSignal,
      signal: "WAITING",
      reason: "Engine error; trade blocked",
      error: brokerError(error),
      updatedAt: new Date().toISOString()
    };
  } finally {
    cycleRunning = false;
  }
}

// ============================================================
// ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "GoldWebTrader Pro AI",
    mode: DEMO ? "DEMO" : "LIVE",
    autoTrading: config.autoTrading,
    resolution: RESOLUTION,
    epic: EPIC,
    engineRunning: cycleRunning,
    candleCount: candles.length,
    time: new Date().toISOString()
  });
});

app.get("/capital/test", async (req, res) => {
  try {
    const s = await getSession();
    const [gold, accountInfo] = await Promise.all([
      price(),
      account()
    ]);

    res.json({
      ok: true,
      broker: "Capital.com",
      mode: DEMO ? "DEMO" : "LIVE",
      authenticated: true,
      tradingEnabled: true,
      accountType: accountInfo?.accounts?.[0]?.accountType || null,
      currency: accountInfo?.accounts?.[0]?.currency || null,
      currentAccountId: s.accountId || null,
      gold: gold
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      authenticated: false,
      error: brokerError(e)
    });
  }
});

app.get("/capital/market", auth, async (req, res) => {
  try {
    res.json({
      ok: true,
      market: await getMarket()
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: brokerError(e)
    });
  }
});

app.get("/capital/candles", auth, async (req, res) => {
  try {
    const data = await loadCandles();

    res.json({
      ok: true,
      epic: EPIC,
      resolution: RESOLUTION,
      count: data.length,
      candles: data
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: brokerError(e)
    });
  }
});

app.get("/engine/status", async (req, res) => {
  try {
    const [gold, currentPositions, accountInfo] =
      await Promise.all([
        price(),
        positions(),
        account()
      ]);

    res.json({
      ok: true,

      system: {
        mode: DEMO ? "DEMO" : "LIVE",
        autoTrading: config.autoTrading,
        resolution: RESOLUTION,
        epic: EPIC,
        quote: gold,

        indicators: lastSignal.details || {},
        signal: lastSignal,

        candles: candles.length,

        positions: currentPositions,
        goldPositions: currentPositions.filter(
          (p) => positionEpic(p) === EPIC
        ),

        account: accountInfo,

        strategy: {
          minScore: config.minScore,
          maxScore: 85,
          maxSpread: config.maxSpread,
          minAtr: config.minAtr,
          maxAtr: config.maxAtr,
          slAtr: config.slAtr,
          tpAtr: config.tpAtr,
          cooldownSeconds: config.cooldownSeconds
        },

        daily
      }
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: brokerError(e)
    });
  }
});

app.get("/engine/signal", (req, res) => {
  res.json({
    ok: true,
    signal: lastSignal
  });
});

app.get("/engine/history", auth, (req, res) => {
  res.json({
    ok: true,
    history: trades.map(publicTrade)
  });
});

app.post("/engine/start", auth, (req, res) => {
  config.autoTrading = true;
  config.emergencyStop = false;

  res.json({
    ok: true,
    message: "Automated trading enabled",
    config
  });
});

app.post("/engine/stop", auth, (req, res) => {
  config.autoTrading = false;
  config.emergencyStop = true;

  res.json({
    ok: true,
    message: "Emergency stop activated",
    config
  });
});

app.post("/engine/config", auth, (req, res) => {
  const allowed = [
    "maxOpenTrades",
    "maxTradesPerDay",
    "maxDailyLoss",
    "riskPercent",
    "fixedSize",
    "maxSpread",
    "minScore",
    "cooldownSeconds",
    "slAtr",
    "tpAtr",
    "maxAtr",
    "minAtr",
    "minOrderDistance"
  ];

  const updates = {};

  for (const key of allowed) {
    if (req.body?.[key] !== undefined) {
      const value = Number(req.body[key]);

      if (Number.isFinite(value)) {
        updates[key] = value;
      }
    }
  }

  Object.assign(config, updates);

  res.json({
    ok: true,
    config
  });
});

app.get("/capital/price", auth, async (req, res) => {
  try {
    res.json({
      ok: true,
      gold: await price()
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: brokerError(e)
    });
  }
});

app.get("/capital/account", auth, async (req, res) => {
  try {
    res.json({
      ok: true,
      account: await account()
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: brokerError(e)
    });
  }
});

app.get("/capital/positions", auth, async (req, res) => {
  try {
    const all = await positions();

    res.json({
      ok: true,
      positions: all,
      goldPositions: all.filter(
        (p) => positionEpic(p) === EPIC
      )
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: brokerError(e)
    });
  }
});

app.post("/capital/trade", auth, async (req, res) => {
  try {
    const direction = String(
      req.body?.direction || ""
    ).toUpperCase();

    const size = Number(req.body?.size);
    const stopLevel = Number(req.body?.stopLevel);
    const profitLevel = Number(req.body?.profitLevel);

    if (!["BUY", "SELL"].includes(direction)) {
      return res.status(400).json({
        ok: false,
        error: "direction must be BUY or SELL"
      });
    }

    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({
        ok: false,
        error: "size must be a positive number"
      });
    }

    if (
      !Number.isFinite(stopLevel) ||
      !Number.isFinite(profitLevel)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "stopLevel and profitLevel must be valid numbers"
      });
    }

    const result = await place(
      direction,
      size,
      stopLevel,
      profitLevel
    );

    res.json({
      ok: true,
      result
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: brokerError(e)
    });
  }
});

app.delete(
  "/capital/positions/:dealId",
  auth,
  async (req, res) => {
    try {
      res.json({
        ok: true,
        result: await close(req.params.dealId)
      });
    } catch (e) {
      res.status(400).json({
        ok: false,
        error: brokerError(e)
      });
    }
  }
);

// Static dashboard remains in public/index.html.
app.use(
  express.static(path.join(__dirname, "public"))
);

// ============================================================
// START
// ============================================================

setInterval(engineCycle, POLL_MS);

app.listen(PORT, () => {
  console.log(
    `GoldWebTrader Pro AI listening on ${PORT} (${
      DEMO ? "DEMO" : "LIVE"
    })`
  );

  console.log(
    `Strategy: ${EPIC} ${RESOLUTION} | ` +
      `minScore=${config.minScore}/85 | ` +
      `autoTrading=${config.autoTrading}`
  );

  // Run the first engine cycle immediately.
  engineCycle().catch((e) =>
    console.error("[STARTUP ENGINE]", brokerError(e))
  );
});
