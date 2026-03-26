const startMarketMaker = require("./marketMaker");
const createDepositWatcher = require("./depositWatcher");
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const bip39 = require("bip39");
const { WebSocketServer } = require("ws");
const { ethers } = require("ethers");

const app = express();

/* =========================
   FRONTEND (FIX FOR RENDER)
========================= */

const FRONTEND_PATH = path.resolve(__dirname, "../");

app.use(express.static(FRONTEND_PATH));

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_PATH, "index.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

app.set("trust proxy", 1);

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(express.json());

app.use(
  session({
    name: "cex.sid",
    secret: "dev-secret-key",
    resave: false,
    saveUninitialized: false,
    proxy: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

/* =========================
   LOAD ENV
========================= */

require("dotenv").config();

const PORT = Number(process.env.PORT || 3000);
const GAS_TOPUP_ETH = process.env.GAS_TOPUP_ETH || "0.0005";
const MIN_GAS_ETH = process.env.MIN_GAS_ETH || "0.0002";

/* =========================
   ETHERS
========================= */

const provider = new ethers.JsonRpcProvider(
  process.env.RPC_URL,
  undefined,
  {
    staticNetwork: false
  }
);
const withdrawProvider = new ethers.JsonRpcProvider(process.env.RPC_URL);
let privateKey = process.env.PRIVATE_KEY;
if (!privateKey.startsWith("0x")) {
  privateKey = "0x" + privateKey;
}

const hotWalletBase = new ethers.Wallet(privateKey, withdrawProvider);
const hotWallet = new ethers.NonceManager(hotWalletBase);

/* =========================
   MASTER HD WALLET
========================= */

const masterSeed = process.env.MASTER_SEED;

if (!masterSeed) {
  throw new Error("Missing MASTER_SEED in env");
}

if (!bip39.validateMnemonic(masterSeed)) {
  throw new Error("MASTER_SEED is not valid mnemonic");
}

const masterNode = ethers.HDNodeWallet.fromPhrase(masterSeed);

/* =========================
   STORAGE
========================= */

const usersByEmail = {};
const usersById = {};
const depositAddressToUserId = {};
const ledger = {};
const creditedTransfers = new Set();
const sweptTransfers = new Set();

let nextUserId = 1;

/* =========================
   MARKET STATE
========================= */

const SYMBOL = "FAUSDT";
let nextOrderId = 1;
let nextTradeId = 1;

const bids = [];
const asks = [];
const trades = [];
const allOrders = [];
const candlesByInterval = {
  "1m": [],
  "5m": [],
  "1h": []
};

/* =========================
   HTTP + WS SERVER
========================= */

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on("connection", (ws) => {
  wsClients.add(ws);

  ws.on("close", () => {
    wsClients.delete(ws);
  });

  ws.on("error", () => {
    wsClients.delete(ws);
  });
});

function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload });

  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

function broadcastCandles() {
  for (const interval of Object.keys(candlesByInterval)) {
    broadcast("candles", {
      interval,
      candles: candlesByInterval[interval]
    });
  }
}

function broadcastMarket() {
  broadcast("summary", getSummary());
  broadcast("orderbook", {
    bids: aggregateBook(bids),
    asks: aggregateBook(asks)
  });
  broadcast("trades", trades.slice(0, 50));
  broadcastCandles();
}

function broadcastUserBalance(userId) {
  const bal = ensureUserLedger(userId);

async function waitForConfirmedTx(txHash, timeoutMs = 120000, pollMs = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const receipt = await withdrawProvider.getTransactionReceipt(txHash);

      if (receipt) {
        return receipt;
      }
    } catch (e) {
      console.error("receipt poll error:", e.message);
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return null;
}

  broadcast("balance_update", {
    userId,
    balances: [
      { asset: "FA", available: bal.FA_available, locked: bal.FA_locked },
      { asset: "USDT", available: bal.USDT_available, locked: bal.USDT_locked }
    ]
  });
}

/* =========================
   HELPERS
========================= */

function round8(value) {
  return Number(Number(value).toFixed(8));
}

function ensureUserLedger(userId) {
  if (!ledger[userId]) {
    ledger[userId] = {
      FA_available: 0,
      FA_locked: 0,
      USDT_available: 10000,
      USDT_locked: 0
    };
  }
  return ledger[userId];
}


async function waitForConfirmedTx(txHash, timeoutMs = 120000, pollMs = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const receipt = await provider.getTransactionReceipt(txHash);

      if (receipt) {
        return receipt;
      }
    } catch (e) {
      console.error("receipt poll error:", e.message);
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return null;
}


function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    depositAddress: user.depositAddress
  };
}

