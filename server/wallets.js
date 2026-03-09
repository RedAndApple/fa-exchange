const { ethers } = require("ethers");
const { getDb, updateDb } = require("./db");

function createWalletForUser(userId) {
  const existing = getWalletByUserId(userId);
  if (existing) return existing;

  const w = ethers.Wallet.createRandom();
  const wallet = {
    walletId: `w_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
    userId,
    address: w.address,
    privateKey: w.privateKey,
    createdAt: Date.now()
  };

  updateDb((db) => {
    db.wallets.push(wallet);
    return db;
  });
  return wallet;
}

function getWalletByUserId(userId) {
  const db = getDb();
  return db.wallets.find((w) => w.userId === userId) || null;
}

function registerWalletRoutes(app, { requireAuth }) {
  app.get("/api/wallet/me", requireAuth, (req, res) => {
    const wallet = getWalletByUserId(req.user.id);
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });
    return res.json({
      walletId: wallet.walletId,
      address: wallet.address,
      createdAt: wallet.createdAt
    });
  });
}

module.exports = {
  createWalletForUser,
  getWalletByUserId,
  registerWalletRoutes
};
