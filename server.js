const http = require("http");
const crypto = require("crypto");

// ============================================================
// GOLDWEBTRADER V2
// VOLATILITY 75 (1s) SERVER-SIDE ENGINE V1
// ============================================================

const PORT = process.env.PORT || 8080;

const CLIENT_ID = "34mYGgOOHIhBdXWQDR91Y";

const REDIRECT_URI =
  "https://goldwebtrader-v2-api.onrender.com/oauth/callback";

const DERIV_API = "https://api.derivws.com";

const SYMBOL = "1HZ100V";

// ============================================================
// ENGINE SETTINGS
// ============================================================

const ENGINE = {
  enabled: true,

  // V1 is SIGNAL ONLY.
  // No real/demo order will be sent.
  executeTrades: false,

  timeframeSeconds: 60,

  emaFast: 9,
  emaSlow: 21,
  rsiLength: 14,

  rsiBuyMin: 55,
  rsiSellMax: 45,

  momentumBars: 3,

  cooldownSeconds: 60,

  // Maximum number of generated signals per session.
  maxSignals: 20,

  // Deriv uses stake rather than MT5 lot size.
  demoStake: 1
};

// ============================================================
// OAUTH STATE
// ============================================================

let oauthState = null;
let codeVerifier = null;

let derivAuth = {
  authenticated: false,
  accessToken: null,
  expiresAt: 0
};

// ============================================================
// ACCOUNT
// ============================================================

let demoAccount = {
  id: null,
  balance: 0,
  currency: "USD",
  accountType: "demo"
};

// ============================================================
// WEBSOCKET
// ============================================================

let ws = null;
let reconnectTimer = null;
let connecting = false;

// ============================================================
// MARKET DATA
// ============================================================

let ticks = [];

let candles = [];

let currentCandle = null;

let lastTick = {
  price: 0,
  epoch: null,
  time: null
};

// ============================================================
// INDICATORS
// ============================================================

let indicators = {
  emaFast: null,
  emaSlow: null,
  rsi: null,
  momentum: null
};

// ============================================================
// ENGINE STATE
// ============================================================

let engineState = {
  status: "WAITING",

  reason:
    "Waiting for enough Volatility 75 (1s) data.",

  signal: "NONE",

  lastSignal: null,

  lastSignalTime: null,

  signalsToday: 0,

  lastTradeAttempt: null,

  executionEnabled: false
};

// ============================================================
// PORTFOLIO
// ============================================================

let portfolioState = {
  positions: 0,
  lastUpdate: null
};

// ============================================================
// GENERAL STATE
// ============================================================

let state = {
  broker: "Deriv",

  mode: "DEMO",

  authenticated: false,

  account: {
    id: null,
    type: "demo",
    balance: 0,
    currency: "USD"
  },

  websocket: {
    connected: false,
    lastConnected: null,
    lastMessage: null,
    error: null
  },

  market: {
    connected: false,
    symbol: SYMBOL,
    price: 0,
    epoch: null,
    lastUpdate: null,
    error: null
  },

  engine: engineState,

  indicators,

  portfolio: portfolioState,

  trading: {
    enabled: false,
    tradesEnabled: false
  }
};

// ============================================================
// HTTP HELPERS
// ============================================================

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body)
  });

  res.end(body);
}

function htmlResponse(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html)
  });

  res.end(html);
}

function errorMessage(error) {
  if (!error) return "Unknown error";

  if (typeof error === "string") {
    return error;
  }

  return error.message ||
    JSON.stringify(error);
}

// ============================================================
// PKCE
// ============================================================

function randomString(bytes = 32) {
  return crypto
    .randomBytes(bytes)
    .toString("base64url");
}

function codeChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

// ============================================================
// DERIV REST
// ============================================================

