    ws.onerror = (error) => {
      console.error("V75 WebSocket error:", error);

      state.websocket.connected = false;
      state.market.connected = false;
      state.websocket.error =
        "WebSocket connection error";

      connecting = false;
    };

    ws.onclose = () => {
      console.log(
        "V75 authenticated WebSocket closed."
      );

      state.websocket.connected = false;
      state.market.connected = false;

      connecting = false;
      ws = null;

      if (
        derivAuth.authenticated &&
        !reconnectTimer
      ) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;

          connectAuthenticatedDemo()
            .catch(error => {
              console.error(
                "Reconnect error:",
                errorMessage(error)
              );

              state.websocket.error =
                errorMessage(error);
            });
        }, 5000);
      }
    };

  } catch (error) {

    connecting = false;

    state.websocket.connected = false;
    state.market.connected = false;

    state.websocket.error =
      errorMessage(error);

    console.error(
      "WebSocket connection error:",
      errorMessage(error)
    );

    if (
      derivAuth.authenticated &&
      !reconnectTimer
    ) {
      reconnectTimer = setTimeout(() => {

        reconnectTimer = null;

        connectAuthenticatedDemo()
          .catch(err => {
            state.websocket.error =
              errorMessage(err);
          });

      }, 5000);
    }
  }
}

// ============================================================
// OAUTH LOGIN
// ============================================================

function oauthLoginUrl() {

  oauthState = randomString(32);
  codeVerifier = randomString(64);

  const challenge =
    codeChallenge(codeVerifier);

  const params =
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "trade",
      state: oauthState,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });

  return (
    "https://auth.deriv.com/oauth2/auth?" +
    params.toString()
  );
}

// ============================================================
// OAUTH TOKEN EXCHANGE
// ============================================================

async function exchangeOAuthCode(code) {

  if (!codeVerifier) {
    throw new Error(
      "Missing PKCE code verifier."
    );
  }

  const body =
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI
    });

  const response =
    await fetch(
      "https://auth.deriv.com/oauth2/token",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    throw new Error(
      data?.error_description ||
      data?.error ||
      text ||
      "OAuth token exchange failed."
    );
  }

  if (!data.access_token) {
    throw new Error(
      "OAuth response did not contain an access token."
    );
  }

  derivAuth.accessToken =
    data.access_token;

  derivAuth.authenticated =
    true;

  const expiresIn =
    Number(data.expires_in || 3600);

  derivAuth.expiresAt =
    Date.now() +
    expiresIn * 1000;

  state.authenticated = true;

  oauthState = null;
  codeVerifier = null;

  await findDemoAccount();

  await connectAuthenticatedDemo();
}

// ============================================================
// DASHBOARD
// ============================================================

function dashboardHtml() {

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">

<title>GoldWebTrader V2</title>

<style>

body {
  margin: 0;
  padding: 20px;
  background: #0b1020;
  color: #ffffff;
  font-family: Arial, sans-serif;
}

.container {
  max-width: 900px;
  margin: auto;
}

h1 {
  margin-bottom: 5px;
}

.subtitle {
  color: #9ca3af;
  margin-bottom: 20px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit,minmax(200px,1fr));
  gap: 12px;
}

.card {
  background: #151c32;
  border-radius: 12px;
  padding: 18px;
  border: 1px solid #26304d;
}

.label {
  color: #9ca3af;
  font-size: 13px;
  margin-bottom: 8px;
}

.value {
  font-size: 22px;
  font-weight: bold;
}

.button {
  display: inline-block;
  margin: 15px 0;
  padding: 12px 18px;
  border-radius: 8px;
  background: #2563eb;
  color: white;
  text-decoration: none;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: #080c18;
  padding: 15px;
  border-radius: 10px;
  overflow-x: auto;
}

</style>
</head>

<body>

<div class="container">

<h1>GoldWebTrader V2</h1>

<div class="subtitle">
Volatility 75 (1s) Server-Side Engine
</div>

