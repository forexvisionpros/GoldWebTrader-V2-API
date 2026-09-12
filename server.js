const http = require("http");
const crypto = require("crypto");

// ============================================================
// GOLDWEBTRADER V2
// VOLATILITY 75 (1s) SERVER-SIDE ENGINE V1
// KELVIN NGUGI
// ============================================================

const PORT = process.env.PORT || 8080;

// ------------------------------------------------------------
// DERIV OAUTH
// ------------------------------------------------------------
const CLIENT_ID = "34mYGgOOHIhBdXWQDR91Y";

const REDIRECT_URI =
  "https://goldwebtrader-v2-api.onrender.com/oauth/callback";

const DERIV_API = "https://api.derivws.com";

// IMPORTANT:
// Put your Deriv OAuth client secret in Render Environment Variables.
// Variable name: DERIV_CLIENT_SECRET
const CLIENT_SECRET = process.env.DERIV_CLIENT_SECRET || "";

// Optional API key for the dashboard.
const API_KEY =
  process.env.API_KEY || "CHANGE_THIS_API_KEY";

// ------------------------------------------------------------
// APPLICATION STATE
// ------------------------------------------------------------
const state = {
  server: {
    started: new Date().toISOString(),
    version: "V75-SERVER-V1"
  },

  oauth: {
    connected: false,
    accountType: "demo",
    loginid: null,
    tokenStored: false
  },

  market: {
    connected: false,
    symbol: "1HZ100V",
    price: null,
    epoch: null,
    lastUpdate: null,
    error: null
  },

  engine: {
    enabled: true,
    executeTrades: false,

    symbol: "1HZ100V",

    timeframeSeconds: 60,

    emaFast: 9,
    emaSlow: 21,

    rsiLength: 14,
    rsiBuyMin: 55,
    rsiSellMax: 45,

    momentumBars: 3,

    cooldownSeconds: 60,

    maxSignals: 20,

    demoStake: 1,

    status: "WAITING",
    lastSignal: null,
    lastSignalTime: null,
    signalsToday: 0
  },

  websocket: {
    connected: false,
    authenticated: false,
    error: null
  },

  candles: [],

  positions: [],

  logs: []
};

// ------------------------------------------------------------
// TEMPORARY OAUTH STORAGE
// ------------------------------------------------------------
const oauthSessions = new Map();

// ------------------------------------------------------------
// LOGGING
// ------------------------------------------------------------
function log(message) {
  const entry = {
    time: new Date().toISOString(),
    message
  };

  state.logs.unshift(entry);

  if (state.logs.length > 100) {
    state.logs.pop();
  }

  console.log(`[${entry.time}] ${message}`);
}

// ------------------------------------------------------------
// JSON RESPONSE
// ------------------------------------------------------------
function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-API-Key",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS"
  });

  res.end(body);
}

// ------------------------------------------------------------
// API AUTHENTICATION
// ------------------------------------------------------------
function authorized(req) {
  // Allow health and OAuth endpoints without API key.
  if (
    req.url === "/" ||
    req.url.startsWith("/health") ||
    req.url.startsWith("/oauth")
  ) {
    return true;
  }

  const supplied =
    req.headers["x-api-key"] ||
    (req.headers.authorization || "").replace(
      /^Bearer\s+/i,
      ""
    );

  return supplied === API_KEY;
}

// ------------------------------------------------------------
// URL QUERY PARSER
// ------------------------------------------------------------
function queryParams(url) {
  const result = {};

  const index = url.indexOf("?");

  if (index === -1) {
    return result;
  }

  const query = url.substring(index + 1);

  for (const part of query.split("&")) {
    const [key, value] = part.split("=");

    if (key) {
      result[
        decodeURIComponent(key)
      ] = decodeURIComponent(value || "");
    }
  }

  return result;
}

