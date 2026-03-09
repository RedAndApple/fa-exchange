const crypto = require("crypto");
const { getDb, updateDb } = require("./db");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) return false;
  const attempt = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(attempt, "hex"));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt
  };
}

function registerUser({ email, password }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const pass = String(password || "");
  if (!cleanEmail.includes("@")) throw new Error("Invalid email");
  if (pass.length < 6) throw new Error("Password must be at least 6 chars");

  let createdUser = null;
  updateDb((db) => {
    const existing = db.users.find((u) => u.email === cleanEmail);
    if (existing) throw new Error("Email already registered");
    db.marketState.lastUserId = Number(db.marketState.lastUserId || 0) + 1;
    const id = `u${db.marketState.lastUserId}`;
    createdUser = {
      id,
      email: cleanEmail,
      passwordHash: hashPassword(pass),
      createdAt: Date.now()
    };
    db.users.push(createdUser);
    return db;
  });
  return createdUser;
}

function loginUser({ email, password }) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const pass = String(password || "");
  const db = getDb();
  const user = db.users.find((u) => u.email === cleanEmail);
  if (!user || !verifyPassword(pass, user.passwordHash)) {
    throw new Error("Invalid credentials");
  }
  return user;
}

function registerUserRoutes(app, deps) {
  const {
    auth,
    walletService,
    ledgerService
  } = deps;

  app.post("/api/register", (req, res) => {
    try {
      const user = registerUser(req.body || {});
      walletService.createWalletForUser(user.id);
      ledgerService.ensureUserAccount(user.id);
      ledgerService.credit(user.id, "USDT", 10000);
      ledgerService.credit(user.id, "FA", 10);
      const token = auth.createSession(user.id);
      return res.json({ user: sanitizeUser(user), token });
    } catch (error) {
      return res.status(400).json({ error: error.message || "Register failed" });
    }
  });

  app.post("/api/login", (req, res) => {
    try {
      const user = loginUser(req.body || {});
      const token = auth.createSession(user.id);
      return res.json({ user: sanitizeUser(user), token });
    } catch (error) {
      return res.status(400).json({ error: error.message || "Login failed" });
    }
  });

  app.post("/api/logout", (req, res) => {
    const token = auth.readToken(req);
    if (token) auth.destroySession(token);
    return res.json({ ok: true });
  });

  app.get("/api/me", (req, res) => {
    const token = auth.readToken(req);
    const user = auth.getUserFromToken(token);
    if (!user) return res.json({ user: null });
    return res.json({ user: sanitizeUser(user) });
  });
}

module.exports = {
  registerUserRoutes,
  registerUser,
  loginUser
};
