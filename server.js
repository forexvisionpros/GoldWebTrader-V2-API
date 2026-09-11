const http = require("http");

// =====================================================
// CONFIG
// =====================================================

const PORT = process.env.PORT || 8080;

const DERIV_PUBLIC_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";

// Start with a commonly available Deriv volatility symbol.
// We will verify/change it after the connection works.
const SYMBOL = "1HZ100V";

// =====================================================
// STATE
// =====================================================

let state = {
  broker: "Deriv",

  mode: "DEMO",

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
  }
};

// =====================================================
// WEBSOCKET
// =====================================================

let ws = null;
let reconnectTimer = null;

function connectMarketWebSocket() {

  console.log("Connecting to Deriv public WebSocket...");

  state.market.connected = false;
  state.market.error = null;

  try {

    ws = new WebSocket(DERIV_PUBLIC_WS);

    ws.onopen = () => {

      console.log(
        "================================="
      );

      console.log(
        "DERIV WEBSOCKET CONNECTED"
      );

      console.log(
        "Symbol: " + SYMBOL
      );

      console.log(
        "================================="
      );

      state.market.connected = true;
      state.market.error = null;

      // Subscribe to live ticks
      ws.send(
        JSON.stringify({
          ticks: SYMBOL,
          subscribe: 1,
          req_id: 1
        })
      );

      console.log(
        "Subscribed to " + SYMBOL
      );
    };

    ws.onmessage = event => {

      try {

        const data =
          JSON.parse(event.data);

        // Handle errors from Deriv
        if (data.error) {

          console.error(
            "Deriv WebSocket error:",
            data.error.message
          );

          state.market.error =
            data.error.message;

          return;
        }

        // Handle live tick
        if (data.msg_type === "tick") {

          if (
            data.tick &&
            data.tick.quote !== undefined
          ) {

            state.market.price =
              Number(data.tick.quote);

            state.market.epoch =
              data.tick.epoch || null;

            state.market.lastUpdate =
              new Date().toISOString();

            state.market.symbol =
              data.tick.symbol || SYMBOL;

            console.log(
              "TICK",
              state.market.symbol,
              state.market.price
            );
          }
        }

      } catch (error) {

        console.error(
          "Invalid WebSocket message:",
          error.message
        );
      }
    };

    ws.onerror = error => {

      console.error(
        "Deriv WebSocket error"
      );

      state.market.error =
        "WebSocket connection error";
    };

    ws.onclose = () => {

      console.log(
        "Deriv WebSocket disconnected."
      );

      state.market.connected = false;

      scheduleReconnect();
    };

  } catch (error) {

    console.error(
      "WebSocket startup error:",
      error.message
    );

    state.market.connected = false;

    state.market.error =
      error.message;

    scheduleReconnect();
  }
}

// =====================================================
// AUTOMATIC RECONNECT
// =====================================================

function scheduleReconnect() {

  if (reconnectTimer) {
    return;
  }

  console.log(
    "Reconnecting to Deriv in 5 seconds..."
  );

  reconnectTimer = setTimeout(() => {

    reconnectTimer = null;

    connectMarketWebSocket();

  }, 5000);
}

// =====================================================
// HTTP HELPERS
// =====================================================

function send(res, statusCode, data) {

  res.writeHead(statusCode, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS"
  });

  res.end(
    JSON.stringify(data)
  );
}

// =====================================================
// HTTP SERVER
// =====================================================

const server =
  http.createServer(
    async (req, res) => {

      // -------------------------------------------------
      // CORS
      // -------------------------------------------------

      if (req.method === "OPTIONS") {

        res.writeHead(204, {

          "Access-Control-Allow-Origin":
            "*",

          "Access-Control-Allow-Headers":
            "Content-Type",

          "Access-Control-Allow-Methods":
            "GET, POST, OPTIONS"
        });

        return res.end();
      }

      try {

        const url =
          new URL(
            req.url,
            "http://localhost"
          );

        const path =
          url.pathname;

        // ===============================================
        // HOME
        // ===============================================

        if (
          req.method === "GET" &&
          path === "/"
        ) {

          return send(
            res,
            200,
            {
              status:
                "GoldWebTrader V2 Deriv API online",

              broker:
                "Deriv",

              mode:
                "DEMO",

              websocket:
                state.market.connected,

              trading:
                "DISABLED - TEST MODE"
            }
          );
        }

        // ===============================================
        // MARKET STATUS
        // ===============================================

        if (
          req.method === "GET" &&
          path === "/api/market"
        ) {

          return send(
            res,
            200,
            state.market
          );
        }

        // ===============================================
        // COMPLETE STATUS
        // ===============================================

        if (
          req.method === "GET" &&
          path === "/api/status"
        ) {

          return send(
            res,
            200,
            state
          );
        }

        // ===============================================
        // TRADING STATUS
        // ===============================================

        if (
          req.method === "GET" &&
          path === "/api/trading/status"
        ) {

          return send(
            res,
            200,
            {
              enabled: false,
              tradesEnabled: false,
              message:
                "Trading is disabled during market-data testing."
            }
          );
        }

        // ===============================================
        // NOT FOUND
        // ===============================================

        return send(
          res,
          404,
          {
            error:
              "Not found"
          }
        );

      } catch (error) {

        console.error(
          "HTTP ERROR:",
          error
        );

        return send(
          res,
          500,
          {
            error:
              error.message
          }
        );
      }
    }
  );

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
      "GoldWebTrader V2"
    );

    console.log(
      "Deriv Market Data Engine"
    );

    console.log(
      "Server ONLINE"
    );

    console.log(
      "Port: " + PORT
    );

    console.log(
      "Mode: DEMO"
    );

    console.log(
      "Trading: DISABLED"
    );

    console.log(
      "================================="
    );

    connectMarketWebSocket();
  }
);