<a class="button"
   href="/oauth/login">
   CONNECT DERIV DEMO
</a>

<div class="grid">

<div class="card">
<div class="label">AUTHENTICATION</div>
<div class="value" id="auth">-</div>
</div>

<div class="card">
<div class="label">WEBSOCKET</div>
<div class="value" id="ws">-</div>
</div>

<div class="card">
<div class="label">V75 PRICE</div>
<div class="value" id="price">-</div>
</div>

<div class="card">
<div class="label">BALANCE</div>
<div class="value" id="balance">-</div>
</div>

<div class="card">
<div class="label">ENGINE</div>
<div class="value" id="engine">-</div>
</div>

<div class="card">
<div class="label">SIGNAL</div>
<div class="value" id="signal">-</div>
</div>

<div class="card">
<div class="label">EMA 9</div>
<div class="value" id="emaFast">-</div>
</div>

<div class="card">
<div class="label">EMA 21</div>
<div class="value" id="emaSlow">-</div>
</div>

<div class="card">
<div class="label">RSI</div>
<div class="value" id="rsi">-</div>
</div>

<div class="card">
<div class="label">MOMENTUM</div>
<div class="value" id="momentum">-</div>
</div>

</div>

<h2>Engine Information</h2>

<pre id="data">
Loading...
</pre>

</div>

<script>

async function update() {

  try {

    const response =
      await fetch("/api/engine");

    const data =
      await response.json();

    document.getElementById("auth")
      .textContent =
      data.authenticated
        ? "CONNECTED"
        : "OFFLINE";

    document.getElementById("ws")
      .textContent =
      data.websocketConnected
        ? "CONNECTED"
        : "OFFLINE";

    document.getElementById("price")
      .textContent =
      data.market?.price ?? "-";

    document.getElementById("balance")
      .textContent =
      data.account?.balance ?? "-";

    document.getElementById("engine")
      .textContent =
      data.engine?.status ?? "-";

    document.getElementById("signal")
      .textContent =
      data.engine?.signal ?? "-";

    document.getElementById("emaFast")
      .textContent =
      data.indicators?.emaFast ?? "-";

    document.getElementById("emaSlow")
      .textContent =
      data.indicators?.emaSlow ?? "-";

    document.getElementById("rsi")
      .textContent =
      data.indicators?.rsi ?? "-";

    document.getElementById("momentum")
      .textContent =
      data.indicators?.momentum ?? "-";

    document.getElementById("data")
      .textContent =
      JSON.stringify(data,null,2);

  } catch(error) {

    document.getElementById("data")
      .textContent =
      "Dashboard error: " +
      error.message;
  }
}

update();

setInterval(
  update,
  2000
);

</script>

