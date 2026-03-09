const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const DEFAULT_DB = {
  users: [],
  sessions: [],
  wallets: [],
  balances: {},
  orders: [],
  trades: [],
  deposits: [],
  withdrawals: [],
  candles: {
    "1m": [],
    "5m": [],
    "1h": []
  },
  marketState: {
    symbol: "FAUSDT",
    lastPrice: 1,
    bestBid: null,
    bestAsk: null,
    lastOrderId: 0,
    lastTradeId: 0,
    lastUserId: 0,
    lastDepositId: 0,
    lastWithdrawalId: 0,
    lastScannedBlock: 0
  }
};

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function loadDb() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    const seeded = JSON.parse(JSON.stringify(DEFAULT_DB));
    saveDb(seeded);
    cache = seeded;
    return cache;
  }

  const raw = fs.readFileSync(DB_PATH, "utf8");
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  cache = deepMerge(DEFAULT_DB, parsed);
  return cache;
}

function saveDb(next) {
  ensureDir();
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmpPath, DB_PATH);
  cache = next;
}

function getDb() {
  if (!cache) return loadDb();
  return cache;
}

function updateDb(mutator) {
  const current = JSON.parse(JSON.stringify(getDb()));
  const updated = mutator(current) || current;
  saveDb(updated);
  return updated;
}

function nextId(counterKey) {
  let idValue = 0;
  updateDb((db) => {
    db.marketState[counterKey] = Number(db.marketState[counterKey] || 0) + 1;
    idValue = db.marketState[counterKey];
    return db;
  });
  return idValue;
}

module.exports = {
  DB_PATH,
  getDb,
  loadDb,
  saveDb,
  updateDb,
  nextId
};
