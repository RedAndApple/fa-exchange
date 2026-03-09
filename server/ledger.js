const { getDb, updateDb } = require("./db");

const ASSETS = new Set(["FA", "USDT"]);

function toNum(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 1e8) / 1e8;
}

function ensureBalanceState(db, userId) {
  if (!db.balances[userId]) {
    db.balances[userId] = {
      FA_available: 0,
      FA_locked: 0,
      USDT_available: 0,
      USDT_locked: 0
    };
  }
}

function ensureAsset(asset) {
  if (!ASSETS.has(asset)) throw new Error(`Unknown asset: ${asset}`);
}

function fields(asset) {
  return {
    available: `${asset}_available`,
    locked: `${asset}_locked`
  };
}

function getBalance(userId, asset) {
  ensureAsset(asset);
  const db = getDb();
  const b = db.balances[userId] || {};
  const f = fields(asset);
  return {
    available: toNum(b[f.available]),
    locked: toNum(b[f.locked])
  };
}

function credit(userId, asset, amount) {
  ensureAsset(asset);
  const amt = toNum(amount);
  if (amt <= 0) throw new Error("Amount must be positive");
  updateDb((db) => {
    ensureBalanceState(db, userId);
    const f = fields(asset);
    db.balances[userId][f.available] = toNum(db.balances[userId][f.available] + amt);
    return db;
  });
}

function debit(userId, asset, amount) {
  ensureAsset(asset);
  const amt = toNum(amount);
  if (amt <= 0) throw new Error("Amount must be positive");
  updateDb((db) => {
    ensureBalanceState(db, userId);
    const f = fields(asset);
    const current = toNum(db.balances[userId][f.available]);
    if (current + 1e-9 < amt) throw new Error(`Insufficient ${asset} available`);
    db.balances[userId][f.available] = toNum(current - amt);
    return db;
  });
}

function lockFunds(userId, asset, amount) {
  ensureAsset(asset);
  const amt = toNum(amount);
  if (amt <= 0) throw new Error("Amount must be positive");
  updateDb((db) => {
    ensureBalanceState(db, userId);
    const f = fields(asset);
    const available = toNum(db.balances[userId][f.available]);
    if (available + 1e-9 < amt) throw new Error(`Insufficient ${asset} available`);
    db.balances[userId][f.available] = toNum(available - amt);
    db.balances[userId][f.locked] = toNum(db.balances[userId][f.locked] + amt);
    return db;
  });
}

function unlockFunds(userId, asset, amount) {
  ensureAsset(asset);
  const amt = toNum(amount);
  if (amt <= 0) throw new Error("Amount must be positive");
  updateDb((db) => {
    ensureBalanceState(db, userId);
    const f = fields(asset);
    const locked = toNum(db.balances[userId][f.locked]);
    if (locked + 1e-9 < amt) throw new Error(`Insufficient ${asset} locked`);
    db.balances[userId][f.locked] = toNum(locked - amt);
    db.balances[userId][f.available] = toNum(db.balances[userId][f.available] + amt);
    return db;
  });
}

function moveLocked(userId, asset, amount) {
  ensureAsset(asset);
  const amt = toNum(amount);
  if (amt <= 0) throw new Error("Amount must be positive");
  updateDb((db) => {
    ensureBalanceState(db, userId);
    const f = fields(asset);
    const locked = toNum(db.balances[userId][f.locked]);
    if (locked + 1e-9 < amt) throw new Error(`Insufficient ${asset} locked`);
    db.balances[userId][f.locked] = toNum(locked - amt);
    return db;
  });
}

function ensureUserAccount(userId) {
  updateDb((db) => {
    ensureBalanceState(db, userId);
    return db;
  });
}

function registerLedgerRoutes(app, { requireAuth }) {
  app.get("/api/balances/me", requireAuth, (req, res) => {
    const fa = getBalance(req.user.id, "FA");
    const usdt = getBalance(req.user.id, "USDT");
    return res.json({
      userId: req.user.id,
      FA_available: fa.available,
      FA_locked: fa.locked,
      USDT_available: usdt.available,
      USDT_locked: usdt.locked
    });
  });
}

module.exports = {
  toNum,
  getBalance,
  credit,
  debit,
  lockFunds,
  unlockFunds,
  moveLocked,
  ensureUserAccount,
  registerLedgerRoutes
};