// ------------------------------------------------------------
// BODY READER
// ------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();

      if (body.length > 1024 * 1024) {
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

// ============================================================
// DERIV OAUTH
// ============================================================

function createOAuthState() {
  return crypto.randomBytes(32).toString("hex");
}

function oauthURL() {
  const oauthState = createOAuthState();

  oauthSessions.set(oauthState, {
    created: Date.now()
  });

  const params = new URLSearchParams({
    app_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state: oauthState
  });

  return {
    state: oauthState,
    url:
      `https://oauth.deriv.com/oauth2/authorize?${params.toString()}`
  };
}

// ------------------------------------------------------------
// OAUTH CODE EXCHANGE
// ------------------------------------------------------------
async function exchangeOAuthCode(code) {
  if (!CLIENT_SECRET) {
    throw new Error(
      "DERIV_CLIENT_SECRET is missing from Render Environment Variables."
    );
  }

  const response = await fetch(
    `${DERIV_API}/oauth2/token`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI
      })
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `OAuth response was not JSON: ${text}`
    );
  }

  if (!response.ok || data.error) {
    throw new Error(
      data.error_description ||
      data.error ||
      "OAuth token exchange failed."
    );
  }

  return data;
}

// ============================================================
// DERIV WEBSOCKET
// ============================================================

let ws = null;
let reconnectTimer = null;
let connecting = false;

function connectDerivWebSocket() {
  if (connecting) return;

  if (!state.oauth.tokenStored) {
    log("Waiting for Deriv OAuth token.");
    return;
  }

  connecting = true;

  try {
    const WebSocket =
      require("ws");

    ws = new WebSocket(
      "wss://ws.derivws.com/websockets/v3"
    );

    ws.onopen = () => {
      log("Deriv WebSocket connected.");

      state.websocket.connected = true;
      state.websocket.error = null;

      connecting = false;

      authenticateWebSocket();
    };

    ws.onmessage = event => {
      try {
        const message =
          JSON.parse(event.data);

        handleDerivMessage(message);
      } catch (error) {
        log(
          "WebSocket message parse error: " +
          error.message
        );
      }
    };

    ws.onerror = error => {
      console.error(
        "V75 WebSocket error:",
        error
      );

      state.websocket.connected = false;
      state.market.connected = false;
      state.websocket.error =
        "WebSocket connection error";

      connecting = false;
    };

    ws.onclose = () => {
      log(
        "V75 authenticated WebSocket closed."
      );

      state.websocket.connected = false;
      state.websocket.authenticated = false;
      state.market.connected = false;

      connecting = false;

      scheduleReconnect();
    };

  } catch (error) {
    connecting = false;

    state.websocket.error =
      error.message;

    log(
      "WebSocket startup error: " +
      error.message
    );

    scheduleReconnect();
  }
}

// ------------------------------------------------------------
// RECONNECT
// ------------------------------------------------------------
function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    connectDerivWebSocket();
  }, 5000);
}

// ------------------------------------------------------------
// AUTHENTICATE
// ------------------------------------------------------------
function authenticateWebSocket() {
  if (!ws) return;

  // Token is stored in memory after OAuth.
  if (!state.oauth.token) {
    log("No OAuth token available.");
    return;
  }

  ws.send(
    JSON.stringify({
      authorize: state.oauth.token
    })
  );
}

// ------------------------------------------------------------
// REQUEST TICKS
// ------------------------------------------------------------
function subscribeToMarket() {
  if (
    !ws ||
    state.websocket.authenticated
      !== true
  ) {
    return;
  }

  ws.send(
    JSON.stringify({
      ticks: state.engine.symbol,
      subscribe: 1
    })
  );

  log(
    `Subscribed to ${state.engine.symbol} ticks.`
  );
}

// ------------------------------------------------------------
// REQUEST CANDLES
// ------------------------------------------------------------
function requestCandles() {
  if (
    !ws ||
    state.websocket.authenticated
      !== true
  ) {
    return;
  }

  ws.send(
    JSON.stringify({
      ticks_history:
        state.engine.symbol,

      adjust_start_time: 1,

      count: 100,

      end: "latest",

      granularity:
        state.engine.timeframeSeconds,

      style: "candles"
    })
  );
}

