const http = require("http");
const crypto = require("crypto");

// ============================================================
// GOLD WEB TRADER V2 — DERIV AUTHENTICATED DEMO BRIDGE
// ============================================================

// -------------------- CONFIG --------------------

const PORT = process.env.PORT || 8080;

const CLIENT_ID = "34mYGgOOHIhBdXWQDR91Y";

const REDIRECT_URI =
  "https://goldwebtrader-v2-api.onrender.com/oauth/callback";

const DERIV_API = "https://api.derivws.com";

const SYMBOL = "1HZ100V";

// DEMO ONLY
const DEMO_ONLY = true;

// -------------------- STATE --------------------

let oauthState = null;
let codeVerifier = null;

let derivAuth = {
  authenticated: false,
  accessToken: null,
  expiresAt: 0
};

let demoAccount = {
  id: null,
  balance: 0,
  currency: null,
  accountType: "demo"
};

let ws = null;
let reconnectTimer = null;
let connecting = false;

let state = {
  broker: "Deriv",
  mode: "DEMO",

  authenticated: false,

  account: {
    id: null,
    type: "demo",
    balance: 0,
    currency: null
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

  trading: {
    enabled: false,
    tradesEnabled: false
  },

  portfolio: {
    positions: 0,
    lastUpdate: null
  }
};

// ============================================================
// HELPERS
// ============================================================

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
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

  if (typeof error === "string") return error;

  return error.message || JSON.stringify(error);
}

