const http = require("http");

// ============================================================
// GOLDWEBTRADER V2
// CAPITAL.COM DEMO & LIVE API INTEGRATION
// KELVIN NGUGI
// ============================================================

const PORT = process.env.PORT || 8080;

// GoldWebTrader dashboard API protection
const API_KEY = process.env.API_KEY || "";

// Capital.com credentials from Render Environment Variables
const CAPITAL_API_KEY = process.env.CAPITAL_API_KEY || "";
const CAPITAL_IDENTIFIER = process.env.CAPITAL_IDENTIFIER || "";
const CAPITAL_PASSWORD = process.env.CAPITAL_PASSWORD || "";
const CAPITAL_DEMO = String(process.env.CAPITAL_DEMO || "true").toLowerCase() === "true";

// Capital.com base API URL
const CAPITAL_BASE_URL = CAPITAL_DEMO
  ? "https://demo-api-capital.backend-capital.com"
  : "https://api-capital.backend-capital.com";

// Active session cache
let currentSession = {
  cst: null,
  securityToken: null,
  account: null,
  createdAt: 0
};

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(data, null, 2));
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!API_KEY) return true;
  const supplied =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
  return supplied === API_KEY;
}

async function capitalRequest(path, options = {}) {
  const response = await fetch(`${CAPITAL_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

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
// Capital.com Authentication & Auto Session Refresh
// ------------------------------------------------------------

async function createCapitalSession() {
  if (!CAPITAL_API_KEY) throw new Error("CAPITAL_API_KEY is missing in environment variables");
  if (!CAPITAL_IDENTIFIER) throw new Error("CAPITAL_IDENTIFIER is missing in environment variables");
  if (!CAPITAL_PASSWORD) throw new Error("CAPITAL_PASSWORD is missing in environment variables");

  const result = await capitalRequest("/api/v1/session", {
    method: "POST",
    headers: {
      "X-CAP-API-KEY": CAPITAL_API_KEY
    },
    body: JSON.stringify({
      identifier: CAPITAL_IDENTIFIER,
      password: CAPITAL_PASSWORD
    })
  });

  if (!result.ok) {
    throw new Error(`Capital authentication failed (${result.status}): ${JSON.stringify(result.data)}`);
  }

  const cst = result.headers.get("CST");
  const securityToken = result.headers.get("X-SECURITY-TOKEN");

  if (!cst || !securityToken) {
    throw new Error("Capital authentication succeeded but CST or X-SECURITY-TOKEN header was missing.");
  }

  return {
    cst,
    securityToken,
    account: result.data
  };
}

async function getValidSession(forceRefresh = false) {
  const SESSION_MAX_AGE_MS = 8 * 60 * 1000; // 8 minutes auto-refresh window
  const isExpired = Date.now() - currentSession.createdAt > SESSION_MAX_AGE_MS;

  if (forceRefresh || !currentSession.cst || !currentSession.securityToken || isExpired) {
    console.log("[AUTH] Requesting new Capital.com session tokens...");
    const sessionData = await createCapitalSession();
    currentSession = {
      ...sessionData,
      createdAt: Date.now()
    };
    console.log("[AUTH] Capital.com session refreshed successfully.");
  }

  return currentSession;
}

// Execute Capital API call with automatic 401 retry handling
async function authenticatedCapitalRequest(path, options = {}) {
  let session = await getValidSession();

  let result = await capitalRequest(path, {
    ...options,
    headers: {
      "CST": session.cst,
      "X-SECURITY-TOKEN": session.securityToken,
      ...(options.headers || {})
    }
  });

  // If session expired prematurely (401), refresh session and retry request once
  if (result.status === 401) {
    console.warn("[AUTH] Received 401 Unauthorized. Retrying with fresh session...");
    session = await getValidSession(true);
    result = await capitalRequest(path, {
      ...options,
      headers: {
        "CST": session.cst,
        "X-SECURITY-TOKEN": session.securityToken,
        ...(options.headers || {})
      }
    });
  }

  return result;
}

// ------------------------------------------------------------
// Core Trading API Functions
// ------------------------------------------------------------

async function getCapitalAccounts() {
  const result = await authenticatedCapitalRequest("/api/v1/accounts", { method: "GET" });
  if (!result.ok) throw new Error(`Accounts fetch failed (${result.status}): ${JSON.stringify(result.data)}`);
  return result.data;
}

async function findGoldMarkets() {
  const result = await authenticatedCapitalRequest("/api/v1/markets?searchTerm=GOLD", { method: "GET" });
  if (!result.ok) throw new Error(`Gold market search failed (${result.status}): ${JSON.stringify(result.data)}`);
  return result.data;
}

async function executeTrade({ epic = "GOLD", direction, size, stopLevel, profitLevel, stopDistance, profitDistance }) {
  if (!direction || !["BUY", "SELL"].includes(direction.toUpperCase())) {
    throw new Error("Invalid direction. Must be 'BUY' or 'SELL'.");
  }
  if (!size || isNaN(size) || Number(size) <= 0) {
    throw new Error("Invalid size. Must be a positive number.");
  }

  const payload = {
    epic: epic,
    direction: direction.toUpperCase(),
    size: Number(size),
    guaranteedStop: false
  };

  if (stopLevel !== undefined) payload.stopLevel = Number(stopLevel);
  if (profitLevel !== undefined) payload.profitLevel = Number(profitLevel);
  if (stopDistance !== undefined) payload.stopDistance = Number(stopDistance);
  if (profitDistance !== undefined) payload.profitDistance = Number(profitDistance);

  const result = await authenticatedCapitalRequest("/api/v1/positions", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!result.ok) {
    throw new Error(`Trade placement failed (${result.status}): ${JSON.stringify(result.data)}`);
  }

  return result.data; // Returns dealReference
}

async function checkDealConfirmation(dealReference) {
  const result = await authenticatedCapitalRequest(`/api/v1/confirms/${dealReference}`, { method: "GET" });
  if (!result.ok) throw new Error(`Deal confirmation lookup failed (${result.status}): ${JSON.stringify(result.data)}`);
  return result.data;
}

async function getOpenPositions() {
  const result = await authenticatedCapitalRequest("/api/v1/positions", { method: "GET" });
  if (!result.ok) throw new Error(`Positions fetch failed (${result.status}): ${JSON.stringify(result.data)}`);
  return result.data;
}

async function closePosition(dealId) {
  const result = await authenticatedCapitalRequest(`/api/v1/positions/${dealId}`, {
    method: "DELETE"
  });
  if (!result.ok) throw new Error(`Close position failed (${result.status}): ${JSON.stringify(result.data)}`);
  return result.data;
}

// ------------------------------------------------------------
// HTTP SERVER & ROUTER
// ------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-KEY, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
    });
    return res.end();
  }

  // 1. Root Endpoint
  if (req.method === "GET" && req.url === "/") {
    return sendJson(res, 200, {
      name: "GoldWebTrader V2",
      version: "2.0.0-PRODUCTION",
      status: "ONLINE",
      broker: "Capital.com",
      mode: CAPITAL_DEMO ? "DEMO" : "LIVE",
      executeTrades: true,
      endpoints: [
        "GET  /health",
        "GET  /capital/test",
        "GET  /capital/accounts",
        "GET  /capital/markets/gold",
        "POST /capital/trade",
        "GET  /capital/positions",
        "DELETE /capital/positions/:dealId"
      ]
    });
  }

  // 2. Health Endpoint
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      ok: true,
      server: "GoldWebTrader V2",
      broker: "Capital.com",
      mode: CAPITAL_DEMO ? "DEMO" : "LIVE",
      executeTrades: true,
      time: new Date().toISOString()
    });
  }

  // Authentication Guard for Protected Endpoints
  if (!authorized(req)) {
    return sendJson(res, 401, {
      ok: false,
      error: "Unauthorized. Invalid or missing X-API-KEY header."
    });
  }

  try {
    // 3. Test Connection
    if (req.method === "GET" && req.url === "/capital/test") {
      const session = await getValidSession();
      const accounts = await getCapitalAccounts();
      const goldMarkets = await findGoldMarkets();

      return sendJson(res, 200, {
        ok: true,
        broker: "Capital.com",
        mode: CAPITAL_DEMO ? "DEMO" : "LIVE",
        authenticated: true,
        tradingEnabled: true,
        message: "Capital.com connection & authorization test successful.",
        account: {
          accountType: session.account?.accountType || null,
          currency: session.account?.currencyIsoCode || session.account?.currencyCode || null,
          currentAccountId: session.account?.currentAccountId || null
        },
        accounts,
        goldMarkets
      });
    }

    // 4. Accounts List
    if (req.method === "GET" && req.url === "/capital/accounts") {
      const accounts = await getCapitalAccounts();
      return sendJson(res, 200, { ok: true, accounts });
    }

    // 5. Gold Markets Query
    if (req.method === "GET" && req.url === "/capital/markets/gold") {
      const goldMarkets = await findGoldMarkets();
      return sendJson(res, 200, { ok: true, goldMarkets });
    }

    // 6. Execute Order (BUY / SELL with SL / TP)
    if (req.method === "POST" && req.url === "/capital/trade") {
      const body = await parseRequestBody(req);
      const tradeResult = await executeTrade(body);
      
      let confirmation = null;
      if (tradeResult.dealReference) {
        // Fetch trade status confirmation
        confirmation = await checkDealConfirmation(tradeResult.dealReference);
      }

      return sendJson(res, 200, {
        ok: true,
        message: "Order submitted to Capital.com",
        dealReference: tradeResult.dealReference,
        confirmation
      });
    }

    // 7. Trade Monitoring (Get Open Positions)
    if (req.method === "GET" && req.url === "/capital/positions") {
      const positions = await getOpenPositions();
      return sendJson(res, 200, { ok: true, positions });
    }

    // 8. Close Open Position
    if (req.method === "DELETE" && req.url.startsWith("/capital/positions/")) {
      const dealId = req.url.split("/").pop();
      if (!dealId) throw new Error("Missing dealId in endpoint URL");
      
      const result = await closePosition(dealId);
      return sendJson(res, 200, { ok: true, message: `Position ${dealId} closed`, result });
    }

    // 404 Route
    return sendJson(res, 404, { ok: false, error: "Endpoint not found" });

  } catch (error) {
    console.error("[SERVER ERROR]:", error.message);
    return sendJson(res, 500, {
      ok: false,
      broker: "Capital.com",
      mode: CAPITAL_DEMO ? "DEMO" : "LIVE",
      error: error.message
    });
  }
});

// ------------------------------------------------------------
// Start Server
// ------------------------------------------------------------

server.listen(PORT, () => {
  console.log("=================================================");
  console.log("GoldWebTrader V2 - Production Server");
  console.log(`Server listening on port ${PORT}`);
  console.log(`Capital Mode: ${CAPITAL_DEMO ? "DEMO" : "LIVE"}`);
  console.log(`Capital API Key configured: ${CAPITAL_API_KEY ? "YES" : "NO"}`);
  console.log(`Capital Identifier configured: ${CAPITAL_IDENTIFIER ? "YES" : "NO"}`);
  console.log(`Capital Password configured: ${CAPITAL_PASSWORD ? "YES" : "NO"}`);
  console.log(`Dashboard API Key Protection: ${API_KEY ? "ENABLED" : "DISABLED"}`);
  console.log("Trading & Monitoring Flow: READY");
  console.log("=================================================");
});