async function derivFetch(path, options = {}) {
  if (!derivAuth.accessToken) {
    throw new Error(
      "Deriv OAuth session is not authenticated."
    );
  }

  const response = await fetch(
    `${DERIV_API}${path}`,
    {
      ...options,

      headers: {
        ...(options.headers || {}),
        Authorization:
          `Bearer ${derivAuth.accessToken}`,

        "Content-Type":
          "application/json"
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    throw new Error(
      `Deriv API ${response.status}: ` +
      (
        data?.errors?.[0]?.message ||
        data?.message ||
        text ||
        "Request failed"
      )
    );
  }

  return data;
}

// ============================================================
// FIND DEMO ACCOUNT
// ============================================================

async function findDemoAccount() {
  const result =
    await derivFetch(
      "/trading/v1/options/accounts"
    );

  const accounts =
    Array.isArray(result?.data)
      ? result.data
      : [];

  const demo =
    accounts.find(
      account =>
        String(account.account_type)
          .toLowerCase() === "demo"
    );

  if (!demo) {
    throw new Error(
      "No DEMO account found."
    );
  }

  demoAccount.id =
    demo.account_id;

  demoAccount.balance =
    Number(demo.balance || 0);

  demoAccount.currency =
    demo.currency || "USD";

  state.account.id =
    demo.account_id;

  state.account.type =
    "demo";

  state.account.balance =
    demoAccount.balance;

  state.account.currency =
    demoAccount.currency;

  return demo;
}

// ============================================================
// REQUEST NEW AUTHENTICATED WEBSOCKET URL
// ============================================================

async function requestDemoWebSocketUrl() {
  if (!derivAuth.accessToken) {
    throw new Error(
      "No Deriv access token."
    );
  }

  if (
    derivAuth.expiresAt &&
    Date.now() >=
      derivAuth.expiresAt - 30000
  ) {
    throw new Error(
      "OAuth session expired. Please log in again."
    );
  }

  if (!demoAccount.id) {
    await findDemoAccount();
  }

  const result =
    await derivFetch(
      `/trading/v1/options/accounts/` +
      `${encodeURIComponent(demoAccount.id)}/otp`,
      {
        method: "POST"
      }
    );

  const url =
    result?.data?.url;

  if (!url) {
    throw new Error(
      "No authenticated WebSocket URL returned."
    );
  }

  return url;
}

// ============================================================
// EMA
// ============================================================

function calculateEMA(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const multiplier =
    2 / (period + 1);

  let ema = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    ema += values[i];
  }

  ema /= period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    ema =
      (values[i] - ema) *
      multiplier +
      ema;
  }

  return ema;
}

// ============================================================
// RSI
// ============================================================

function calculateRSI(values, period) {
  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    const gain =
      change > 0 ? change : 0;

    const loss =
      change < 0
        ? Math.abs(change)
        : 0;

    avgGain =
      ((avgGain * (period - 1)) +
        gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) +
        loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 -
    (100 / (1 + rs));
}

// ============================================================
// BUILD 1-MINUTE CANDLE
// ============================================================

function processTick(price, epoch) {
  const candleTime =
    Math.floor(
      epoch /
      ENGINE.timeframeSeconds
    ) *
    ENGINE.timeframeSeconds;

  if (
    !currentCandle ||
    currentCandle.time !== candleTime
  ) {
    if (currentCandle) {
      candles.push({
        ...currentCandle
      });

      if (candles.length > 300) {
        candles.shift();
      }

      calculateIndicators();
    }

    currentCandle = {
      time: candleTime,
      open: price,
      high: price,
      low: price,
      close: price
    };

    evaluateEngine();

    return;
  }

  currentCandle.high =
    Math.max(
      currentCandle.high,
      price
    );

  currentCandle.low =
    Math.min(
      currentCandle.low,
      price
    );

  currentCandle.close =
    price;
}

// ============================================================
// CALCULATE INDICATORS
// ============================================================