</body>
</html>`;
}

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        // ------------------------------------------
        // DASHBOARD
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/"
        ) {

          return htmlResponse(
            res,
            200,
            dashboardHtml()
          );
        }

        // ------------------------------------------
        // OAUTH LOGIN
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/oauth/login"
        ) {

          const loginUrl =
            oauthLoginUrl();

          res.writeHead(
            302,
            {
              Location: loginUrl
            }
          );

          return res.end();
        }

        // ------------------------------------------
        // OAUTH CALLBACK
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/oauth/callback"
        ) {

          const code =
            url.searchParams.get("code");

          const returnedState =
            url.searchParams.get("state");

          const oauthError =
            url.searchParams.get("error");

          if (oauthError) {

            return htmlResponse(
              res,
              400,
              `<h2>OAuth Error</h2>
               <p>${oauthError}</p>`
            );
          }

          if (
            !code ||
            !returnedState ||
            returnedState !== oauthState
          ) {

            return htmlResponse(
              res,
              400,
              `<h2>OAuth Error</h2>
               <p>Invalid OAuth state or missing code.</p>`
            );
          }

          await exchangeOAuthCode(code);

          return htmlResponse(
            res,
            200,
            `<h2>✅ Deriv Connected</h2>
             <p>OAuth authentication completed successfully.</p>
             <p><strong>DEMO MODE</strong></p>
             <p>Your access token is stored securely on the Render server.</p>
             <p><a href="/">Open Dashboard</a></p>`
          );
        }

        // ------------------------------------------
        // HEALTH
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/api/health"
        ) {

          return jsonResponse(
            res,
            200,
            {
              ok: true,
              service:
                "GoldWebTrader-V2-API",
              engine:
                "V75 1S V1",
              symbol:
                SYMBOL,
              timestamp:
                new Date().toISOString()
            }
          );
        }

        // ------------------------------------------
        // ENGINE
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/api/engine"
        ) {

          return jsonResponse(
            res,
            200,
            {
              engine: {
                name:
                  "V75 1S V1",

                enabled:
                  ENGINE.enabled,

                executeTrades:
                  ENGINE.executeTrades,

                status:
                  engineState.status,

                reason:
                  engineState.reason,

                signal:
                  engineState.signal,

                lastSignal:
                  engineState.lastSignal,

                lastSignalTime:
                  engineState.lastSignalTime,

                signalsToday:
                  engineState.signalsToday,

                executionEnabled:
                  engineState.executionEnabled
              },

              authenticated:
                derivAuth.authenticated,

              websocketConnected:
                state.websocket.connected,

              symbol:
                SYMBOL,

              candles:
                candles.length,

              currentCandle,

              indicators,

              market:
                state.market,

              account: {
                id:
                  state.account.id,

                type:
                  "demo",

                balance:
                  state.account.balance,

                currency:
                  state.account.currency
              },

              portfolio:
                portfolioState,

              timestamp:
                new Date().toISOString()
            }
          );
        }

        // ------------------------------------------
        // STATUS
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/api/status"
        ) {

          return jsonResponse(
            res,
            200,
            state
          );
        }

        // ------------------------------------------
        // MARKET
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/api/market"
        ) {

          return jsonResponse(
            res,
            200,
            state.market
          );
        }

        // ------------------------------------------
        // DERIV ACCOUNTS
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/api/deriv/account"
        ) {

          if (!derivAuth.authenticated) {

            return jsonResponse(
              res,
              401,
              {
                error:
                  "Not authenticated with Deriv."
              }
            );
          }

          const result =
            await derivFetch(
              "/trading/v1/options/accounts"
            );

          return jsonResponse(
            res,
            200,
            result
          );
        }

        // ------------------------------------------
        // DERIV WEBSOCKET
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/api/deriv/ws"
        ) {

          return jsonResponse(
            res,
            200,
            {
              authenticated:
                derivAuth.authenticated,

              connected:
                state.websocket.connected,

              symbol:
                SYMBOL,

              error:
                state.websocket.error
            }
          );
        }

        // ------------------------------------------
        // DEBUG ROUTES
        // ------------------------------------------

        if (
          req.method === "GET" &&
          url.pathname === "/api/debug/routes"
        ) {

          return jsonResponse(
            res,
            200,
            {
              routes: [
                "/",
                "/oauth/login",
                "/oauth/callback",
                "/api/health",
                "/api/engine",
                "/api/status",
                "/api/market",
                "/api/deriv/account",
                "/api/deriv/ws",
                "/api/debug/routes"
              ]
            }
          );
        }

        // ------------------------------------------
        // 404
        // ------------------------------------------

        return jsonResponse(
          res,
          404,
          {
            error:
              "Route not found"
          }
        );

      } catch (error) {

        console.error(
          "HTTP error:",
          error
        );

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
  );

// ============================================================
// START SERVER
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================================"
    );

    console.log(
      "GoldWebTrader V2 started."
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Symbol: ${SYMBOL}`
    );

    console.log(
      "Mode: DEMO"
    );

    console.log(
      "Execution: OFF"
    );

    console.log(
      "================================================"
    );
  }
);