const { getDb, updateDb } = require("./db");

const INTERVAL_MS = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000
};

function toNum(v) {
  return Math.round((Number(v || 0) + Number.EPSILON) * 1e8) / 1e8;
}

function updateSummaryFromOpenOrders() {
  updateDb((db) => {
    const open = db.orders.filter((o) => o.status === "open" || o.status === "partially_filled");
    const bids = open.filter((o) => o.side === "buy").sort((a, b) => b.price - a.price || a.createdAt - b.createdAt);
    const asks = open.filter((o) => o.side === "sell").sort((a, b) => a.price - b.price || a.createdAt - b.createdAt);
    db.marketState.bestBid = bids.length ? bids[0].price : null;
    db.marketState.bestAsk = asks.length ? asks[0].price : null;
    return db;
  });
}

function addTrade(trade) {
  updateDb((db) => {
    db.trades.unshift(trade);
    if (db.trades.length > 1000) db.trades.length = 1000;
    db.marketState.lastPrice = trade.price;
    return db;
  });
  updateCandles(trade);
}

function updateCandles(trade) {
  updateDb((db) => {
    for (const [interval, size] of Object.entries(INTERVAL_MS)) {
      const bucketTs = Math.floor(trade.ts / size) * size;
      const arr = db.candles[interval] || [];
      let candle = arr[arr.length - 1];
      if (!candle || candle.ts !== bucketTs) {
        candle = {
          ts: bucketTs,
          open: trade.price,
          high: trade.price,
          low: trade.price,
          close: trade.price,
          volume: trade.quantity
        };
        arr.push(candle);
      } else {
        candle.high = Math.max(candle.high, trade.price);
        candle.low = Math.min(candle.low, trade.price);
        candle.close = trade.price;
        candle.volume = toNum(candle.volume + trade.quantity);
      }
      if (arr.length > 2000) arr.splice(0, arr.length - 2000);
      db.candles[interval] = arr;
    }
    return db;
  });
}

function getOrderBook(depth = 20) {
  const db = getDb();
  const open = db.orders.filter((o) => o.status === "open" || o.status === "partially_filled");
  const bidMap = new Map();
  const askMap = new Map();

  for (const o of open) {
    const key = Number(o.price);
    const map = o.side === "buy" ? bidMap : askMap;
    const prev = map.get(key) || 0;
    map.set(key, toNum(prev + Number(o.remaining)));
  }

  const bids = [...bidMap.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, depth)
    .map(([price, quantity]) => ({ price, quantity }));
  const asks = [...askMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, depth)
    .map(([price, quantity]) => ({ price, quantity }));

  return { bids, asks };
}

function registerMarketRoutes(app) {
  app.get("/api/market/summary", (req, res) => {
    const db = getDb();
    const { bestBid, bestAsk, lastPrice } = db.marketState;
    const spread =
      bestBid != null && bestAsk != null ? toNum(Number(bestAsk) - Number(bestBid)) : null;
    return res.json({
      symbol: "FAUSDT",
      lastPrice: toNum(lastPrice),
      bestBid,
      bestAsk,
      spread
    });
  });

  app.get("/api/market/orderbook", (req, res) => {
    const depth = Number(req.query.depth || 20);
    return res.json(getOrderBook(depth));
  });

  app.get("/api/market/trades", (req, res) => {
    const db = getDb();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    return res.json(db.trades.slice(0, limit));
  });

  app.get("/api/market/candles", (req, res) => {
    const interval = String(req.query.interval || "1m");
    if (!INTERVAL_MS[interval]) {
      return res.status(400).json({ error: "Unsupported interval" });
    }
    const db = getDb();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const arr = db.candles[interval] || [];
    return res.json(arr.slice(-limit));
  });
}

module.exports = {
  addTrade,
  updateSummaryFromOpenOrders,
  getOrderBook,
  registerMarketRoutes
};