function createUserWallet(index) {
  const node = masterNode.deriveChild(index);

  return {
    address: node.address,
    privateKey: node.privateKey,
    path: `m/44'/60'/0'/0/${index}`
  };
}

function makeUser(email, password) {
  const id = `u${nextUserId}`;
  const walletIndex = nextUserId;
  const node = masterNode.deriveChild(walletIndex);

  const user = {
    id,
    email,
    password,
    walletIndex,
    depositAddress: node.address,
    depositPrivateKey: node.privateKey,
    walletPath: `m/44'/60'/0'/0/${walletIndex}`,
    createdAt: new Date().toISOString()
  };

  usersByEmail[email] = user;
  usersById[id] = user;
  depositAddressToUserId[user.depositAddress.toLowerCase()] = id;

  ensureUserLedger(id);

  nextUserId++;
  return user;
}

function makeSystemUser(id, email, password = "system-password") {
  if (usersById[id]) {
    return usersById[id];
  }

  const walletIndex = nextUserId;
  const node = masterNode.deriveChild(walletIndex);

  const user = {
    id,
    email,
    password,
    walletIndex,
    depositAddress: node.address,
    depositPrivateKey: node.privateKey,
    walletPath: `m/44'/60'/0'/0/${walletIndex}`,
    createdAt: new Date().toISOString(),
    system: true
  };

  usersByEmail[email] = user;
  usersById[id] = user;
  depositAddressToUserId[user.depositAddress.toLowerCase()] = id;

  ensureUserLedger(id);

  nextUserId++;
  return user;
}

function getUserSigner(user) {
  return new ethers.Wallet(user.depositPrivateKey, provider);
}

function sortBooks() {
  bids.sort((a, b) => {
    if (b.price !== a.price) return b.price - a.price;
    return a.createdAt - b.createdAt;
  });

  asks.sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    return a.createdAt - b.createdAt;
  });
}

function aggregateBook(book) {
  const map = new Map();

  for (const order of book) {
    if (order.remaining <= 0) continue;

    const key = String(order.price);
    const prev = map.get(key) || { price: order.price, quantity: 0 };
    prev.quantity += order.remaining;
    map.set(key, prev);
  }

  return Array.from(map.values()).map((x) => ({
    price: round8(x.price),
    quantity: round8(x.quantity)
  }));
}

function getSummary() {
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const lastPrice = trades[0]?.price ?? 1.0;

  return {
    symbol: SYMBOL,
    lastPrice,
    bestBid,
    bestAsk
  };
}

function updateCandles(trade) {
  const configs = {
    "1m": 60 * 1000,
    "5m": 5 * 60 * 1000,
    "1h": 60 * 60 * 1000
  };

  for (const interval of Object.keys(configs)) {
    const bucketMs = configs[interval];
    const ts = Math.floor(trade.time / bucketMs) * bucketMs;
    const candles = candlesByInterval[interval];
    const last = candles[candles.length - 1];

    if (!last || last.ts !== ts) {
      candles.push({
        ts,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.quantity
      });

      if (candles.length > 300) candles.shift();
    } else {
      last.high = Math.max(last.high, trade.price);
      last.low = Math.min(last.low, trade.price);
      last.close = trade.price;
      last.volume = round8(last.volume + trade.quantity);
    }
  }
}

function createTrade(price, quantity, buyUserId, sellUserId) {
  const trade = {
    id: `t${nextTradeId++}`,
    symbol: SYMBOL,
    price: round8(price),
    quantity: round8(quantity),
    buyUserId,
    sellUserId,
    time: Date.now()
  };

  trades.unshift(trade);
  if (trades.length > 200) trades.pop();

  updateCandles(trade);

  broadcast("trade", trade);
  broadcast("trades", trades.slice(0, 50));
  broadcast("summary", getSummary());
  broadcast("orderbook", {
    bids: aggregateBook(bids),
    asks: aggregateBook(asks)
  });
  broadcastCandles();

  return trade;
}

