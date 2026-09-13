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

const CLIENT_SECRET = process.env.DERIV_CLIENT_SECRET || "";
const API_KEY = process.env.API_KEY || "CHANGE_THIS_API_KEY";

let indexHtmlCache = null;
let indexHtmlError = null;

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
    tokenStored: false,
    token: null,
    accountId: null
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
    error: null,
    url: null
  },
  candles: [],
  positions: [],
  logs: []
};

let pendingProposalRequest = null;
let activeContractId = null;

const oauthSessions = new Map();
const OAUTH_STATE_EXPIRY_MS = 10 * 60 * 1000;

function generateCodeVerifier() { return crypto.randomBytes(32).toString("base64url"); }
function generateCodeChallenge(verifier) { return crypto.createHash("sha256").update(verifier).digest("base64url"); }
function generateState() { return crypto.randomBytes(32).toString("hex"); }
function isOAuthStateExpired(sessionData) { return (Date.now() - sessionData.created) > OAUTH_STATE_EXPIRY_MS; }

function log(message) {
  const entry = { time: new Date().toISOString(), message };
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs.pop();
  console.log(`[${entry.time}] ${message}`);
}

logReady = true;
loadIndexHtml();

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendHTML(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(html);
}

function authorized(req) {
  const cleanUrl = req.url.split("?")[0];
  if (cleanUrl === "/" || cleanUrl.startsWith("/health") || cleanUrl.startsWith("/oauth")) return true;
  const supplied = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\\s+/i, "");
  return supplied === API_KEY;
}

// Fixed function inside backend to cleanly parse multiple incoming query strings
function queryParams(url) {
  const result = {};
  const index = url.indexOf("?");
  if (index === -1) return result;
  const query = url.substring(index + 1);
  for (const part of query.split("&")) {
    const [key, value] = part.split("=");
    if (key) result[decodeURIComponent(key)] = decodeURIComponent(value || "");
  }
  return result;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function buildOAuthAuthorizationURL() {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  oauthSessions.set(state, { codeVerifier, created: Date.now() });
  const params = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: "trade", state, code_challenge: codeChallenge, code_challenge_method: "S256"
  });
  return { state, codeVerifier, url: `${DERIV_OAUTH_AUTH_ENDPOINT}?${params.toString()}` };
}

async function exchangeOAuthCodeForToken(code, codeVerifier) {
  const params = new URLSearchParams({
    grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: codeVerifier, redirect_uri: REDIRECT_URI
  });
  try {
    const response = await fetch(DERIV_OAUTH_TOKEN_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString()
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`OAuth token response was not JSON: ${text}`); }
    if (!response.ok || data.error) throw new Error(data.error_description || data.error || "OAuth token exchange failed");
    return data;
  } catch (error) {
    throw new Error(`Token exchange error: ${error.message}`);
  }
}

async function requestV75WebSocketOTP() {
  if (!state.oauth.token || !state.oauth.accountId || state.oauth.accountId === "demo") {
    log("Cannot request OTP: A valid numeric VRTC/CR account code is required.");
    return null;
  }
  log(`Requesting V75 WebSocket OTP for Account: ${state.oauth.accountId}...`);
  try {
    const url = `${DERIV_API}/trading/v1/options/accounts/${state.oauth.accountId}/otp`;
    const response = await fetch(url, {
      method: "POST", headers: { "Authorization": `Bearer ${state.oauth.token}`, "Content-Type": "application/json" },
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      log(`V75 WebSocket OTP request failed: HTTP ${response.status} - ${data.error?.message || "Error"}`);
      return null;
    }
    return data.data?.url || null;
  } catch (error) {
    log(`V75 WebSocket OTP request error: ${error.message}`);
    return null;
  }
}

let ws = null;
let reconnectTimer = null;
let connecting = false;

async function connectDerivWebSocket() {
  if (connecting) return;
  if (!state.oauth.tokenStored || !state.oauth.accountId || state.oauth.accountId === "demo") {
    log("Waiting for real authenticated token profile configurations.");
    return;
  }
  connecting = true;
  try {
    const otpUrl = await requestV75WebSocketOTP();
    if (!otpUrl) { connecting = false; scheduleReconnect(); return; }
    const WebSocket = require("ws");
    log("Connecting to V75 authenticated WebSocket channel...");
    state.websocket.url = otpUrl;
    ws = new WebSocket(otpUrl);
    ws.onopen = () => {
      log("V75 authenticated WebSocket connected successfully.");
      state.websocket.connected = true;
      state.websocket.authenticated = true;
      state.market.connected = true;
      state.websocket.error = null;
      connecting = false;
      subscribeToMarket();
      requestCandles();
    };
    ws.onmessage = event => { try { handleDerivMessage(JSON.parse(event.data)); } catch (e) {} };
    ws.onerror = error => { state.websocket.connected = false; state.market.connected = false; connecting = false; };
    ws.onclose = () => { state.websocket.connected = false; state.websocket.authenticated = false; state.market.connected = false; connecting = false; scheduleReconnect(); };
  } catch (error) { connecting = false; scheduleReconnect(); }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectDerivWebSocket(); }, 5000);
}