// ============================================================
// DERIV MESSAGE HANDLER
// ============================================================

function handleDerivMessage(message) {
  if (message.error) {
    log(
      "Deriv error: " +
      (
        message.error.message ||
        JSON.stringify(message.error)
      )
    );

    state.market.error =
      message.error.message ||
      "Deriv API error";

    return;
  }

  // ----------------------------------------------------------
  // AUTHORIZATION
  // ----------------------------------------------------------
  if (message.msg_type === "authorize") {
    state.websocket.authenticated =
      true;

    state.oauth.connected = true;
    state.oauth.loginid =
      message.authorize?.loginid ||
      null;

    state.oauth.accountType =
      message.authorize?.is_virtual
        ? "demo"
        : "real";

    state.market.error = null;

    log(
      `Deriv authenticated: ${
        state.oauth.loginid || "unknown"
      }`
    );

    subscribeToMarket();
    requestCandles();

    return;
  }

  // ----------------------------------------------------------
  // TICK
  // ----------------------------------------------------------
  if (message.msg_type === "tick") {
    const tick = message.tick;

    if (!tick) return;

    state.market.connected = true;

    state.market.symbol =
      tick.symbol ||
      state.engine.symbol;

    state.market.price =
      Number(tick.quote);

    state.market.epoch =
      Number(tick.epoch);

    state.market.lastUpdate =
      new Date().toISOString();

    return;
  }

  // ----------------------------------------------------------
  // CANDLES
  // ----------------------------------------------------------
  if (message.msg_type === "candles") {
    if (Array.isArray(message.candles)) {
      state.candles =
        message.candles
          .map(candle => ({
            epoch:
              Number(candle.epoch),

            open:
              Number(candle.open),

            high:
              Number(candle.high),

            low:
              Number(candle.low),

            close:
              Number(candle.close)
          }))
          .filter(
            candle =>
              Number.isFinite(
                candle.close
              )
          );

      if (
        state.candles.length >=
        state.engine.emaSlow + 5
      ) {
        state.engine.status =
          "READY";
      }

      log(
        `Loaded ${state.candles.length} V75 candles.`
      );

      evaluateEngine();
    }

    return;
  }
}

// ============================================================
// INDICATORS
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
      (
        values[i] - ema
      ) *
      multiplier +
      ema;
  }

  return ema;
}

// ------------------------------------------------------------
// RSI
// ------------------------------------------------------------
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

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain =
    gains / period;

  let averageLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? Math.abs(change)
        : 0;

    averageGain =
      (
        averageGain *
        (period - 1) +
        gain
      ) /
      period;

    averageLoss =
      (
        averageLoss *
        (period - 1) +
        loss
      ) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return 100 -
    100 /
      (1 + rs);
}

// ------------------------------------------------------------
// MOMENTUM
// ------------------------------------------------------------
function calculateMomentum(
  values,
  bars
) {
  if (
    values.length <= bars
  ) {
    return 0;
  }

  return (
    values[values.length - 1] -
    values[
      values.length - 1 - bars
    ]
  );
}

// ============================================================
// SIGNAL ENGINE
// ============================================================

