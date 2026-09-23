const http = require("http");

// ============================================================
// GOLDWEBTRADER V2
// CAPITAL.COM DEMO API CONNECTION TEST
// KELVIN NGUGI
// ============================================================

const PORT = process.env.PORT || 8080;

// Your existing GoldWebTrader dashboard API protection
const API_KEY = process.env.API_KEY || "";

// Capital.com credentials from Render Environment Variables
const CAPITAL_API_KEY = process.env.CAPITAL_API_KEY || "";
const CAPITAL_IDENTIFIER = process.env.CAPITAL_IDENTIFIER || "";
const CAPITAL_PASSWORD = process.env.CAPITAL_PASSWORD || "";
const CAPITAL_DEMO = String(process.env.CAPITAL_DEMO || "true").toLowerCase() === "true";

// Capital.com demo API
const CAPITAL_BASE_URL = CAPITAL_DEMO
  ? "https://demo-api-capital.backend-capital.com"
  : "https://api-capital.backend-capital.com";

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data, null, 2));
}

function authorized(req) {
  // If API_KEY is not configured, allow testing.
  if (!API_KEY) return true;

  const supplied =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  return supplied === API_KEY;
}

async function capitalRequest(path, options = {}) {
  const response = await fetch(
    `${CAPITAL_BASE_URL}${path}`,
    {
      ...options,
      headers: {
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    data
  };
}

// ------------------------------------------------------------
// Capital.com authentication
// ------------------------------------------------------------

async function createCapitalSession() {
  if (!CAPITAL_API_KEY) {
    throw new Error("CAPITAL_API_KEY is missing");
  }

  if (!CAPITAL_IDENTIFIER) {
    throw new Error("CAPITAL_IDENTIFIER is missing");
  }

  if (!CAPITAL_PASSWORD) {
    throw new Error("CAPITAL_PASSWORD is missing");
  }

  const result = await capitalRequest("/api/v1/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CAP-API-KEY": CAPITAL_API_KEY
    },
    body: JSON.stringify({
      identifier: CAPITAL_IDENTIFIER,
      password: CAPITAL_PASSWORD
    })
  });

  if (!result.ok) {
    throw new Error(
      `Capital authentication failed (${result.status}): ${JSON.stringify(result.data)}`
    );
  }

  const cst = result.headers.get("CST");
  const securityToken = result.headers.get("X-SECURITY-TOKEN");

  if (!cst || !securityToken) {
    throw new Error(
      "Capital authentication succeeded but session tokens were not returned."
    );
  }

  return {
    cst,
    securityToken,
    account: result.data
  };
}

// ------------------------------------------------------------
// Get Capital.com account information
// ------------------------------------------------------------

async function getCapitalAccounts(session) {
  const result = await capitalRequest("/api/v1/accounts", {
    method: "GET",
    headers: {
      "CST": session.cst,
      "X-SECURITY-TOKEN": session.securityToken
    }
  });

  if (!result.ok) {
    throw new Error(
      `Capital accounts request failed (${result.status}): ${JSON.stringify(result.data)}`
    );
  }

  return result.data;
}

// ------------------------------------------------------------
// Search for Gold / XAU markets
// ------------------------------------------------------------

async function findGoldMarkets(session) {
  const result = await capitalRequest(
    "/api/v1/markets?searchTerm=gold",
    {
      method: "GET",
      headers: {
        "CST": session.cst,
        "X-SECURITY-TOKEN": session.securityToken
      }
    }
  );

  if (!result.ok) {
    throw new Error(
      `Capital market search failed (${result.status}): ${JSON.stringify(result.data)}`
    );
  }

  return result.data;
}

// ------------------------------------------------------------
// HTTP SERVER
// ------------------------------------------------------------

const server = http.createServer(async (req, res) => {

  // ----------------------------------------------------------
  // Root
  // ----------------------------------------------------------

  if (req.method === "GET" && req.url === "/") {
    return sendJson(res, 200, {
      name: "GoldWebTrader V2",
      version: "CAPITAL-DEMO-TEST-V1",
      status: "ONLINE",
      broker: "Capital.com",
      mode: CAPITAL_DEMO ? "DEMO" : "LIVE",
      executeTrades: false,
      message: "Capital.com connection test server"
    });
  }

  // ----------------------------------------------------------
  // Health
  // ----------------------------------------------------------

  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ok: true,
      server: "GoldWebTrader V2",
      broker: "Capital.com",
      mode: CAPITAL_DEMO ? "DEMO" : "LIVE",
      executeTrades: false,
      time: new Date().toISOString()
    });
  }

  // ----------------------------------------------------------
  // Capital connection test
  // ----------------------------------------------------------

  if (req.method === "GET" && req.url === "/capital/test") {

    if (!authorized(req)) {
      return sendJson(res, 401, {
        ok: false,
        error: "Unauthorized. Invalid API key."
      });
    }

    try {

      console.log("Starting Capital.com DEMO connection test...");

      // 1. Authenticate
      const session = await createCapitalSession();

      console.log("Capital.com authentication successful.");

      // 2. Get account information
      const accounts = await getCapitalAccounts(session);

      console.log("Capital.com account information received.");

      // 3. Search for Gold
      const goldMarkets = await findGoldMarkets(session);

      console.log("Capital.com Gold market search successful.");

      // We deliberately do NOT place any trade.
      return sendJson(res, 200, {
        ok: true,

        broker: "Capital.com",

        mode: "DEMO",

        authenticated: true,

        tradingEnabled: false,

        executeTrades: false,

        message:
          "Capital.com DEMO API connection successful. No trade was placed.",

        account: {
          accountType: session.account?.accountType || null,
          currency:
            session.account?.currencyIsoCode ||
            session.account?.currencyCode ||
            null,
          currentAccountId:
            session.account?.currentAccountId || null,
          balance:
            session.account?.accountInfo?.balance ?? null,
          available:
            session.account?.accountInfo?.available ?? null
        },

        accounts: accounts,

        goldMarkets: goldMarkets

      });

    } catch (error) {

      console.error("Capital.com test error:", error.message);

      return sendJson(res, 502, {
        ok: false,
        broker: "Capital.com",
        mode: CAPITAL_DEMO ? "DEMO" : "LIVE",
        authenticated: false,
        tradingEnabled: false,
        executeTrades: false,
        error: error.message
      });
    }
  }

  // ----------------------------------------------------------
  // 404
  // ----------------------------------------------------------

  return sendJson(res, 404, {
    ok: false,
    error: "Endpoint not found"
  });
});

// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------

server.listen(PORT, () => {
  console.log("=================================================");
  console.log("GoldWebTrader V2");
  console.log("Capital.com DEMO API TEST");
  console.log(`Server listening on port ${PORT}`);
  console.log(`Capital DEMO: ${CAPITAL_DEMO}`);
  console.log(`Capital API configured: ${CAPITAL_API_KEY ? "YES" : "NO"}`);
  console.log(`Capital identifier configured: ${CAPITAL_IDENTIFIER ? "YES" : "NO"}`);
  console.log(`Capital password configured: ${CAPITAL_PASSWORD ? "YES" : "NO"}`);
  console.log("Automatic trading: DISABLED");
  console.log("=================================================");
});