function seedCandles() {
  const prices = [0.95, 0.98, 1.01, 0.99, 1.0, 1.02, 1.01];

  for (let i = 0; i < prices.length; i++) {
    createTrade(prices[i], 10 + i, "seedBuyer", "seedSeller");
  }
}

function lockFundsForOrder(userId, side, type, price, quantity) {
  const bal = ensureUserLedger(userId);

  if (side === "sell") {
    if (bal.FA_available < quantity) {
      throw new Error("Insufficient FA balance.");
    }

    bal.FA_available = round8(bal.FA_available - quantity);
    bal.FA_locked = round8(bal.FA_locked + quantity);
    return;
  }

  if (type === "limit") {
    const cost = round8(price * quantity);

    if (bal.USDT_available < cost) {
      throw new Error("Insufficient USDT balance.");
    }

    bal.USDT_available = round8(bal.USDT_available - cost);
    bal.USDT_locked = round8(bal.USDT_locked + cost);
    return;
  }

  const marketBuffer = getSummary().bestAsk ?? getSummary().lastPrice ?? 1;
  const estimated = round8(marketBuffer * quantity);

  if (bal.USDT_available < estimated) {
    throw new Error("Insufficient USDT balance for market order.");
  }

  bal.USDT_available = round8(bal.USDT_available - estimated);
  bal.USDT_locked = round8(bal.USDT_locked + estimated);
}

function unlockRemaining(order) {
  const bal = ensureUserLedger(order.userId);

  if (order.side === "sell") {
    const qty = round8(order.remaining);
    bal.FA_locked = round8(bal.FA_locked - qty);
    bal.FA_available = round8(bal.FA_available + qty);
    return;
  }

  if (order.type === "limit") {
    const quote = round8(order.remaining * order.price);
    bal.USDT_locked = round8(bal.USDT_locked - quote);
    bal.USDT_available = round8(bal.USDT_available + quote);
    return;
  }

  if (order.reservedQuoteRemaining > 0) {
    bal.USDT_locked = round8(bal.USDT_locked - order.reservedQuoteRemaining);
    bal.USDT_available = round8(bal.USDT_available + order.reservedQuoteRemaining);
    order.reservedQuoteRemaining = 0;
  }
}

function settleTrade(buyOrder, sellOrder, tradePrice, tradeQty) {
  const buyer = ensureUserLedger(buyOrder.userId);
  const seller = ensureUserLedger(sellOrder.userId);
  const cost = round8(tradePrice * tradeQty);

  if (buyOrder.type === "limit") {
    const originallyLocked = round8(buyOrder.price * tradeQty);
    buyer.USDT_locked = round8(buyer.USDT_locked - originallyLocked);

    const refund = round8(originallyLocked - cost);
    if (refund > 0) {
      buyer.USDT_available = round8(buyer.USDT_available + refund);
    }
  } else {
    buyer.USDT_locked = round8(buyer.USDT_locked - cost);
    buyOrder.reservedQuoteRemaining = round8(
      (buyOrder.reservedQuoteRemaining || 0) - cost
    );
  }

  buyer.FA_available = round8(buyer.FA_available + tradeQty);

  seller.FA_locked = round8(seller.FA_locked - tradeQty);
  seller.USDT_available = round8(seller.USDT_available + cost);

  broadcastUserBalance(buyOrder.userId);
  broadcastUserBalance(sellOrder.userId);
}

function matchOrder(order) {
  const opposite = order.side === "buy" ? asks : bids;

  while (order.remaining > 0 && opposite.length > 0) {
    const best = opposite[0];

    const crosses =
      order.type === "market"
        ? true
        : order.side === "buy"
          ? order.price >= best.price
          : order.price <= best.price;

    if (!crosses) break;

    const tradeQty = round8(Math.min(order.remaining, best.remaining));
    const tradePrice = best.price;

    if (tradeQty <= 0) break;

    const buyOrder = order.side === "buy" ? order : best;
    const sellOrder = order.side === "sell" ? order : best;

    settleTrade(buyOrder, sellOrder, tradePrice, tradeQty);
    createTrade(tradePrice, tradeQty, buyOrder.userId, sellOrder.userId);

    order.remaining = round8(order.remaining - tradeQty);
    best.remaining = round8(best.remaining - tradeQty);

    if (best.remaining <= 0) {
      best.status = "filled";
      opposite.shift();
    } else {
      best.status = "partially_filled";
    }
  }

  if (order.remaining <= 0) {
    order.status = "filled";
    return;
  }

  if (order.type === "market") {
    unlockRemaining(order);
    order.status = "cancelled";
    order.remaining = 0;
    broadcastUserBalance(order.userId);
    return;
  }

  order.status = order.remaining < order.quantity ? "partially_filled" : "open";

  if (order.side === "buy") {
    bids.push(order);
  } else {
    asks.push(order);
  }

  sortBooks();
}