function subscribeToMarket() {
  if (!ws || !state.websocket.authenticated) return;
  ws.send(JSON.stringify({ ticks: state.engine.symbol, subscribe: 1 }));
  log(`Subscribed to ${state.engine.symbol} ticks.`);
}

function requestCandles() {
  if (!ws || !state.websocket.authenticated) return;
  ws.send(JSON.stringify({
    ticks_history: state.engine.symbol, adjust_start_time: 1, count: 100, end: "latest", granularity: state.engine.timeframeSeconds, style: "candles"
  }));
}

function handleDerivMessage(message) {
  if (message.error) { log("Deriv internal packet error: " + message.error.message); return; }
  if (message.msg_type === "tick") {
    const tick = message.tick; if (!tick) return;
    state.market.connected = true;
    state.market.price = Number(tick.quote);
    state.market.epoch = Number(tick.epoch);
    state.market.lastUpdate = new Date().toISOString();
    return;
  }
  if (message.msg_type === "candles") {
    if (Array.isArray(message.candles)) {
      state.candles = message.candles.map(c => ({ epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) })).filter(c => Number.isFinite(c.close));
      if (state.candles.length >= state.engine.emaSlow + 5) state.engine.status = "READY";
      evaluateEngine();
    }
    return;
  }
  if (message.msg_type === "proposal") {
    const proposal = message.proposal; if (!proposal || !pendingProposalRequest) return;
    if (ws && state.websocket.authenticated) {
      try {
        ws.send(JSON.stringify({ buy: proposal.id, price: Number(proposal.ask_price || 0) }));
        pendingProposalRequest.proposal_id = proposal.id;
      } catch (err) {}
    }
    return;
  }
  if (message.msg_type === "buy") {
    const buy = message.buy; if (!buy || activeContractId) return;
    activeContractId = buy.contract_id || null;
    state.positions.push({ contractId: activeContractId, opened: new Date().toISOString(), profit: null, result: null, is_sold: false });
    if (ws && state.websocket.authenticated && activeContractId) {
      ws.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1, contract_id: activeContractId }));
    }
    pendingProposalRequest = null;
    return;
  }
  if (message.msg_type === "proposal_open_contract") {
    const open = message.proposal_open_contract; if (!open) return;
    const position = state.positions.find(p => p.contractId === open.contract_id);
    if (!position) return;
    position.profit = Number(open.profit || 0);
    position.is_sold = Boolean(open.is_sold);
    if (position.is_sold) {
      position.result = position.profit > 0 ? "WIN" : "LOSS";
      if (activeContractId === open.contract_id) activeContractId = null;
    }
    return;
  }
}

function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = (values[i] - ema) * multiplier + ema;
  return ema;
}

