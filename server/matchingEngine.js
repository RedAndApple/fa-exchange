const { getDb, updateDb } = require("./db");
const ledger = require("./ledger");
const marketData = require("./marketData");

const SYMBOL = "FAUSDT";
const FEE_RATE = 0.001;

function toNum(v) {
  return Math.round((Number(v || 0) + Number.EPSILON) * 1e8) / 1e8;
}

function getOpenOrdersBySide(side) {
  const db = getDb();
  const open = db.orders.filter((o) => o.side === side && (o.status === "open" || o.status === "partially_filled"));
  if (side === "buy") {
    return open.sort((a, b) => b.price - a.price || a.createdAt - b.createdAt);
  }
  return open.sort((a, b) => a.price - b.price || a.createdAt - b.createdAt);
}

function setOrderStatus(order) {
  if (order.remaining <= 1e-8) order.status = "filled";
  else if (order.filled > 0) order.status = "partially_filled";
  else order.status = "open";
}

function lockForOrder(userId, side, type, price, quantity) {
  if (type !== "limit") return;
  if (side === "buy") {
    ledger.lockFunds(userId, "USDT", toNum(price * quantity));
  } else {
    ledger.lockFunds(userId, "FA", quantity);
  }
}

function releaseRemainingLock(order) {
  if (order.type !== "limit") return;
  if (order.side === "buy") {
    const remainQuote = toNum(order.lockedQuoteRemaining || 0);
    if (remainQuote > 0) {
      ledger.unlockFunds(order.userId, "USDT", remainQuote);
      order.lockedQuoteRemaining = 0;
    }
  } else if (order.remaining > 0) {
    ledger.unlockFunds(order.userId, "FA", order.remaining);
  }
}

function executeTrade(incoming, resting, qty, price) {
  const tradeValue = toNum(qty * price);
  const buyer = incoming.side === "buy" ? incoming : resting;
  const seller = incoming.side === "sell" ? incoming : resting;

  if (buyer.type === "limit") {
    ledger.moveLocked(buyer.userId, "USDT", tradeValue);
    buyer.lockedQuoteRemaining = toNum((buyer.lockedQuoteRemaining || 0) - tradeValue);
  } else {
    ledger.debit(buyer.userId, "USDT", tradeValue);
  }

  if (seller.type === "limit") {
    ledger.moveLocked(seller.userId, "FA", qty);
  } else {
    ledger.debit(seller.userId, "FA", qty);
  }

  const buyerReceiveFA = toNum(qty * (1 - FEE_RATE));
  const sellerReceiveUSDT = toNum(tradeValue * (1 - FEE_RATE));

  ledger.credit(buyer.userId, "FA", buyerReceiveFA);
  ledger.credit(seller.userId, "USDT", sellerReceiveUSDT);
}

function persistOrderUpdate(order) {
  updateDb((db) => {
    const idx = db.orders.findIndex((o) => o.id === order.id);
    if (idx >= 0) db.orders[idx] = order;
    return db;
  });
}