function calculateIndicators() {
  const closes =
    candles.map(
      candle => candle.close
    );

  const emaFast =
    calculateEMA(
      closes,
      ENGINE.emaFast
    );

  const emaSlow =
    calculateEMA(
      closes,
      ENGINE.emaSlow
    );

  const rsi =
    calculateRSI(
      closes,
      ENGINE.rsiLength
    );

  let momentum = null;

  if (
    closes.length >
    ENGINE.momentumBars
  ) {
    momentum =
      closes[
        closes.length - 1
      ] -
      closes[
        closes.length -
        1 -
        ENGINE.momentumBars
      ];
  }

  indicators.emaFast =
    emaFast;

  indicators.emaSlow =
    emaSlow;

  indicators.rsi =
    rsi;

  indicators.momentum =
    momentum;

  state.indicators =
    indicators;
}

// ============================================================
// ENGINE
// ============================================================

function evaluateEngine() {
  if (!ENGINE.enabled) {
    engineState.status =
      "DISABLED";

    engineState.reason =
      "Trading engine disabled.";

    return;
  }

  if (
    candles.length <
    ENGINE.emaSlow + 5
  ) {
    engineState.status =
      "BUILDING DATA";

    engineState.reason =
      `Collecting candles: ` +
      `${candles.length}/` +
      `${ENGINE.emaSlow + 5}`;

    return;
  }

  const emaFast =
    indicators.emaFast;

  const emaSlow =
    indicators.emaSlow;

  const rsi =
    indicators.rsi;

  const momentum =
    indicators.momentum;

  if (
    emaFast === null ||
    emaSlow === null ||
    rsi === null ||
    momentum === null
  ) {
    engineState.status =
      "WAITING";

    engineState.reason =
      "Waiting for indicator data.";

    return;
  }

  // ----------------------------------------
  // COOLDOWN
  // ----------------------------------------

  if (engineState.lastSignalTime) {
    const elapsed =
      Date.now() -
      engineState.lastSignalTime;

    if (
      elapsed <
      ENGINE.cooldownSeconds * 1000
    ) {
      engineState.status =
        "COOLDOWN";

      engineState.reason =
        "Waiting for signal cooldown.";

      return;
    }
  }

  // ----------------------------------------
  // SIGNAL LIMIT
  // ----------------------------------------

  if (
    engineState.signalsToday >=
    ENGINE.maxSignals
  ) {
    engineState.status =
      "LIMIT REACHED";

    engineState.reason =
      "Maximum V1 signals reached.";

    return;
  }

  // ----------------------------------------
  // BUY
  // ----------------------------------------

  if (
    emaFast > emaSlow &&
    rsi >= ENGINE.rsiBuyMin &&
    momentum > 0
  ) {
    registerSignal(
      "BUY",
      "EMA bullish + RSI confirmation + positive momentum."
    );

    return;
  }

  // ----------------------------------------
  // SELL
  // ----------------------------------------

  if (
    emaFast < emaSlow &&
    rsi <= ENGINE.rsiSellMax &&
    momentum < 0
  ) {
    registerSignal(
      "SELL",
      "EMA bearish + RSI confirmation + negative momentum."
    );

    return;
  }

  // ----------------------------------------
  // WAIT
  // ----------------------------------------

  engineState.status =
    "WAITING";

  engineState.signal =
    "NONE";

  if (emaFast > emaSlow) {
    engineState.reason =
      "Bullish trend detected, waiting for stronger confirmation.";
  } else if (emaFast < emaSlow) {
    engineState.reason =
      "Bearish trend detected, waiting for stronger confirmation.";
  } else {
    engineState.reason =
      "No clear trend.";
  }
}

// ============================================================
// REGISTER SIGNAL
// ============================================================

function registerSignal(
  direction,
  reason
) {
  const now =
    new Date().toISOString();

  engineState.status =
    "SIGNAL";

  engineState.signal =
    direction;

  engineState.reason =
    reason;

  engineState.lastSignal =
    direction;

  engineState.lastSignalTime =
    Date.now();

  engineState.signalsToday++;

  engineState.lastTradeAttempt = now;

  console.log(
    `V75 SIGNAL: ${direction} | ${reason}`
  );

  // ----------------------------------------------------------
  // IMPORTANT:
  // V1 DOES NOT EXECUTE ORDERS.
  // ----------------------------------------------------------

  if (!ENGINE.executeTrades) {
    engineState.executionEnabled =
      false;
  }
}

