const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// =====================================================
// DERIV OAUTH CONFIGURATION
// =====================================================

const DERIV_CLIENT_ID = "34mYGgOOHIhBdXWQDR91Y";
const REDIRECT_URI =
  "https://goldwebtrader-v2-api.onrender.com/oauth/callback";

const DERIV_AUTH_URL =
  "https://auth.deriv.com/oauth2/auth";

const DERIV_TOKEN_URL =
  "https://auth.deriv.com/oauth2/token";

const DERIV_API_BASE =
  "https://api.derivws.com";

// =====================================================
// SERVER STATE
// =====================================================

let state = {
  deriv: {
    connected: false,
    authenticated: false,
    accountId: null,
    balance: 0,
    currency: null,
    lastConnected: null,
    tokenExpiresAt: null
  },

  trading: {
    enabled: false,
    mode: "DEMO",
    symbol: "VOLATILITY_75",
    lotSize: 0.05,
    maxTrades: 1,
    dailyProfitTarget: 0,
    dailyLossLimit: 0
  }
};

// =====================================================
// OAUTH TEMPORARY STORAGE
// =====================================================

// Used only while the OAuth login is taking place.
// PKCE values are short-lived and are never sent to the browser.
const oauthSessions = new Map();

// =====================================================
// TOKEN STORAGE
// =====================================================

// Access token stays on the Render server.
// NEVER send this value to the frontend.
let derivAuth = {
  accessToken: null,
  expiresAt: 0
};

// =====================================================
// HELPERS
// =====================================================

function send(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...extraHeaders
  });

  res.end(JSON.stringify(data));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8"
  });

  res.end(html);
}

function randomString(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function createCodeChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

// =====================================================
// DERIV TOKEN EXCHANGE
// =====================================================

async function exchangeCodeForToken(code, codeVerifier) {
  const body = new URLSearchParams();

  body.set("grant_type", "authorization_code");
  body.set("client_id", DERIV_CLIENT_ID);
  body.set("code", code);
  body.set("code_verifier", codeVerifier);
  body.set("redirect_uri", REDIRECT_URI);

  const response = await fetch(DERIV_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "Deriv returned an invalid token response: " + text
    );
  }

  if (!response.ok) {
    throw new Error(
      "Deriv token exchange failed: " +
      JSON.stringify(data)
    );
  }

  if (!data.access_token) {
    throw new Error(
      "Deriv did not return an access token."
    );
  }

  return data;
}

// =====================================================
// TEST AUTHENTICATED DERIV CONNECTION
// =====================================================