function evaluateEngine() {
  if (!state.engine.enabled) {
    state.engine.status =
      "DISABLED";

    return;
  }

  if (
    state.candles.length <
    state.engine.emaSlow + 5
  ) {
    state.engine.status =
      "WAITING_FOR_DATA";

    return;
  }

  const closes =
    state.candles.map(
      candle => candle.close
    );

  const emaFast =
    calculateEMA(
      closes,
      state.engine.emaFast
    );

  const emaSlow =
    calculateEMA(
      closes,
      state.engine.emaSlow
    );

  const rsi =
    calculateRSI(
      closes,
      state.engine.rsiLength
    );

  const momentum =
    calculateMomentum(
      closes,
      state.engine.momentumBars
    );

  if (
    emaFast === null ||
    emaSlow === null ||
    rsi === null
  ) {
    state.engine.status =
      "WAITING_FOR_INDICATORS";

    return;
  }

  let signal = "WAIT";

  // ----------------------------------------------------------
  // BUY
  // ----------------------------------------------------------
  if (
    emaFast > emaSlow &&
    rsi >= state.engine.rsiBuyMin &&
    momentum > 0
  ) {
    signal = "BUY";
  }

  // ----------------------------------------------------------
  // SELL
  // ----------------------------------------------------------
  else if (
    emaFast < emaSlow &&
    rsi <= state.engine.rsiSellMax &&
    momentum < 0
  ) {
    signal = "SELL";
  }

  state.engine.status =
    signal === "WAIT"
      ? "WAITING"
      : "SIGNAL";

  if (signal !== "WAIT") {
    processSignal({
      signal,
      price:
        closes[closes.length - 1],
      emaFast,
      emaSlow,
      rsi,
      momentum
    });
  }
}

// ============================================================
// SIGNAL PROCESSING
// ============================================================

function processSignal(data) {
  const now = Date.now();

  // Cooldown
  if (
    state.engine.lastSignalTime &&
    now -
      state.engine.lastSignalTime <
      state.engine.cooldownSeconds *
        1000
  ) {
    state.engine.status =
      "COOLDOWN";

    return;
  }

  // Daily signal limit
  if (
    state.engine.signalsToday >=
    state.engine.maxSignals
  ) {
    state.engine.status =
      "MAX_SIGNALS_REACHED";

    return;
  }

  state.engine.lastSignal =
    data.signal;

  state.engine.lastSignalTime =
    now;

  state.engine.signalsToday++;

  log(
    `V75 SIGNAL: ${data.signal} | Price=${data.price} | RSI=${data.rsi.toFixed(
      2
    )} | EMA${state.engine.emaFast}=${data.emaFast.toFixed(
      2
    )} | EMA${state.engine.emaSlow}=${data.emaSlow.toFixed(
      2
    )}`
  );

  // ----------------------------------------------------------
  // SAFETY
  // ----------------------------------------------------------
  // Trading is deliberately disabled in V1.
  // Set executeTrades=true only after demo testing.
  if (state.engine.executeTrades) {
    executeTrade(data);
  }
}

// ============================================================
// TRADE EXECUTION PLACEHOLDER
// ============================================================