// ============================================================
// AUTHENTICATED WEBSOCKET
// ============================================================

async function connectAuthenticatedDemo() {
  if (connecting) {
    return;
  }

  if (
    !derivAuth.authenticated ||
    !derivAuth.accessToken
  ) {
    return;
  }

  connecting = true;

  try {
    if (ws) {
      try {
        ws.close();
      } catch {}
    }

    ws = null;

    const websocketUrl =
      await requestDemoWebSocketUrl();

    console.log(
      "Connecting V75 DEMO WebSocket..."
    );

    ws =
      new WebSocket(
        websocketUrl
      );

    ws.onopen = () => {
      console.log(
        "V75 authenticated WebSocket connected."
      );

      connecting = false;

      state.websocket.connected =
        true;

      state.websocket.lastConnected =
        new Date().toISOString();

      state.websocket.error =
        null;

      state.market.connected =
        true;

      // ------------------------------------
      // BALANCE
      // ------------------------------------

      ws.send(
        JSON.stringify({
          balance: 1,
          subscribe: 1,
          req_id: 101
        })
      );

      // ------------------------------------
      // PORTFOLIO
      // ------------------------------------

      ws.send(
        JSON.stringify({
          portfolio: 1,
          req_id: 102
        })
      );

      // ------------------------------------
      // V75 1S TICKS
      // ------------------------------------

      ws.send(
        JSON.stringify({
          ticks: SYMBOL,
          subscribe: 1,
          req_id: 103
        })
      );
    };

    ws.onmessage =
      event => {

        try {
          const message =
            JSON.parse(
              event.data
            );

          state.websocket.lastMessage =
            new Date().toISOString();

          // --------------------------------
          // TICK
          // --------------------------------

          if (
            message.msg_type ===
            "tick"
          ) {
            const tick =
              message.tick;

            if (tick) {
              const price =
                Number(
                  tick.quote
                );

              const epoch =
                Number(
                  tick.epoch
                );

              lastTick.price =
                price;

              lastTick.epoch =
                epoch;

              lastTick.time =
                new Date(
                  epoch * 1000
                ).toISOString();

              state.market.price =
                price;

              state.market.epoch =
                epoch;

              state.market.lastUpdate =
                new Date().toISOString();

              state.market.connected =
                true;

              processTick(
                price,
                epoch
              );
            }
          }

          // --------------------------------
          // BALANCE
          // --------------------------------

          if (
            message.msg_type ===
            "balance"
          ) {
            const balanceData =
              message.balance;

            if (balanceData) {
              demoAccount.balance =
                Number(
                  balanceData.balance || 0
                );

              demoAccount.currency =
                balanceData.currency ||
                "USD";

              state.account.balance =
                demoAccount.balance;

              state.account.currency =
                demoAccount.currency;
            }
          }

          // --------------------------------
          // PORTFOLIO
          // --------------------------------

          if (
            message.msg_type ===
            "portfolio"
          ) {
            const portfolio =
              message.portfolio;

            let contracts = [];

            if (
              Array.isArray(
                portfolio
              )
            ) {
              contracts =
                portfolio;
            }

            if (
              Array.isArray(
                portfolio?.contracts
              )
            ) {
              contracts =
                portfolio.contracts;
            }

            if (
              Array.isArray(
                portfolio?.positions
              )
            ) {
              contracts =
                portfolio.positions;
            }

            portfolioState.positions =
              contracts.length;

            portfolioState.lastUpdate =
              new Date().toISOString();
          }

          // --------------------------------
          // API ERROR
          // --------------------------------

          if (
            message.error
          ) {
            state.websocket.error =
              message.error.message ||
              message.error.code ||
              "Deriv error";

            console.error(
              "Deriv error:",
              state.websocket.error
            );
          }

        } catch (error) {

          console.error(
            "Message processing error:",
            error
          );
        }
      };

    ws.onerror = (error) => {