async function getDerivAccounts() {
  if (!derivAuth.accessToken) {
    throw new Error("Not authenticated with Deriv.");
  }

  const response = await fetch(
    DERIV_API_BASE + "/trading/v1/options/accounts",
    {
      method: "GET",
      headers: {
        "Authorization":
          "Bearer " + derivAuth.accessToken
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "Invalid Deriv account response: " + text
    );
  }

  if (!response.ok) {
    throw new Error(
      "Deriv account request failed: " +
      JSON.stringify(data)
    );
  }

  return data;
}

// =====================================================
// CREATE OAUTH LOGIN URL
// =====================================================

function createOAuthLoginUrl() {
  const codeVerifier = randomString(64);
  const codeChallenge = createCodeChallenge(codeVerifier);
  const oauthState = randomString(32);

  oauthSessions.set(oauthState, {
    codeVerifier,
    createdAt: Date.now()
  });

  const authUrl = new URL(DERIV_AUTH_URL);

  authUrl.searchParams.set(
    "response_type",
    "code"
  );

  authUrl.searchParams.set(
    "client_id",
    DERIV_CLIENT_ID
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

  return authUrl.toString();
}

// =====================================================
// MAIN SERVER
// =====================================================

const server = http.createServer(async (req, res) => {

  // ---------------------------------------------------
  // CORS
  // ---------------------------------------------------

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods":
        "GET, POST, OPTIONS"
    });

    return res.end();
  }

  try {

    const requestUrl = new URL(
      req.url,
      "http://localhost"
    );

    const pathname = requestUrl.pathname;

    // =================================================
    // HOME
    // =================================================

    if (
      req.method === "GET" &&
      pathname === "/"
    ) {
      return send(res, 200, {
        status: "GoldWebTrader V2 Deriv API online",
        broker: "Deriv",
        mode: "DEMO",
        oauth: true
      });
    }

    // =================================================
    // OAUTH LOGIN
    // =================================================

    if (
      req.method === "GET" &&
      pathname === "/oauth/login"
    ) {

      const loginUrl = createOAuthLoginUrl();

      res.writeHead(302, {
        Location: loginUrl
      });

      return res.end();
    }

    // =================================================
    // OAUTH CALLBACK
    // =================================================

    if (
      req.method === "GET" &&
      pathname === "/oauth/callback"
    ) {

      const code =
        requestUrl.searchParams.get("code");

      const returnedState =
        requestUrl.searchParams.get("state");

      const oauthError =
        requestUrl.searchParams.get("error");

      const oauthErrorDescription =
        requestUrl.searchParams.get(
          "error_description"
        );

      if (oauthError) {
        return sendHtml(
          res,
          400,
          `
          <!DOCTYPE html>
          <html>
          <head>
            <meta name="viewport"
                  content="width=device-width,initial-scale=1">
            <title>Deriv Login Failed</title>
          </head>
          <body style="font-family:Arial;padding:30px">
            <h2>❌ Deriv Login Failed</h2>
            <p>${oauthError}</p>
            <p>${oauthErrorDescription || ""}</p>
          </body>
          </html>
          `
        );
      }

      if (!code || !returnedState) {
        return sendHtml(
          res,
          400,
          `
          <h2>❌ Invalid OAuth callback</h2>
          <p>Missing authorization code or state.</p>
          `
        );
      }

      const session =
        oauthSessions.get(returnedState);

      if (!session) {
        return sendHtml(
          res,
          400,
          `
          <h2>❌ OAuth session expired</h2>
          <p>Please start the Deriv login again.</p>
          `
        );
      }

      // State has now been used.
      oauthSessions.delete(returnedState);

      // Verify state/session before token exchange.
      if (
        Date.now() - session.createdAt >
        10 * 60 * 1000
      ) {
        return sendHtml(
          res,
          400,
          `
          <h2>❌ OAuth session expired</h2>
          <p>Please start the login again.</p>
          `
        );
      }

      // Exchange authorization code immediately.
      const token =
        await exchangeCodeForToken(
          code,
          session.codeVerifier
        );

      derivAuth.accessToken =
        token.access_token;

      derivAuth.expiresAt =
        Date.now() +
        ((token.expires_in || 3600) * 1000);

      state.deriv.authenticated = true;
      state.deriv.connected = true;
      state.deriv.lastConnected =
        new Date().toISOString();

      // Try to confirm the authenticated account.
      let accountResult = null;

      try {
        accountResult =
          await getDerivAccounts();
      } catch (accountError) {
        console.error(
          "Account verification error:",
          accountError.message
        );
      }

      return sendHtml(
        res,
        200,
        `
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport"
                content="width=device-width,initial-scale=1">
          <title>Gold Trading App</title>
          <style>
            body {
              margin:0;
              background:#07111f;
              color:#fff;
              font-family:Arial,sans-serif;
              display:flex;
              justify-content:center;
              align-items:center;
              min-height:100vh;
              text-align:center;
            }

            .box {
              width:90%;
              max-width:500px;
              padding:30px;
              border-radius:20px;
              background:#101d31;
              box-shadow:0 10px 40px rgba(0,0,0,.4);
            }

            .ok {
              font-size:60px;
            }

            h1 {
              margin:10px 0;
            }

            p {
              color:#b8c7d9;
              line-height:1.6;
            }

            .demo {
              display:inline-block;
              padding:10px 18px;
              border-radius:30px;
              background:#183b65;
              margin-top:10px;
            }
          </style>
        </head>

        <body>

          <div class="box">

            <div class="ok">✅</div>

            <h1>Deriv Connected</h1>

            <p>
              OAuth authentication completed successfully.
            </p>

            <div class="demo">
              DEMO MODE
            </div>

            <p>
              Your access token is stored securely
              on the Render server.
            </p>

            <p>
              You can now return to the trading dashboard.
            </p>

          </div>

        </body>
        </html>
        `
      );
    }

    // =================================================
    // DERIV STATUS
    // =================================================

    if (
      req.method === "GET" &&
      pathname === "/api/deriv/status"
    ) {

      const authenticated =
        !!derivAuth.accessToken &&
        Date.now() < derivAuth.expiresAt;

      state.deriv.authenticated =
        authenticated;

      return send(res, 200, {
        connected: authenticated,
        broker: "Deriv",
        mode: "DEMO",
        authenticated,
        tokenExpiresAt:
          authenticated
            ? new Date(
                derivAuth.expiresAt
              ).toISOString()
            : null,
        trading: state.trading
      });
    }

    // =================================================
    // DERIV ACCOUNT TEST
    // =================================================

    if (
      req.method === "GET" &&
      pathname === "/api/deriv/account"
    ) {

      if (
        !derivAuth.accessToken ||
        Date.now() >= derivAuth.expiresAt
      ) {
        return send(res, 401, {
          error: "Deriv is not authenticated."
        });
      }

      const accounts =
        await getDerivAccounts();

      return send(res, 200, accounts);
    }

    // =================================================
    // TRADING SETTINGS
    // =================================================

    if (
      req.method === "GET" &&
      pathname === "/api/settings"
    ) {
      return send(
        res,
        200,
        state.trading
      );
    }

    if (
      req.method === "POST" &&
      pathname === "/api/settings"
    ) {

      const body =
        await readBody(req);

      state.trading = {
        ...state.trading,
        ...body
      };

      return send(res, 200, {
        ok: true,
        settings: state.trading
      });
    }

    // =================================================
    // FUTURE DASHBOARD STATUS
    // =================================================

    if (
      req.method === "GET" &&
      pathname === "/api/status"
    ) {

      return send(res, 200, {
        broker: "Deriv",
        mode: "DEMO",
        deriv: state.deriv,
        trading: state.trading
      });
    }

    // =================================================
    // 404
    // =================================================

    return send(res, 404, {
      error: "Not found"
    });

  } catch (error) {

    console.error(
      "SERVER ERROR:",
      error
    );

    return send(res, 500, {
      error: error.message
    });
  }
});

// =====================================================
// CLEAN OLD OAUTH SESSIONS
// =====================================================

setInterval(() => {

  const now = Date.now();

  for (
    const [oauthState, session]
    of oauthSessions.entries()
  ) {

    if (
      now - session.createdAt >
      10 * 60 * 1000
    ) {
      oauthSessions.delete(
        oauthState
      );
    }
  }

}, 60 * 1000);

// =====================================================
// START SERVER
// =====================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================="
    );

    console.log(
      "GoldWebTrader V2 Deriv API ONLINE"
    );

    console.log(
      "Listening on port " + PORT
    );

    console.log(
      "Broker: Deriv"
    );

    console.log(
      "Mode: DEMO"
    );

    console.log(
      "OAuth: ENABLED"
    );

    console.log(
      "================================="
    );
  }
);