function createOrder({ userId, side, type, price, quantity }) {
  const order = {
    id: `o${nextOrderId++}`,
    userId,
    symbol: SYMBOL,
    side,
    type,
    price: price != null ? round8(price) : null,
    quantity: round8(quantity),
    remaining: round8(quantity),
    status: "open",
    createdAt: Date.now(),
    reservedQuoteRemaining:
      side === "buy" && type === "market"
        ? round8((getSummary().bestAsk ?? getSummary().lastPrice ?? 1) * quantity)
        : 0
  };

  lockFundsForOrder(userId, side, type, order.price, order.quantity);
  allOrders.unshift(order);
  matchOrder(order);

  broadcast("orderbook", {
    bids: aggregateBook(bids),
    asks: aggregateBook(asks)
  });
  broadcast("summary", getSummary());
  broadcastUserBalance(userId);

  return order;
}

function cancelOrderById(orderId, userId) {
  const inBids = bids.find((o) => o.id === orderId && o.userId === userId);
  const inAsks = asks.find((o) => o.id === orderId && o.userId === userId);
  const order = inBids || inAsks;

  if (!order) {
    throw new Error("Open order not found.");
  }

  unlockRemaining(order);
  order.status = "cancelled";
  order.remaining = 0;

  const bidIndex = bids.findIndex((o) => o.id === order.id);
  if (bidIndex >= 0) bids.splice(bidIndex, 1);

  const askIndex = asks.findIndex((o) => o.id === order.id);
  if (askIndex >= 0) asks.splice(askIndex, 1);

  broadcast("orderbook", {
    bids: aggregateBook(bids),
    asks: aggregateBook(asks)
  });
  broadcast("summary", getSummary());
  broadcastUserBalance(userId);
}

/* =========================
   AUTH
========================= */

app.post("/api/register", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "email and password required" });
  }

  if (usersByEmail[email]) {
    return res.status(400).json({ error: "user already exists" });
  }

  const user = makeUser(email, password);
  req.session.userId = user.id;

  res.json({
    ok: true,
    user: publicUser(user)
  });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = usersByEmail[email];

  if (!user || user.password !== password) {
    return res.status(401).json({ error: "invalid credentials" });
  }

  req.session.userId = user.id;

  res.json({
    ok: true,
    user: publicUser(user)
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  const sessionUserId = req.session?.userId || null;
  const user = sessionUserId ? usersById[sessionUserId] : null;

  res.json({
    user: user
      ? {
          id: user.id,
          email: user.email,
          depositAddress: user.depositAddress
        }
      : null
  });
});


/* =========================
   CONFIG / WALLET / BALANCES
========================= */

app.get("/api/config", async (_req, res) => {
  const net = await provider.getNetwork();

  res.json({
    chainId: Number(net.chainId)
  });
});

app.get("/api/wallet/me", (req, res) => {
  const sessionUserId = req.session?.userId || null;
  const user = sessionUserId ? usersById[sessionUserId] : null;

  if (!user) {
    return res.json({
      address: null,
      error: "login required"
    });
  }

  return res.json({
    address: user.depositAddress
  });
});

app.get("/api/balances/me", (req, res) => {
  const userId = req.session.userId;
  const user = userId ? usersById[userId] : null;

  if (!user) {
    return res.json({ balances: [] });
  }

  const bal = ensureUserLedger(user.id);

  res.json({
    balances: [
      { asset: "FA", available: bal.FA_available, locked: bal.FA_locked },
      { asset: "USDT", available: bal.USDT_available, locked: bal.USDT_locked }
    ]
  });
});

/* =========================
   MARKET ENDPOINTS
========================= */

app.get("/api/market/summary", (_req, res) => {
  res.json(getSummary());
});

app.get("/api/market/orderbook", (_req, res) => {
  res.json({
    bids: aggregateBook(bids),
    asks: aggregateBook(asks)
  });
});

app.get("/api/market/trades", (_req, res) => {
  res.json({
    trades: trades.slice(0, 50)
  });
});

