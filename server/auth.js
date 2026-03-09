const crypto = require("crypto");
const { updateDb, getDb } = require("./db");

function createSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  const session = {
    token,
    userId,
    createdAt: Date.now()
  };
  updateDb((db) => {
    db.sessions = db.sessions.filter((s) => s.userId !== userId);
    db.sessions.push(session);
    return db;
  });
  return token;
}

function readToken(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  const fromHeader = req.headers["x-session-token"];
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  return null;
}

function getUserFromToken(token) {
  if (!token) return null;
  const db = getDb();
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  return db.users.find((u) => u.id === session.userId) || null;
}

function destroySession(token) {
  updateDb((db) => {
    db.sessions = db.sessions.filter((s) => s.token !== token);
    return db;
  });
}

function requireAuth(req, res, next) {
  const token = readToken(req);
  const user = getUserFromToken(token);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.authToken = token;
  req.user = user;
  return next();
}

module.exports = {
  createSession,
  readToken,
  getUserFromToken,
  destroySession,
  requireAuth
};