async function executeTrade(data) {
  log(
    `TRADE EXECUTION REQUESTED: ${data.signal}`
  );

  // V1 intentionally does not send a Deriv contract.
  // This protects the demo account while the signal
  // engine is being tested.

  state.engine.status =
    "TRADE_BLOCKED_V1";
}

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {

      // ------------------------------------------------------
      // CORS PREFLIGHT
      // ------------------------------------------------------
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin":
            "*",

          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-API-Key",

          "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS"
        });

        res.end();
        return;
      }

      const url =
        req.url.split("?")[0];

      // ------------------------------------------------------
      // ROOT
      // ------------------------------------------------------
      if (
        req.method === "GET" &&
        url === "/"
      ) {
        sendJSON(res, 200, {
          ok: true,

          name:
            "GoldWebTrader V2",

          engine:
            "Volatility 75 (1s) Server-Side Engine",

          version:
            "V75-SERVER-V1",

          status:
            state.engine.status,

          symbol:
            state.engine.symbol,

          demoMode:
            state.oauth.accountType ===
            "demo",

          executeTrades:
            state.engine.executeTrades
        });

        return;
      }

      // ------------------------------------------------------
      // HEALTH
      // ------------------------------------------------------
      if (
        req.method === "GET" &&
        url === "/health"
      ) {
        sendJSON(res, 200, {
          ok: true,
          server: "online",
          uptime: process.uptime(),
          time:
            new Date().toISOString()
        });

        return;
      }

      // -------
   ------------------------------------------------------
      // OAUTH LOGIN
      // ------------------------------------------------------
      if (
        req.method === "GET" &&
        url === "/oauth/login"
      ) {
        try {
          const result =
            oauthURL();

          res.writeHead(302, {
            Location: result.url
          });

          res.end();

        } catch (error) {
          sendJSON(res, 500, {
            ok: false,
            error: error.message
          });
        }

        return;
      }

      // ------------------------------------------------------
      // OAUTH CALLBACK
      // ------------------------------------------------------
      if (
        req.method === "GET" &&
        url === "/oauth/callback"
      ) {
        const params =
          queryParams(req.url);

        const code =
          params.code;

        const oauthState =
          params.state;

        if (!code) {
          sendJSON(res, 400, {
            ok: false,
            error:
              "OAuth authorization code missing."
          });

          return;
        }

        if (
          !oauthState ||
          !oauthSessions.has(oauthState)
        ) {
          sendJSON(res, 400, {
            ok: false,
            error:
              "Invalid or expired OAuth state."
          });

          return;
        }

        oauthSessions.delete(
          oauthState
        );

        try {
          const tokenData =
            await exchangeOAuthCode(
              code
            );

          /*
           * OAuth tokens are kept in server memory.
           * For a production system, use encrypted
           * persistent storage.
           */

          state.oauth.token =
            tokenData.access_token ||
            tokenData.token ||
            null;

          state.oauth.tokenStored =
            Boolean(
              state.oauth.token
            );

          state.oauth.connected =
            Boolean(
              state.oauth.token
            );

          log(
            "Deriv OAuth authentication completed successfully."
          );

          if (
            state.oauth.tokenStored
          ) {
            connectDerivWebSocket();
          }

          sendJSON(res, 200, {
            ok: true,

            message:
              "Deriv Connected",

            oauth:
              "Authentication completed successfully",

            demoMode:
              state.oauth.accountType ===
              "demo",

            tokenStored:
              state.oauth.tokenStored,

            next:
              "You can close this page and return to GoldWebTrader."
          });

        } catch (error) {
          log(
            "OAuth callback error: " +
            error.message
          );

          sendJSON(res, 500, {
            ok: false,
            error: error.message
          });
        }

        return;
      }

      // ------------------------------------------------------
      // AUTHENTICATED API ROUTES
      // ------------------------------------------------------
      if (!authorized(req)) {
        sendJSON(res, 401, {
          ok: false,
          error:
            "Unauthorized. Invalid API key."
        });

        return;
      }

      // ------------------------------------------------------
      // STATUS
      // ------------------------------------------------------
      if (
        req.method === "GET" &&
        (
          url === "/status" ||
          url === "/api/status" ||
          url === "/v75/status"
        )
      ) {
        sendJSON(res, 200, {
          ok: true,

          server:
            state.server,

          oauth: {
            connected:
              state.oauth.connected,

            accountType:
              state.oauth.accountType,

            loginid:
              state.oauth.loginid,

            tokenStored:
              state.oauth.tokenStored
          },

          websocket:
            state.websocket,

          market:
            state.market,

          engine:
            {
              ...state.engine,
              tokenStored:
                undefined
            },

          candles:
            state.candles.length,

          positions:
            state.positions.length
        });

        return;
      }

      // ------------------------------------------------------
      // V75 ENGINE STATUS
      // ------------------------------------------------------
      if (
        req.method === "GET" &&
        url === "/v75/engine/status"
      ) {
        sendJSON(res, 200, {
          ok: true,

          engine:
            state.engine,

          market:
            state.market,

          indicators:
            getIndicatorSnapshot()
        });

        return;
      }

      // ------------------------------------------------------
      // MARKET STATUS
      // ------------------------------------------------------
      if (
        req.method === "GET" &&
        url === "/market"
      ) {
        sendJSON(res, 200, {
          ok: true,
          market: state.market,
          candles:
            state.candles.length
        });

        return;
      }

      // ------------------------------------------------------
      // LOGS
      // ------------------------------------------------------
      if (
        req.method === "GET" &&
        url === "/logs"
      ) {
        sendJSON(res, 200, {
          ok: true,
          logs: state.logs
        });

        return;
      }

      // ------------------------------------------------------
      // ENGINE SETTINGS
      // ------------------------------------------------------
      if (
        req.method === "POST" &&
        url === "/v75/engine/settings"
      ) {
        const body =
          await readBody(req);

        if (
          typeof body.enabled ===
          "boolean"
        ) {
          state.engine.enabled =
            body.enabled;
        }

        if (
          typeof body.executeTrades ===
          "boolean"
        ) {
          state.engine.executeTrades =
            body.executeTrades;
        }

        if (
          Number.isFinite(
            Number(body.cooldownSeconds)
          )
        ) {
          state.engine.cooldownSeconds =
            Math.max(
              0,
              Number(
                body.cooldownSeconds
              )
            );
        }

        if (
          Number.isFinite(
            Number(body.maxSignals)
          )
        ) {
          state.engine.maxSignals =
            Math.max(
              1,
              Number(
                body.maxSignals
              )
            );
        }

        if (
          Number.isFinite(
            Number(body.demoStake)
          )
        ) {
          state.engine.demoStake =
            Math.max(
              0.35,
              Number(
                body.demoStake
              )
            );
        }

        log(
          "V75 engine settings updated."
        );

        sendJSON(res, 200, {
          ok: true,
          engine:
            state.engine
        });

        return;
      }

      // ------------------------------------------------------
      // ENGINE START
      // ------------------------------------------------------
      if (
        req.method === "POST" &&
        url === "/v75/engine/start"
      ) {
        state.engine.enabled =
          true;

        log(
          "V75 engine STARTED."
        );

        sendJSON(res, 200, {
          ok: true,
          status:
            state.engine.status
        });

        return;
      }

      // ------------------------------------------------------
      // ENGINE STOP
      // ------------------------------------------------------
      if (
        req.method === "POST" &&
        url === "/v75/engine/stop"
      ) {
        state.engine.enabled =
          false;

        state.engine.status =
          "DISABLED";

        log(
          "V75 engine STOPPED."
        );

        sendJSON(res, 200, {
          ok: true,
          status:
            state.engine.status
        });

        return;
      }

      // ------------------------------------------------------
      // MANUAL CANDLE REFRESH
      // ------------------------------------------------------
      if (
        req.method === "POST" &&
        url === "/v75/engine/refresh"
      ) {
        requestCandles();

        sendJSON(res, 200, {
          ok: true,
          message:
            "Candle refresh requested."
        });

        return;
      }

      // ------------------------------------------------------
      // 404
      // ------------------------------------------------------
      sendJSON(res, 404, {
        ok: false,
        error:
          "Not found",
        path: url
      });
    }
  );