app.get("/api/market/candles", (req, res) => {
  const interval = req.query.interval || "1m";
  res.json({
    candles: candlesByInterval[interval] || candlesByInterval["1m"]
  });
});

/* =========================
   ORDERS
========================= */

app.get("/api/orders/open", (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.json({ orders: [] });

  const orders = [...bids, ...asks]
    .filter((o) => o.userId === userId && o.status !== "filled" && o.status !== "cancelled")
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json({ orders });
});

app.get("/api/orders/history", (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.json({ orders: [] });

  const orders = allOrders
    .filter((o) => o.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);

  res.json({ orders });
});

app.post("/api/orders", (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId || !usersById[userId]) {
      return res.status(401).json({ error: "login required" });
    }

    const { symbol, side, type, price, quantity } = req.body || {};

    if (symbol !== SYMBOL) {
      return res.status(400).json({ error: "unsupported symbol" });
    }

    if (!["buy", "sell"].includes(side)) {
      return res.status(400).json({ error: "invalid side" });
    }

    if (!["limit", "market"].includes(type)) {
      return res.status(400).json({ error: "invalid type" });
    }

    const qtyNum = Number(quantity);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      return res.status(400).json({ error: "invalid quantity" });
    }

    let priceNum = null;
    if (type === "limit") {
      priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        return res.status(400).json({ error: "invalid price" });
      }
    }

    const order = createOrder({
      userId,
      side,
      type,
      price: priceNum,
      quantity: qtyNum
    });

    return res.json({
      ok: true,
      message: `Order ${order.status}.`,
      order
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || "order failed" });
  }
});

app.delete("/api/orders/:id", (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId || !usersById[userId]) {
      return res.status(401).json({ error: "login required" });
    }

    cancelOrderById(req.params.id, userId);

    return res.json({
      ok: true,
      message: `Order ${req.params.id} cancelled`
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || "cancel failed" });
  }
});

/* =========================
   WITHDRAW
========================= */

app.post("/api/withdraw", async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = userId ? usersById[userId] : null;

    if (!user) {
      return res.status(401).json({ error: "login required" });
    }

    const { to, amountHuman } = req.body || {};

    if (!ethers.isAddress(to)) {
      return res.status(400).json({ error: "invalid address" });
    }

    const amountNum = Number(amountHuman);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: "invalid amount" });
    }

    const bal = ensureUserLedger(user.id);
    if (bal.FA_available < amountNum) {
      return res.status(400).json({ error: "insufficient balance" });
    }

    const hotWalletAddress = await hotWallet.getAddress();
    const hotWalletBalance = await withdrawProvider.getBalance(hotWalletAddress);

    console.log("Hot wallet:", hotWalletAddress);
    console.log("Hot wallet native balance:", ethers.formatEther(hotWalletBalance));

    const value = ethers.parseEther(String(amountHuman));

    if (hotWalletBalance < value) {
      return res.status(400).json({ error: "hot wallet has insufficient native balance" });
    }

    const nonce = await provider.getTransactionCount(hotWalletAddress, "pending");
    console.log("Using pending nonce:", nonce);

    let tx;
    try {
      tx = await hotWallet.sendTransaction({
        to,
        value,
        nonce
      });
    } catch (e) {
      console.error("withdraw sendTransaction failed:", e);

      const msg = String(e?.message || "");
      const rawTx = e?.payload?.params?.[0];

      if (msg.includes("Known transaction") && rawTx) {
        const knownHash = ethers.keccak256(rawTx);
        console.log("Known transaction reused:", knownHash);

        const receipt = await waitForConfirmedTx(knownHash, 60000, 3000);

        if (!receipt) {
          return res.status(500).json({
            error: "transaction known by RPC but not confirmed in time",
            txHash: knownHash
          });
        }

        if (receipt.status !== 1) {
          return res.status(500).json({
            error: "transaction failed on-chain",
            txHash: knownHash
          });
        }

        bal.FA_available = round8(bal.FA_available - amountNum);
        broadcastUserBalance(user.id);

        return res.json({
          ok: true,
          txHash: knownHash
        });
      }

      throw e;
    }

    console.log("Withdraw tx sent:", tx.hash);

    const receipt = await waitForConfirmedTx(tx.hash, 60000, 3000);

    if (!receipt) {
      console.error("Withdraw not confirmed in time:", tx.hash);
      return res.status(500).json({
        error: "withdraw transaction was sent but not confirmed in time",
        txHash: tx.hash
      });
    }

    console.log("Withdraw receipt status:", receipt.status);
    console.log("Withdraw confirmed in block:", receipt.blockNumber);

    if (receipt.status !== 1) {
      return res.status(500).json({
        error: "withdraw transaction failed on-chain",
        txHash: tx.hash
      });
    }

    bal.FA_available = round8(bal.FA_available - amountNum);
    broadcastUserBalance(user.id);

    return res.json({
      ok: true,
      txHash: tx.hash
    });
  } catch (e) {
    console.error("withdraw failed:", e);
    return res.status(500).json({
      error: e.message || "withdraw failed"
    });
  }
});