function generateRandomString(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function createCodeChallenge(verifier) {
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
    throw new Error("Deriv OAuth session is not authenticated.");
  }

  const response = await fetch(`${DERIV_API}${path}`, {
    ...options,

    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${derivAuth.accessToken}`,
      "Content-Type": "application/json"
    }
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    throw new Error(
      `Deriv API ${response.status}: ${
        data?.errors?.[0]?.message ||
        data?.message ||
        text ||
        "Request failed"
      }`
    );
  }

  return data;
}

// ============================================================
// GET ACCOUNTS
// ============================================================

async function getDerivAccounts() {
  return await derivFetch("/trading/v1/options/accounts");
}

// ============================================================
// FIND DEMO ACCOUNT
// ============================================================

async function findDemoAccount() {
  const result = await getDerivAccounts();

  const accounts = Array.isArray(result?.data)
    ? result.data
    : [];

  const demo = accounts.find(
    account =>
      String(account.account_type).toLowerCase() === "demo"
  );

  if (!demo) {
    throw new Error("No DEMO account was found.");
  }

  demoAccount.id = demo.account_id;
  demoAccount.accountType = "demo";
  demoAccount.balance = Number(demo.balance || 0);
  demoAccount.currency = demo.currency || "USD";

  state.account.id = demo.account_id;
  state.account.type = "demo";
  state.account.balance = demoAccount.balance;
  state.account.currency = demoAccount.currency;

  return demo;
}

// ============================================================
// REQUEST AUTHENTICATED DEMO WEBSOCKET URL
// ============================================================

async function requestDemoWebSocketUrl() {
  if (!derivAuth.accessToken) {
    throw new Error("No Deriv access token.");
  }

  if (
    derivAuth.expiresAt &&
    Date.now() >= derivAuth.expiresAt - 30000
  ) {
    throw new Error(
      "Deriv OAuth access token has expired. Please log in again."
    );
  }

  if (!demoAccount.id) {
    await findDemoAccount();
  }

  const result = await derivFetch(
    `/trading/v1/options/accounts/${encodeURIComponent(
      demoAccount.id
    )}/otp`,
    {
      method: "POST"
    }
  );

  const url = result?.data?.url;

  if (!url) {
    throw new Error(
      "Deriv did not return an authenticated WebSocket URL."
    );
  }

  return url;
}

// ============================================================
// AUTHENTICATED WEBSOCKET
// ============================================================

async function connectAuthenticatedDemo() {
  if (connecting) return;

  if (!derivAuth.authenticated || !derivAuth.accessToken) {
    return;
  }

  connecting = true;

  try {
    state.websocket.error = null;

    // Close old connection first
    if (ws) {
      try {
        ws.close();
      } catch {}
    }

    ws = null;

    // IMPORTANT:
    // Get a NEW OTP every time.
    const websocketUrl = await requestDemoWebSocketUrl();

    console.log("Connecting to authenticated DEMO WebSocket...");

    ws = new WebSocket(websocketUrl);

    ws.onopen = () => {
      console.log("Authenticated DEMO WebSocket connected.");

      connecting = false;

      state.websocket.connected = true;
      state.websocket.lastConnected =
        new Date().toISOString();

      state.websocket.error = null;

      state.market.connected = true;
      state.market.error = null;

      // ----------------------------
      // BALANCE
      // ----------------------------

      ws.send(
        JSON.stringify({
          balance: 1,
          subscribe: 1,
          req_id: 101
        })
      );

      // ----------------------------
      // PORTFOLIO
      // ----------------------------

      ws.send(
        JSON.stringify({
          portfolio: 1,
          req_id: 102
        })
      );

      // ----------------------------
      // LIVE TICKS
      // ----------------------------

      ws.send(
        JSON.stringify({
          ticks: SYMBOL,
          subscribe: 1,
          req_id: 103
        })
      );
    };

    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data);

        state.websocket.lastMessage =
          new Date().toISOString();

        // ----------------------------
        // TICK
        // ----------------------------

        if (message.msg_type === "tick") {
          const tick = message.tick;

          if (tick) {
            state.market.connected = true;
            state.market.symbol =
              tick.symbol || SYMBOL;

            state.market.price =
              Number(tick.quote || 0);

            state.market.epoch =
              tick.epoch || null;

            state.market.lastUpdate =
              new Date().toISOString();

            state.market.error = null;
          }
        }

        // ----------------------------
        // BALANCE
        // ----------------------------

        if (message.msg_type === "balance") {
          const balanceData = message.balance;

          if (balanceData) {
            const balance =
              Number(balanceData.balance || 0);

            const currency =
              balanceData.currency ||
              demoAccount.currency ||
              "USD";

            demoAccount.balance = balance;
            demoAccount.currency = currency;

            state.account.balance = balance;
            state.account.currency = currency;
          }
        }

        // ----------------------------
        // PORTFOLIO
        // ----------------------------

        if (message.msg_type === "portfolio") {
          const portfolio = message.portfolio;

          let contracts = [];

          if (Array.isArray(portfolio)) {
            contracts = portfolio;
          } else if (
            Array.isArray(portfolio?.contracts)
          ) {
            contracts = portfolio.contracts;
          } else if (
            Array.isArray(portfolio?.positions)
          ) {
            contracts = portfolio.positions;
          }

          state.portfolio.positions =
            contracts.length;

          state.portfolio.lastUpdate =
            new Date().toISOString();
        }

        // ----------------------------
        // API ERROR
        // ----------------------------

        if (message.error) {
          const errorText =
            message.error.message ||
            message.error.code ||
            "Deriv WebSocket error";

          console.error(
            "Deriv WebSocket message error:",
            errorText
          );

          state.websocket.error = errorText;
        }
      } catch (error) {
        console.error(
          "WebSocket message parse error:",
          error
        );
      }
    };

    ws.onerror = error => {
      console.error(
        "Authenticated WebSocket error:",
        error
      );

      state.websocket.error =
        "Authenticated WebSocket error";
    };

    ws.onclose = () => {
      console.log(
        "Authenticated DEMO WebSocket disconnected."
      );

      connecting = false;

      state.websocket.connected = false;
      state.market.connected = false;

      ws = null;

      scheduleReconnect();
    };
  } catch (error) {
    connecting = false;

    const message = errorMessage(error);

    console.error(
      "Authenticated connection failed:",
      message
    );

    state.websocket.connected = false;
    state.market.connected = false;
    state.websocket.error = message;

    scheduleReconnect();
  }
}

// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect() {
  if (reconnectTimer) return;

  if (!derivAuth.authenticated) return;

  // If OAuth token has expired, stop reconnecting.
  if (
    derivAuth.expiresAt &&
    Date.now() >= derivAuth.expiresAt - 30000
  ) {
    state.websocket.error =
      "OAuth session expired. Please log in again.";

    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    connectAuthenticatedDemo();
  }, 5000);
}

// ============================================================
// OAUTH LOGIN
// ============================================================

function startOAuth(req, res) {
  codeVerifier = generateRandomString(64);
  oauthState = generateRandomString(32);

  const codeChallenge =
    createCodeChallenge(codeVerifier);

  const authUrl =
    new URL("https://auth.deriv.com/oauth2/auth");

  authUrl.searchParams.set(
    "response_type",
    "code"
  );

  authUrl.searchParams.set(
    "client_id",
    CLIENT_ID
  );

  authUrl.searchParams.set(
    "redirect_uri",
    REDIRECT_URI
  );

  authUrl.searchParams.set(
    "scope",
    "trade"
  );

  authUrl.searchParams.set(
    "state",
    oauthState
  );

  authUrl.searchParams.set(
    "code_challenge",
    codeChallenge
  );

  authUrl.searchParams.set(
    "code_challenge_method",
    "S256"
  );

  res.writeHead(302, {
    Location: authUrl.toString()
  });

  res.end();
}

// ============================================================
// OAUTH CALLBACK
// ============================================================

async function oauthCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const returnedState =
    url.searchParams.get("state");

  const oauthError =
    url.searchParams.get("error");

  if (oauthError) {
    return htmlResponse(
      res,
      400,
      `
      <html>
      <body style="font-family:Arial;background:#111;color:white;padding:30px">
        <h1>❌ Deriv OAuth Error</h1>
        <p>${oauthError}</p>
      </body>
      </html>
      `
    );
  }

  if (!code) {
    return htmlResponse(
      res,
      400,
      `
      <html>
      <body style="font-family:Arial;background:#111;color:white;padding:30px">
        <h1>❌ No authorization code</h1>
      </body>
      </html>
      `
    );
  }

  if (!returnedState || returnedState !== oauthState) {
    return htmlResponse(
      res,
      400,
      `
      <html>
      <body style="font-family:Arial;background:#111;color:white;padding:30px">
        <h1>❌ OAuth state mismatch</h1>
        <p>Security verification failed.</p>
      </body>
      </html>
      `
    );
  }

  try {
    const tokenResponse = await fetch(
      "https://auth.deriv.com/oauth2/token",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body: new URLSearchParams({
          grant_type:
            "authorization_code",

          client_id:
            CLIENT_ID,

          redirect_uri:
            REDIRECT_URI,

          code,

          code_verifier:
            codeVerifier
        }).toString()
      }
    );

    const tokenText =
      await tokenResponse.text();

    let tokenData;

    try {
      tokenData = JSON.parse(tokenText);
    } catch {
      throw new Error(
        "Invalid token response from Deriv."
      );
    }

    if (!tokenResponse.ok) {
      throw new Error(
        tokenData?.error_description ||
        tokenData?.error ||
        "OAuth token exchange failed."
      );
    }

    const accessToken =
      tokenData.access_token;

    if (!accessToken) {
      throw new Error(
        "No access token returned by Deriv."
      );
    }

    const expiresIn =
      Number(tokenData.expires_in || 3600);

    derivAuth.authenticated = true;
    derivAuth.accessToken = accessToken;
    derivAuth.expiresAt =
      Date.now() + expiresIn * 1000;

    state.authenticated = true;

    // Clear PKCE secrets after use.
    codeVerifier = null;
    oauthState = null;

    // Find DEMO account.
    await findDemoAccount();

    // Automatically connect.
    await connectAuthenticatedDemo();

    return htmlResponse(
      res,
      200,
      `
      <!DOCTYPE html>

      <html>

      <head>

        <meta name="viewport"
          content="width=device-width,initial-scale=1">

        <title>Gold Web Trader V2</title>

        <style>

          body {
            margin:0;
            padding:25px;
            background:#080808;
            color:white;
            font-family:Arial,sans-serif;
          }

          .card {
            max-width:600px;
            margin:auto;
            background:#151515;
            border-radius:18px;
            padding:25px;
            box-shadow:0 0 25px rgba(0,0,0,.5);
          }

          h1 {
            color:#00ff88;
          }

          .ok {
            color:#00ff88;
            font-size:20px;
          }

          .demo {
            color:#ffd700;
            font-weight:bold;
          }

          .row {
            padding:10px 0;
            border-bottom:1px solid #333;
          }

          a {
            color:#00aaff;
          }

        </style>

      </head>

      <body>

        <div class="card">

          <h1>GoldWebTrader V2</h1>

          <div class="ok">
            ✅ Deriv Connected
          </div>

          <p class="demo">
            DEMO MODE ONLY
          </p>

          <div class="row">
            Account Type:
            <strong>DEMO</strong>
          </div>

          <div class="row">
            Account:
            <strong>${demoAccount.id}</strong>
          </div>

          <div class="row">
            Balance:
            <strong>${demoAccount.balance}
            ${demoAccount.currency}</strong>
          </div>

          <div class="row">
            WebSocket:
            <strong>CONNECTING</strong>
          </div>

          <br>

          <p>
            Your OAuth token is stored only in the
            Render server memory.
          </p>

          <p>
            The server is now attempting to establish
            the authenticated DEMO WebSocket.
          </p>

          <p>
            <a href="/api/deriv/ws">
              Check WebSocket Status
            </a>
          </p>

          <p>
            <a href="/api/deriv/account">
              Check Deriv Account
            </a>
          </p>

        </div>

      </body>

      </html>
      `
    );

  } catch (error) {
    console.error(
      "OAuth callback error:",
      error
    );

    derivAuth.authenticated = false;
    derivAuth.accessToken = null;
    derivAuth.expiresAt = 0;

    state.authenticated = false;

    return htmlResponse(
      res,
      500,
      `
      <html>
      <body style="font-family:Arial;background:#111;color:white;padding:30px">

        <h1>❌ Deriv Connection Failed</h1>

        <p>${errorMessage(error)}</p>

        <p>
          <a href="/oauth/login" style="color:#00aaff">
            Try OAuth Login Again
          </a>
        </p>

      </body>
      </html>
      `
    );
  }
}

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(
  async (req, res) => {

    const url =
      new URL(
        req.url,
        `http://${req.headers.host}`
      );

    // ----------------------------
    // HOME
    // ----------------------------

    if (url.pathname === "/") {
      return htmlResponse(
        res,
        200,
        `
        <!DOCTYPE html>

        <html>

        <head>

          <meta name="viewport"
            content="width=device-width,initial-scale=1">

          <title>GoldWebTrader V2</title>

          <style>

            body {
              background:#090909;
              color:white;
              font-family:Arial;
              padding:25px;
            }

            .box {
              max-width:600px;
              margin:auto;
              background:#151515;
              padding:25px;
              border-radius:18px;
            }

            h1 {
              color:#ffd700;
            }

            a {
              display:block;
              margin:12px 0;
              padding:14px;
              background:#222;
              border-radius:10px;
              color:#00ff88;
              text-decoration:none;
            }

          </style>

        </head>

        <body>

          <div class="box">

            <h1>GoldWebTrader V2</h1>

            <p>
              Deriv DEMO automated trading bridge.
            </p>

            <a href="/oauth/login">
              🔐 Connect Deriv
            </a>

            <a href="/api/status">
              📊 Server Status
            </a>

            <a href="/api/deriv/account">
              💰 Deriv Account
            </a>

            <a href="/api/deriv/ws">
              🔌 WebSocket Status
            </a>

            <a href="/api/market">
              📈 Live Market
            </a>

          </div>

        </body>

        </html>
        `
      );
    }

    // ----------------------------
    // OAUTH LOGIN
    // ----------------------------

    if (url.pathname === "/oauth/login") {
      return startOAuth(req, res);
    }

    // ----------------------------
    // OAUTH CALLBACK
    // ----------------------------

    if (url.pathname === "/oauth/callback") {
      return oauthCallback(
        req,
        res,
        url
      );
    }

    // ----------------------------
    // SERVER STATUS
    // ----------------------------

    if (url.pathname === "/api/status") {
      return jsonResponse(
        res,
        200,
        {
          server: "GoldWebTrader-V2",
          broker: "Deriv",
          mode: "DEMO",
          authenticated:
            derivAuth.authenticated,
          websocket:
            state.websocket.connected,
          market:
            state.market.connected,
          tradingEnabled: false,
          timestamp:
            new Date().toISOString()
        }
      );
    }

    // ----------------------------
    // DERIV ACCOUNT
    // ----------------------------

    if (
      url.pathname ===
      "/api/deriv/account"
    ) {

      if (!derivAuth.authenticated) {
        return jsonResponse(
          res,
          401,
          {
            error:
              "Not authenticated with Deriv.",
            login:
              "/oauth/login"
          }
        );
      }

      try {
        const accounts =
          await getDerivAccounts();

        return jsonResponse(
          res,
          200,
          accounts
        );

      } catch (error) {

        return jsonResponse(
          res,
          500,
          {
            error:
              errorMessage(error)
          }
        );
      }
    }

    // ----------------------------
    // AUTHENTICATED WS STATUS
    // ----------------------------

    if (
      url.pathname ===
      "/api/deriv/ws"
    ) {

      return jsonResponse(
        res,
        200,
        {
          authenticated:
            derivAuth.authenticated,

          mode: "DEMO",

          accountType:
            "demo",

          accountId:
            demoAccount.id,

          websocketConnected:
            state.websocket.connected,

          websocketLastConnected:
            state.websocket.lastConnected,

          websocketLastMessage:
            state.websocket.lastMessage,

          websocketError:
            state.websocket.error,

          balance:
            state.account.balance,

          currency:
            state.account.currency,

          positions:
            state.portfolio.positions,

          portfolioLastUpdate:
            state.portfolio.lastUpdate,

          market:
            state.market,

          trading:
            {
              enabled: false,
              tradesEnabled: false
            },

          timestamp:
            new Date().toISOString()
        }
      );
    }

    // ----------------------------
    // MARKET
    // ----------------------------

    if (
      url.pathname ===
      "/api/market"
    ) {

      return jsonResponse(
        res,
        200,
        state.market
      );
    }

    // ----------------------------
    // TRADING STATUS
    // ----------------------------

    if (
      url.pathname ===
      "/api/trading/status"
    ) {

      return jsonResponse(
        res,
        200,
        {
          enabled: false,
          tradesEnabled: false,
          mode: "DEMO"
        }
      );
    }

    // ----------------------------
    // 404
    // ----------------------------

    return jsonResponse(
      res,
      404,
      {
        error: "Not found"
      }
    );
  }
);

// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  () => {
    console.log(
      `GoldWebTrader V2 running on port ${PORT}`
    );

    console.log(
      "MODE: DEMO ONLY"
    );

    console.log(
      `SYMBOL: ${SYMBOL}`
    );

    console.log(
      "Trading is DISABLED."
    );
  }
);