function calculateRSI(values, period) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change; else losses += Math.abs(change);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function evaluateEngine() {
  if (!state.engine.enabled) { state.engine.status = "DISABLED"; return; }
  if (state.candles.length < state.engine.emaSlow + 5) { state.engine.status = "WAITING_FOR_DATA"; return; }
  const closes = state.candles.map(c => c.close);
  const emaFast = calculateEMA(closes, state.engine.emaFast);
  const emaSlow = calculateEMA(closes, state.engine.emaSlow);
  const rsi = calculateRSI(closes, state.engine.rsiLength);
  if (emaFast === null || emaSlow === null || rsi === null) return;
  let signal = "WAIT";
  if (emaFast > emaSlow && rsi >= state.engine.rsiBuyMin) signal = "BUY";
  else if (emaFast < emaSlow && rsi <= state.engine.rsiSellMax) signal = "SELL";
  state.engine.status = signal === "WAIT" ? "WAITING" : "SIGNAL";
  if (signal !== "WAIT") processSignal({ signal, price: closes[closes.length - 1] });
}

function processSignal(data) {
  const now = Date.now();
  if (state.engine.lastSignalTime && now - state.engine.lastSignalTime < state.engine.cooldownSeconds * 1000) return;
  if (state.engine.signalsToday >= state.engine.maxSignals) return;
  state.engine.lastSignal = data.signal;
  state.engine.lastSignalTime = now;
  state.engine.signalsToday++;
  if (state.engine.executeTrades) executeTrade(data);
}