function createOrder(userId, payload) {
  const side = String(payload.side || "").toLowerCase();
  const type = String(payload.type || "").toLowerCase();
  const quantity = toNum(payload.quantity);
  const price = toNum(payload.price);
  if (!["buy", "sell"].includes(side)) throw new Error("Invalid side");
  if (!["market", "limit"].includes(type)) throw new Error("Invalid type");
  if (!(quantity > 0)) throw new Error("Quantity must be > 0");
  if (type === "limit" && !(price > 0)) throw new Error("Price must be > 0");

  const createdAt = Date.now();
  let orderId;
  updateDb((db) => {
    db.marketState.lastOrderId = Number(db.marketState.lastOrderId || 0) + 1;
    orderId = `ord_${db.marketState.lastOrderId}`;
    return db;
  });

  const order = {
    id: orderId,
    userId,
    symbol: SYMBOL,
    side,
    type,
    price: type === "market" ? null : price,
    quantity,
    remaining: quantity,
    filled: 0,
    status: "open",
    createdAt,
    lockedQuoteRemaining: side === "buy" && type === "limit" ? toNum(price * quantity) : 0
  };

  lockForOrder(userId, side, type, price, quantity);
  updateDb((db) => {
    db.orders.push(order);
    return db;
  });

  const trades = [];
  while (order.remaining > 1e-8) {
    const opposite = getOpenOrdersBySide(side === "buy" ? "sell" : "buy");
    if (!opposite.length) break;
    const resting = opposite[0];

    if (
      order.type === "limit" &&
      ((side === "buy" && order.price < resting.price) ||
        (side === "sell" && order.price > resting.price))
    ) {
      break;
    }

    let qty = Math.min(order.remaining, resting.remaining);
    const tradePrice = Number(resting.price);

    if (order.type === "market") {
      if (side === "buy") {
        const canSpend = ledger.getBalance(order.userId, "USDT").available;
        qty = Math.min(qty, toNum(canSpend / tradePrice));
      } else {
        const canSell = ledger.getBalance(order.userId, "FA").available;
        qty = Math.min(qty, canSell);
      }
    }

    qty = toNum(qty);
    if (qty <= 1e-8) break;

    executeTrade(order, resting, qty, tradePrice);
    order.remaining = toNum(order.remaining - qty);
    order.filled = toNum(order.filled + qty);
    resting.remaining = toNum(resting.remaining - qty);
    resting.filled = toNum(resting.filled + qty);
    setOrderStatus(resting);
    setOrderStatus(order);
    persistOrderUpdate(resting);
    persistOrderUpdate(order);

    let tradeId;
    updateDb((db) => {
      db.marketState.lastTradeId = Number(db.marketState.lastTradeId || 0) + 1;
      tradeId = `tr_${db.marketState.lastTradeId}`;
      return db;
    });

    const trade = {
      id: tradeId,
      symbol: SYMBOL,
      price: tradePrice,
      quantity: qty,
      side: order.side,
      buyerUserId: order.side === "buy" ? order.userId : resting.userId,
      sellerUserId: order.side === "sell" ? order.userId : resting.userId,
      ts: Date.now()
    };
    trades.push(trade);
    marketData.addTrade(trade);
  }

  setOrderStatus(order);
  if (order.type === "market" && order.remaining > 0) {
    order.remaining = 0;
    order.status = order.filled > 0 ? "filled" : "cancelled";
  }
  if (order.status === "filled") {
    releaseRemainingLock(order);
  }
  persistOrderUpdate(order);
  marketData.updateSummaryFromOpenOrders();

  return {
    order,
    trades
  };
}

function cancelOrder(userId, orderId) {
  const db = getDb();
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) throw new Error("Order not found");
  if (order.userId !== userId) throw new Error("Forbidden");
  if (!["open", "partially_filled"].includes(order.status)) throw new Error("Order is not cancellable");
  releaseRemainingLock(order);
  order.remaining = 0;
  order.status = "cancelled";
  persistOrderUpdate(order);
  marketData.updateSummaryFromOpenOrders();
  return order;
}

function registerOrderRoutes(app, { requireAuth }) {
  app.post("/api/orders", requireAuth, (req, res) => {
    try {
      const { order, trades } = createOrder(req.user.id, req.body || {});
      return res.json({ ok: true, order, trades });
    } catch (error) {
      return res.status(400).json({ error: error.message || "Order rejected" });
    }
  });

  app.get("/api/orders/open", requireAuth, (req, res) => {
    const db = getDb();
    const orders = db.orders.filter(
      (o) => o.userId === req.user.id && (o.status === "open" || o.status === "partially_filled")
    );
    return res.json(orders);
  });

  app.get("/api/orders/history", requireAuth, (req, res) => {
    const db = getDb();
    const orders = db.orders.filter((o) => o.userId === req.user.id).slice(-200).reverse();
    return res.json(orders);
  });

  app.delete("/api/orders/:id", requireAuth, (req, res) => {
    try {
      const order = cancelOrder(req.user.id, req.params.id);
      return res.json({ ok: true, order });
    } catch (error) {
      return res.status(400).json({ error: error.message || "Cancel failed" });
    }
  });
}

module.exports = {
  createOrder,
  cancelOrder,
  registerOrderRoutes
};
