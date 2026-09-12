const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ============================================================
// GOLDWEBTRADER V2
// VOLATILITY 75 (1s) SERVER-SIDE ENGINE V1
// KELVIN NGUGI
// ============================================================

const PORT = process.env.PORT || 8080;

// ------------------------------------------------------------
// DERIV OAUTH 2.0 WITH PKCE
// ------------------------------------------------------------
const CLIENT_ID = "34mYGgOOHIhBdXWQDR91Y";

const REDIRECT_URI =
  "https://goldwebtrader-v2-api.onrender.com/oauth/callback";

const DERIV_API = "https://api.derivws.com";

const DERIV_OAUTH_AUTH_ENDPOINT = "https://auth.deriv.com/oauth2/auth";
const DERIV_OAUTH_TOKEN_ENDPOINT = "https://auth.deriv.com/oauth2/token";

// IMPORTANT:
// Put your Deriv OAuth client secret in Render Environment Variables.
// Variable name: DERIV_CLIENT_SECRET
const CLIENT_SECRET = process.env.DERIV_CLIENT_SECRET || "";

// Optional API key for the dashboard.
const API_KEY =
  process.env.API_KEY || "CHANGE_THIS_API_KEY";

// Index.html cache
let indexHtmlCache = null;
let indexHtmlError = null;

// Pre-load index.html on startup
function loadIndexHtml() {
  try {
    const indexPath = path.join(__dirname, "index.html");
    indexHtmlCache = fs.readFileSync(indexPath, "utf-8");
    log("index.html loaded successfully.");
  } catch (error) {
    indexHtmlError = `Failed to load index.html: ${error.message}`;
    log(indexHtmlError);
  }
}

// Call this after log function is defined
let logReady = false;

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

  // positions holds trade history. Each position will include open/close details.
  positions: [],

  logs: []
};

// Track a single pending proposal request (we only allow one active trade at a time)
let pendingProposalRequest = null;
let activeContractId = null;

// ------------------------------------------------------------
// TEMPORARY OAUTH STORAGE (with PKCE)
// Store state, code_verifier, and timestamp for each OAuth attempt
// ------------------------------------------------------------
const oauthSessions = new Map();
const OAUTH_STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================
// PKCE HELPERS
// ============================================================

/**
 * Generate a cryptographically secure random string for code_verifier.
 * RFC 7636 requires 43-128 characters from [A-Z] [a-z] [0-9] - . _ ~
 */
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Generate code_challenge from code_verifier using SHA256.
 * RFC 7636 S256 method.
 */
function generateCodeChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

/**
 * Generate a cryptographically secure random state parameter.
 */
function generateState() {
  return crypto.randomBytes(32).toString("hex");
}

// ============================================================
// OAUTH STATE VALIDATION
// ============================================================

/**
 * Check if an OAuth state has expired.
 */
function isOAuthStateExpired(sessionData) {
  const age = Date.now() - sessionData.created;
  return age > OAUTH_STATE_EXPIRY_MS;
}

// ============================================================
// LOGGING
// ============================================================
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

// Now load index.html
logReady = true;
loadIndexHtml();

// ============================================================
// JSON RESPONSE
// ============================================================
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

// ============================================================
// HTML RESPONSE
// ============================================================
function sendHTML(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-API-Key",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS"
  });

  res.end(html);
}

// ============================================================
// API AUTHENTICATION
// ============================================================
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

// ============================================================
// URL QUERY PARSER
// ============================================================
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

// ============================================================
// BODY READER
// ============================================================
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
// DERIV OAUTH 2.0 (Authorization Code + PKCE Flow)
// ============================================================

/**
 * Build the Deriv OAuth 2.0 authorization URL with PKCE.
 * Returns: { state, codeVerifier, url }
 */
function buildOAuthAuthorizationURL() {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Store state, codeVerifier, and timestamp server-side
  oauthSessions.set(state, {
    codeVerifier,
    created: Date.now()
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "trade",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  const url = `${DERIV_OAUTH_AUTH_ENDPOINT}?${params.toString()}`;

  return {
    state,
    codeVerifier,
    url
  };
}

// ============================================================
// OAUTH TOKEN EXCHANGE (Server-side, with PKCE)
// ============================================================
/**
 * Exchange authorization code for access token.
 * Sends authorization code + code_verifier to Deriv token endpoint.
 */
async function exchangeOAuthCodeForToken(code, codeVerifier) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI
  });

  try {
    const response = await fetch(
      DERIV_OAUTH_TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      }
    );

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `OAuth token response was not JSON: ${text}`
      );
    }

    if (!response.ok || data.error) {
      throw new Error(
        data.error_description ||
        data.error ||
        "OAuth token exchange failed"
      );
    }

    return data;
  } catch (error) {
    throw new Error(`Token exchange error: ${error.message}`);
  }
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

