const http = require("http");

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "CHANGE_THIS_API_KEY";

let state = {
  ea: {
    connected: false,
    symbol: "-",
    balance: 0,
    equity: 0,
    bid: 0,
    ask: 0,
    positions: 0,
    lastSeen: null
  },

  settings: {
    autoTrading: true,
    lotSize: 0.01,
    maxTrades: 1,
    dailyProfitTarget: 0,
    dailyLossLimit: 0
  },

  command: null
};

function send(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });

    return res.end();
  }

  if (req.headers["x-api-key"] !== API_KEY) {
    return send(res, 401, {
      error: "Unauthorized"
    });
  }

  try {

    // Health check
    if (req.method === "GET" && req.url === "/") {
      return send(res, 200, {
        status: "GoldWebTrader V2 API online"
      });
    }

    // Dashboard status
    if (req.method === "GET" && req.url === "/api/status") {
      return send(res, 200, state);
    }

    // MT5 EA heartbeat
    if (req.method === "POST" && req.url === "/api/heartbeat") {

      const body = await readBody(req);

      state.ea = {
        ...state.ea,
        ...body,
        connected: true,
        lastSeen: new Date().toISOString()
      };

      return send(res, 200, {
        ok: true
      });
    }

    // Get EA settings
    if (req.method === "GET" && req.url === "/api/settings") {
      return send(res, 200, state.settings);
    }

    // Update EA settings
    if (req.method === "POST" && req.url === "/api/settings") {

      const body = await readBody(req);

      state.settings = {
        ...state.settings,
        ...body
      };

      return send(res, 200, {
        ok: true,
        settings: state.settings
      });
    }

    // Send command
    if (req.method === "POST" && req.url === "/api/command") {

      const body = await readBody(req);

      const allowed = [
        "CLOSE_ALL",
        "CLOSE_PROFITABLE",
        "CLOSE_LOSING"
      ];

      if (!allowed.includes(body.command)) {
        return send(res, 400, {
          error: "Unsupported command"
        });
      }

      state.command = {
        command: body.command,
        createdAt: new Date().toISOString()
      };

      return send(res, 200, {
        ok: true
      });
    }

    // EA reads command
    if (req.method === "GET" && req.url === "/api/command") {

      const command = state.command || {
        command: "NONE"
      };

      state.command = null;

      return send(res, 200, command);
    }

    return send(res, 404, {
      error: "Not found"
    });

  } catch (error) {

    console.error(error);

    return send(res, 500, {
      error: error.message
    });
  }

});

server.listen(PORT, "0.0.0.0", () => {
  console.log("=================================");
  console.log("GoldWebTrader V2 API is ONLINE");
  console.log("Listening on port " + PORT);
  console.log("=================================");
});