// ============================================================
// INDICATOR SNAPSHOT
// ============================================================

function getIndicatorSnapshot() {
  if (
    state.candles.length <
    state.engine.emaSlow
  ) {
    return {
      ready: false
    };
  }

  const closes =
    state.candles.map(
      candle => candle.close
    );

  return {
    ready: true,

    price:
      closes[closes.length - 1],

    emaFast:
      calculateEMA(
        closes,
        state.engine.emaFast
      ),

    emaSlow:
      calculateEMA(
        closes,
        state.engine.emaSlow
      ),

    rsi:
      calculateRSI(
        closes,
        state.engine.rsiLength
      ),

    momentum:
      calculateMomentum(
        closes,
        state.engine.momentumBars
      )
  };
}

// ============================================================
// PERIODIC ENGINE
// ============================================================

setInterval(() => {
  if (
    state.websocket.authenticated
  ) {
    requestCandles();
  }

  evaluateEngine();

}, state.engine.timeframeSeconds * 1000);

// ============================================================
// START SERVER
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    log(
      `GoldWebTrader V2 running on port ${PORT}`
    );

    log(
      "V75 (1s) server-side engine initialized."
    );

    log(
      "Trade execution is DISABLED for safe demo testing."
    );

    log(
      "Waiting for Deriv OAuth connection..."
    );
  }
);

// ============================================================
// PROCESS SAFETY
// ============================================================

process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);
   