/* =========================
   NATIVE DEPOSITS
========================= */

async function watchNativeDeposits() {
  console.log("Watching native deposits...");

  provider.on("block", async (blockNumber) => {
    try {
      const block = await provider.getBlock(blockNumber, true);

      for (const tx of block.transactions) {
        if (!tx.to) continue;

        const to = tx.to.toLowerCase();

        if (depositAddressToUserId[to]) {
          if (creditedTransfers.has(tx.hash)) continue;

          const userId = depositAddressToUserId[to];
          const amount = Number(ethers.formatEther(tx.value));

          if (amount <= 0) continue;

          const bal = ensureUserLedger(userId);
          bal.FA_available = round8(bal.FA_available + amount);

          creditedTransfers.add(tx.hash);

          console.log("Deposit:", userId, amount);

          broadcastUserBalance(userId);
        }
      }
    } catch (e) {
      console.log("block scan error:", e.message);
    }
  });
}

/* =========================
   SEED MARKET
========================= */

function seedMarket() {
  seedCandles();

  const mm1 = makeSystemUser("mm1", "mm@exchange.local");
  const mmBuy = makeSystemUser("mm-buy", "mm-buy@local");
  const mmSell = makeSystemUser("mm-sell", "mm-sell@local");

  const mm1Ledger = ensureUserLedger(mm1.id);
  mm1Ledger.FA_available = 100000;
  mm1Ledger.USDT_available = 100000;

  const buyLedger = ensureUserLedger(mmBuy.id);
  buyLedger.USDT_available = 50000;

  const sellLedger = ensureUserLedger(mmSell.id);
  sellLedger.FA_available = 50000;

  try {
    createOrder({
      userId: mmBuy.id,
      side: "buy",
      type: "limit",
      price: 0.99,
      quantity: 200
    });

    createOrder({
      userId: mmBuy.id,
      side: "buy",
      type: "limit",
      price: 0.98,
      quantity: 200
    });

    createOrder({
      userId: mmSell.id,
      side: "sell",
      type: "limit",
      price: 1.01,
      quantity: 200
    });

    createOrder({
      userId: mmSell.id,
      side: "sell",
      type: "limit",
      price: 1.02,
      quantity: 200
    });
  } catch (e) {
    console.error("seed market error:", e.message);
  }

  broadcastMarket();
}

/* =========================
   HEALTH
========================= */

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    symbol: SYMBOL,
    users: Object.keys(usersById).length,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    lastPrice: trades[0]?.price ?? null
  });
});

/* =========================
   DEPOSIT WATCHER INSTANCE
========================= */

const depositWatcher = createDepositWatcher({
  provider,
  hotWallet,
  tokenAddress: null,
  vaultAddress: null,
  usersById,
  depositAddressToUserId,
  ledger,
  creditedTransfers,
  sweptTransfers,
  GAS_TOPUP_ETH,
  MIN_GAS_ETH,
  masterNode
});

/* =========================
   START
========================= */

async function start() {
  console.log("Connecting to RPC:", process.env.RPC_URL);

  let net;
  try {
    net = await provider.getNetwork();
    console.log("Network:", net.chainId);
  } catch (e) {
    console.error("RPC connection failed:", e.message);
    throw e;
  }

  console.log("Hot wallet:", await hotWallet.getAddress());

  seedMarket();

  depositWatcher.start();

  startMarketMaker({
    createOrder,
    getSummary
  });

  server.listen(PORT, () => {
    console.log("Server running http://localhost:" + PORT);
  });
}
start().catch((e) => {
  console.error("Fatal start error:", e);
  process.exit(1);
});