// ============================================================
// RECONNECT
// ============================================================
function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    connectDerivWebSocket();
  }, 5000);
}

// ============================================================
// AUTHENTICATE
// ============================================================
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

// ============================================================
// REQUEST TICKS
// ============================================================
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

// ============================================================
// REQUEST CANDLES
// ============================================================
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

  // ----------------------------------------------------------
  // PROPOSAL (response to a proposal request)
  // ----------------------------------------------------------
  if (message.msg_type === "proposal") {
    const proposal = message.proposal;

    if (!proposal) return;

    // We only proceed if we have a pending proposal request
    if (!pendingProposalRequest) {
      // unexpected proposal; ignore
      return;
    }

    // only proceed if contract types match (safety)
    if (
      pendingProposalRequest.contract_type &&
      proposal.contract_type &&
      pendingProposalRequest.contract_type !== proposal.contract_type
    ) {
      // mismatch - ignore
      return;
    }

    const proposalId = proposal.id;
    const askPrice = Number(proposal.ask_price || proposal.ask_price_raw || proposal.ask_price_display || proposal.display_value || 0) || Number(proposal.ask_price || 0);

    // send buy request using proposal id and ask price
    if (ws && state.websocket.authenticated) {
      try {
        ws.send(
          JSON.stringify({
            buy: proposalId,
            price: askPrice
          })
        );

        log(`Sent BUY request for proposal ${proposalId} (price=${askPrice})`);

        // store the last proposal id on pending object for matching the buy response
        pendingProposalRequest.proposal_id = proposalId;
        pendingProposalRequest.ask_price = askPrice;

      } catch (err) {
        log("Error sending buy request: " + err.message);
        pendingProposalRequest = null;
      }
    }

    return;
  }

  // ----------------------------------------------------------
  // BUY response
  // ----------------------------------------------------------
  if (message.msg_type === "buy") {
    const buy = message.buy;

    if (!buy) return;

    const contractId = buy.contract_id || buy.contract_id || null;

    if (!contractId) return;

    // If we don't have a pending request or proposal, still record but ensure single active trade rule
    if (activeContractId) {
      log("Received buy for contract while another active contract exists. Ignoring.");
      return;
    }

    // Create a new position entry and mark activeContractId
    const position = {
      contractId,
      contract_type: pendingProposalRequest?.contract_type || (buy.contract_type || null),
      stake: pendingProposalRequest?.stake || Number(buy.buy_price || buy.purchase) || state.engine.demoStake,
      buy_price: pendingProposalRequest?.ask_price || Number(buy.buy_price || buy.purchase) || null,
      payout: null,
      profit: null,
      result: null,
      opened: new Date().toISOString(),
      closed: null,
      is_sold: false,
      raw: message
    };

    state.positions.push(position);

    activeContractId = contractId;

    // subscribe to proposal_open_contract updates for this contract
    if (ws && state.websocket.authenticated) {
      try {
        ws.send(
          JSON.stringify({
            proposal_open_contract: 1,
            subscribe: 1,
            contract_id: contractId
          })
        );

        log(`Subscribed to proposal_open_contract for ${contractId}`);
      } catch (err) {
        log("Error subscribing to proposal_open_contract: " + err.message);
      }
    }

    // clear pending proposal
    pendingProposalRequest = null;

    return;
  }

  // ----------------------------------------------------------
  // PROPOSAL OPEN CONTRACT updates (monitor contract)
  // ----------------------------------------------------------
  if (message.msg_type === "proposal_open_contract") {
    const open = message.proposal_open_contract;

    if (!open) return;

    const cid = open.contract_id || open.contract_id;

    if (!cid) return;

    // find the position
    const position = state.positions.find(p => p.contractId === cid);

    if (!position) return;

    // update position with incoming fields
    position.payout = Number(open.payout || position.payout || 0);
    position.profit = Number(open.profit || position.profit || 0);
    position.is_sold = Boolean(open.is_sold || position.is_sold);

    if (open.transaction_ids) {
      position.transaction_ids = open.transaction_ids;
    }

    if (position.is_sold) {
      position.closed = new Date().toISOString();

      // determine result
      if (Number(position.profit) > 0) {
        position.result = "WIN";
      } else if (Number(position.profit) < 0) {
        position.result = "LOSS";
      } else {
        position.result = "BREAKEVEN";
      }

      log(`Contract ${cid} closed. Result=${position.result} Profit=${position.profit}`);

      // clear activeContractId so new trades can be placed
      if (activeContractId === cid) {
        activeContractId = null;
      }
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

// ============================================================
// MOMENTUM
// ============================================================
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
// TRADE EXECUTION
// ============================================================

async function executeTrade(data) {
  log(`TRADE EXECUTION REQUESTED: ${data.signal}`);

  // Safety checks
  if (!ws || !state.websocket.authenticated) {
    log("TRADE_BLOCKED: WebSocket not authenticated.");
    return;
  }

  // Allow trades only for demo accounts
  if (state.oauth.accountType !== "demo") {
    log("REAL_ACCOUNT_BLOCKED");
    return;
  }

  // Only one active trade at a time
  if (activeContractId) {
    log("TRADE_BLOCKED: Active contract in progress.");
    return;
  }

  // Build proposal request
  const contractType = data.signal === "BUY" ? "CALL" : "PUT";
  const stake = Math.max(0.35, Number(state.engine.demoStake) || 1);

  // prepare pending request so proposal responses can be matched
  pendingProposalRequest = {
    requested_at: Date.now(),
    contract_type: contractType,
    stake,
    signal: data.signal
  };

  const proposalRequest = {
    proposal: 1,
    proposal_request: {
      amount: stake,
      basis: "stake",
      contract_type: contractType,
      currency: "USD",
      symbol: state.engine.symbol,
      duration: 1,
      duration_unit: "m"
    }
  };

  try {
    ws.send(JSON.stringify(proposalRequest));

    log(`Sent proposal request: ${contractType} stake=${stake}`);
  } catch (err) {
    log("Error sending proposal request: " + err.message);
    pendingProposalRequest = null;
  }
}

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {

      // ======================================================
      // CORS PREFLIGHT
      // ======================================================
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

      // ======================================================
      // ROOT — SERVE index.html
      // ======================================================
      if (
        req.method === "GET" &&
        url === "/"
      ) {
        if (indexHtmlCache) {
          sendHTML(res, 200, indexHtmlCache);
          return;
        }

        if (indexHtmlError) {
          sendJSON(res, 500, {
            ok: false,
            error: indexHtmlError
          });
          return;
        }

        // Fallback: try to load it now
        try {
          const indexPath = path.join(__dirname, "index.html");
          const html = fs.readFileSync(indexPath, "utf-8");
          sendHTML(res, 200, html);
          return;
        } catch (err) {
          sendJSON(res, 500, {
            ok: false,
            error: `Failed to read index.html: ${err.message}`
          });
          return;
        }
      }

      // ======================================================
      // HEALTH
      // ======================================================
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

      // ======================================================
      // OAUTH LOGIN
      // ======================================================
      if (
        req.method === "GET" &&
        url === "/oauth/login"
      ) {
        try {
          const oauthData =
            buildOAuthAuthorizationURL();

          log(
            `OAuth flow initiated with state=${oauthData.state.substring(0, 8)}...`
          );

          res.writeHead(302, {
            Location: oauthData.url
          });

          res.end();

        } catch (error) {
          log(`OAuth login error: ${error.message}`);

          sendHTML(res, 500, `
            <!DOCTYPE html>
            <html>
            <head>
              <title>OAuth Error</title>
              <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .error-box { background: #ffe6e6; border: 1px solid #cc0000; padding: 15px; border-radius: 5px; }
                h1 { color: #cc0000; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>OAuth Error</h1>
                <p>${error.message}</p>
                <p><a href="https://goldwebtrader-v2-api.onrender.com/">Return to GoldWebTrader</a></p>
              </div>
            </body>
            </html>
          `);
        }

        return;
      }

      // ======================================================
      // OAUTH CALLBACK
      // ======================================================
      if (
        req.method === "GET" &&
        url === "/oauth/callback"
      ) {
        const params =
          queryParams(req.url);

        const code =
          params.code;

        const returnedState =
          params.state;

        const oauthError =
          params.error;

        const oauthErrorDesc =
          params.error_description;

        // Handle Deriv OAuth error
        if (oauthError) {
          log(
            `OAuth error from Deriv: ${oauthError} - ${oauthErrorDesc || "no description"}`
          );

          sendHTML(res, 400, `
            <!DOCTYPE html>
            <html>
            <head>
              <title>OAuth Error</title>
              <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .error-box { background: #ffe6e6; border: 1px solid #cc0000; padding: 15px; border-radius: 5px; }
                h1 { color: #cc0000; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>OAuth Error</h1>
                <p><strong>${oauthError}</strong></p>
                <p>${oauthErrorDesc || "An error occurred during authentication."}</p>
                <p><a href="https://goldwebtrader-v2-api.onrender.com/">Return to GoldWebTrader</a></p>
              </div>
            </body>
            </html>
          `);

          return;
        }

        // Check for authorization code
        if (!code) {
          log("OAuth callback: Authorization code missing.");

          sendHTML(res, 400, `
            <!DOCTYPE html>
            <html>
            <head>
              <title>OAuth Error</title>
              <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .error-box { background: #ffe6e6; border: 1px solid #cc0000; padding: 15px; border-radius: 5px; }
                h1 { color: #cc0000; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>OAuth Error</h1>
                <p>Authorization code missing from callback.</p>
                <p><a href="https://goldwebtrader-v2-api.onrender.com/">Return to GoldWebTrader</a></p>
              </div>
            </body>
            </html>
          `);

          return;
        }

        // Validate state
        if (!returnedState) {
          log("OAuth callback: State parameter missing.");

          sendHTML(res, 400, `
            <!DOCTYPE html>
            <html>
            <head>
              <title>OAuth Error</title>
              <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .error-box { background: #ffe6e6; border: 1px solid #cc0000; padding: 15px; border-radius: 5px; }
                h1 { color: #cc0000; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>OAuth Error</h1>
                <p>State parameter missing. Invalid request.</p>
                <p><a href="https://goldwebtrader-v2-api.onrender.com/">Return to GoldWebTrader</a></p>
              </div>
            </body>
            </html>
          `);

          return;
        }

        const sessionData = oauthSessions.get(returnedState);

        if (!sessionData) {
          log("OAuth callback: Invalid or unknown state.");

          sendHTML(res, 400, `
            <!DOCTYPE html>
            <html>
            <head>
              <title>OAuth Error</title>
              <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .error-box { background: #ffe6e6; border: 1px solid #cc0000; padding: 15px; border-radius: 5px; }
                h1 { color: #cc0000; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>OAuth Error</h1>
                <p>Invalid or unrecognized state. Request rejected.</p>
                <p><a href="https://goldwebtrader-v2-api.onrender.com/">Return to GoldWebTrader</a></p>
              </div>
            </body>
            </html>
          `);

          return;
        }

        // Check if state has expired
        if (isOAuthStateExpired(sessionData)) {
          oauthSessions.delete(returnedState);

          log("OAuth callback: State expired.");

          sendHTML(res, 400, `
            <!DOCTYPE html>
            <html>
            <head>
              <title>OAuth Error</title>
              <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .error-box { background: #ffe6e6; border: 1px solid #cc0000; padding: 15px; border-radius: 5px; }
                h1 { color: #cc0000; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>OAuth Error</h1>
                <p>Authorization request expired. Please try again.</p>
                <p><a href="https://goldwebtrader-v2-api.onrender.com/">Return to GoldWebTrader</a></p>
              </div>
            </body>
            </html>
          `);

          return;
        }

        // Delete used state from map
        oauthSessions.delete(returnedState);

        // Exchange code for token (server-side)
        try {
          const codeVerifier = sessionData.codeVerifier;

          log(
            `Exchanging authorization code for access token (state=${returnedState.substring(0, 8)}...)`
          );

          const tokenData =
            await exchangeOAuthCodeForToken(
              code,
              codeVerifier
            );

          // Store token in server memory
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
            "Deriv OAuth 2.0 authentication completed successfully."
          );

          if (
            state.oauth.tokenStored
          ) {
            connectDerivWebSocket();
          }

          // Redirect to dashboard
          res.writeHead(302, {
            Location:
              "https://goldwebtrader-v2-api.onrender.com/"
          });

          res.end();

        } catch (error) {
          log(
            "OAuth callback error: " +
            error.message
          );

          sendHTML(res, 500, `
            <!DOCTYPE html>
            <html>
            <head>
              <title>OAuth Error</title>
              <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .error-box { background: #ffe6e6; border: 1px solid #cc0000; padding: 15px; border-radius: 5px; }
                h1 { color: #cc0000; }
              </style>
            </head>
            <body>
              <div class="error-box">
                <h1>OAuth Error</h1>
                <p>${error.message}</p>
                <p><a href="https://goldwebtrader-v2-api.onrender.com/">Return to GoldWebTrader</a></p>
              </div>
            </body>
            </html>
          `);
        }

        return;
      }

      // ======================================================
      // AUTHENTICATED API ROUTES
      // ======================================================
      if (!authorized(req)) {
        sendJSON(res, 401, {
          ok: false,
          error:
            "Unauthorized. Invalid API key."
        });

        return;
      }

      // ======================================================
      // STATUS
      // ======================================================
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

      // ======================================================
      // V75 ENGINE STATUS
      // ======================================================
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

      // ======================================================
      // MARKET STATUS
      // ======================================================
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

      // ======================================================
      // LOGS
      // ======================================================
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

      // ======================================================
      // ENGINE SETTINGS
      // ======================================================
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

      // ======================================================
      // ENGINE START
      // ======================================================
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

      // ======================================================
      // ENGINE STOP
      // ======================================================
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

      // ======================================================
      // MANUAL CANDLE REFRESH
      // ======================================================
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

      // ======================================================
      // 404
      // ======================================================
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
      "Waiting for Deriv OAuth 2.0 connection..."
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