async function executeTrade(data) {
  if (!ws || !state.websocket.authenticated || activeContractId) return;
  const contractType = data.signal === "BUY" ? "CALL" : "PUT";
  const stake = Math.max(0.35, state.engine.demoStake);
  pendingProposalRequest = { contract_type: contractType, stake };
  ws.send(JSON.stringify({
    proposal: 1, proposal_request: { amount: stake, basis: "stake", contract_type: contractType, currency: "USD", symbol: state.engine.symbol, duration: 1, duration_unit: "m" }
  }));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });
    res.end(); return;
  }

  const urlParts = req.url.split("?");
  const url = urlParts[0];
  const params = queryParams(req.url);

  if (params.token && params.account && params.account !== "demo") {
    if (!state.oauth.token || state.oauth.accountId !== params.account) {
      state.oauth.token = params.token;
      state.oauth.accountId = params.account;
      state.oauth.tokenStored = true;
      state.oauth.connected = true;
      state.oauth.accountType = params.account.startsWith("VRTC") ? "demo" : "real";
      if (ws) { try { ws.close(); } catch(e){} }
      setTimeout(() => connectDerivWebSocket(), 50);
    }
  }

  if (req.method === "GET" && url === "/") {
    if (indexHtmlCache) { sendHTML(res, 200, indexHtmlCache); return; }
    try {
      const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");
      sendHTML(res, 200, html); return;
    } catch (err) { sendJSON(res, 500, { ok: false, error: err.message }); return; }
  }

  if (req.method === "GET" && url === "/health") {
    sendJSON(res, 200, { ok: true, server: "online", uptime: process.uptime() }); return;
  }

  if (req.method === "GET" && url === "/oauth/login") {
    try {
      const oauthData = buildOAuthAuthorizationURL();
      res.writeHead(302, { Location: oauthData.url }); res.end();
    } catch (error) { sendHTML(res, 500, `<h1>OAuth Initialization Error</h1>`); }
    return;
  }

  if (req.method === "GET" && url === "/oauth/callback") {
    if (params.error) { sendHTML(res, 400, `<h1>OAuth Error</h1><p>${params.error_description}</p>`); return; }
    const sessionData = oauthSessions.get(params.state);
    if (!params.code || !sessionData || isOAuthStateExpired(sessionData)) { sendHTML(res, 400, `<h1>Session Expired</h1>`); return; }
    oauthSessions.delete(params.state);

    try {
      const tokenData = await exchangeOAuthCodeForToken(params.code, sessionData.codeVerifier);
      
      let primaryAccount = "";
      let primaryToken = "";

      // DYNAMIC PARSER MATCH COMPILER: Scans modern dictionary return strings from Deriv API
      Object.keys(tokenData).forEach(key => {
        if (key.startsWith("acct")) {
          const accountValue = tokenData[key];
          if (accountValue.startsWith("VRTC") && !primaryAccount) {
            primaryAccount = accountValue;
            const indexSuffix = key.replace("acct", "");
            primaryToken = tokenData["token" + indexSuffix] || "";
          }
        }
      });

      if (!primaryAccount) {
        Object.keys(tokenData).forEach(key => {
          if (key.startsWith("acct") && !primaryAccount) {
            primaryAccount = tokenData[key];
            const indexSuffix = key.replace("acct", "");
            primaryToken = tokenData["token" + indexSuffix] || "";
          }
        });
      }

      if (!primaryAccount) {
        primaryAccount = tokenData.account_id || tokenData.loginid || "";
        primaryToken = tokenData.access_token || tokenData.token || "";
      }

      if (!primaryAccount || primaryAccount === "demo") throw new Error("Could not resolve a valid account ID string.");

      state.oauth.token = primaryToken;
      state.oauth.accountId = primaryAccount;
      state.oauth.tokenStored = Boolean(primaryToken);
      state.oauth.connected = Boolean(primaryToken);
      state.oauth.accountType = primaryAccount.startsWith("VRTC") ? "demo" : "real";

      if (state.oauth.tokenStored && state.oauth.accountId) connectDerivWebSocket();

      const dashboardUrl = new URL("https://goldwebtrader-v2-api.onrender.com/");
      dashboardUrl.searchParams.append("oauth_success", "true");
      dashboardUrl.searchParams.append("token", primaryToken);
      dashboardUrl.searchParams.append("account", primaryAccount);
      
      res.writeHead(302, { Location: dashboardUrl.toString() }); res.end();
    } catch (error) {
      sendHTML(res, 500, `<h1>Callback Matrix Error</h1><p>${error.message}</p>`);
    }
    return;
  }

  if (!authorized(req)) { sendJSON(res, 401, { ok: false, error: "Unauthorized" }); return; }

  if (req.method === "GET" && (url === "/status" || url === "/api/status" || url === "/v75/status")) {
    sendJSON(res, 200, {
      ok: true, server: state.server,
      oauth: { connected: state.oauth.connected, accountType: state.oauth.accountType, accountId: state.oauth.accountId },
      websocket: state.websocket, market: state.market, engine: state.engine, candles: state.candles.length, positions: state.positions.length
    });
    return;
  }

  if (req.method === "GET" && url === "/v75/engine/status") {
    sendJSON(res, 200, { ok: true, engine: state.engine, market: state.market, indicators: getIndicatorSnapshot() }); return;
  }

  if (req.method === "GET" && url === "/logs") { sendJSON(res, 200, { ok: true, logs: state.logs }); return; }

  if (req.method === "POST" && url === "/v75/engine/settings") {
    const body = await readBody(req);
    if (typeof body.enabled === "boolean") state.engine.enabled = body.enabled;
    if (typeof body.executeTrades === "boolean") state.engine.executeTrades = body.executeTrades;
    sendJSON(res, 200, { ok: true, engine: state.engine }); return;
  }

  if (req.method === "POST" && url === "/v75/engine/start") {
    state.engine.enabled = true; sendJSON(res, 200, { ok: true, status: state.engine.status }); return;
  }

  if (req.method === "POST" && url === "/v75/engine/stop") {
    state.engine.enabled = false; state.engine.status = "DISABLED"; sendJSON(res, 200, { ok: true, status: state.engine.status }); return;
  }

  sendJSON(res, 404, { ok: false, error: "Not found" });
});

function getIndicatorSnapshot() {
  if (state.candles.length < state.engine.emaSlow) return { ready: false };
  const closes = state.candles.map(c => c.close);
  return {
    ready: true, price: closes[closes.length - 1],
    emaFast: calculateEMA(closes, state.engine.emaFast), emaSlow: calculateEMA(closes, state.engine.emaSlow), rsi: calculateRSI(closes, state.engine.rsiLength)
  };
}

setInterval(() => { if (state.websocket.authenticated) requestCandles(); evaluateEngine(); }, state.engine.timeframeSeconds * 1000);

server.listen(PORT, "0.0.0.0", () => { log(`GoldWebTrader V2 running on port ${PORT}`); });
