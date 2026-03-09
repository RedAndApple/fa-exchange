const API_BASE = "";
const WS_URL =
  location.protocol === "https:"
    ? "wss://" + location.host
    : "ws://" + location.host;
const SYMBOL = "FAUSDT";
const DEFAULT_INTERVAL = "1m";
const REFRESH_MS = 12000;
const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

let currentInterval = DEFAULT_INTERVAL;
let chart;
let candleSeries;
let socket;

const state = {
  me: null,
  provider: null,
  signer: null,
  walletAddress: "",
  config: null
};

const els = {
  currentUser: document.getElementById("current-user"),
  logoutBtn: document.getElementById("logout-btn"),

  registerForm: document.getElementById("register-form"),
  loginForm: document.getElementById("login-form"),
  authStatus: document.getElementById("auth-status"),

  lastPrice: document.getElementById("last-price"),
  bestBid: document.getElementById("best-bid"),
  bestAsk: document.getElementById("best-ask"),
  spread: document.getElementById("spread"),

  bidsBody: document.getElementById("bids-body"),
  asksBody: document.getElementById("asks-body"),
  tradesBody: document.getElementById("trades-body"),

  orderForm: document.getElementById("order-form"),
  orderSide: document.getElementById("order-side"),
  orderType: document.getElementById("order-type"),
  orderPrice: document.getElementById("order-price"),
  orderQty: document.getElementById("order-qty"),
  orderStatus: document.getElementById("order-status"),

  balancesBody: document.getElementById("balances-body"),
  openOrdersBody: document.getElementById("open-orders-body"),
  orderHistoryBody: document.getElementById("order-history-body"),

  tokenAddress: document.getElementById("token-address"),
  vaultAddress: document.getElementById("vault-address"),
  connectedAddress: document.getElementById("connected-address"),
  userDepositAddress: document.getElementById("user-deposit-address"),
  connectBtn: document.getElementById("connect-btn"),

  depositForm: document.getElementById("deposit-form"),
  depositAmount: document.getElementById("deposit-amount"),
  approveBtn: document.getElementById("approve-btn"),
  depositBtn: document.getElementById("deposit-btn"),

  withdrawForm: document.getElementById("withdraw-form"),
  withdrawTo: document.getElementById("withdraw-to"),
  withdrawAmount: document.getElementById("withdraw-amount"),
  onchainStatus: document.getElementById("onchain-status"),

  chartContainer: document.getElementById("chart-container"),
  intervalButtons: document.querySelectorAll(".interval-btn")
};

function setText(el, text) {
  if (el) el.textContent = text;
}

function setStatus(el, text, type = "") {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("error", "success");
  if (type) el.classList.add(type);
}

function safeFixed(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(digits);
}

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString();
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

/* =========================
   SOCKET
========================= */

function connectSocket() {
  socket = new WebSocket(WS_URL);

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "summary") {
      renderSummary(msg.payload);
    }

    if (msg.type === "orderbook") {
      renderOrderBook(msg.payload);
    }

    if (msg.type === "trade") {
      prependTrade(msg.payload);
      loadOrderHistory();
      loadOpenOrders();
      loadBalances();
    }

    if (msg.type === "trades") {
      renderTrades(msg.payload);
    }

    if (msg.type === "candles") {
      if (!msg.payload.interval || msg.payload.interval === currentInterval) {
        renderCandles(msg.payload.candles || []);
      }
    }

    if (msg.type === "balance_update" && state.me && msg.payload.userId === state.me.id) {
      renderBalances(msg.payload.balances || []);
    }
  };

  socket.onclose = () => {
    setTimeout(connectSocket, 2000);
  };
}

/* =========================
   AUTH
========================= */

async function register(event) {
  event.preventDefault();
  try {
    const email = document.getElementById("register-email").value.trim();
    const password = document.getElementById("register-password").value;

    await api("/api/register", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    setStatus(els.authStatus, "Registration successful.", "success");
    await refreshMe();
    await refreshTradingData();
  } catch (e) {
    setStatus(els.authStatus, `Register failed: ${e.message}`, "error");
  }
}

async function login(event) {
  event.preventDefault();
  try {
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;

    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    setStatus(els.authStatus, "Login successful.", "success");
    await refreshMe();
    await refreshTradingData();
  } catch (e) {
    setStatus(els.authStatus, `Login failed: ${e.message}`, "error");
  }
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch (_) {
    // ignore
  }

  state.me = null;
  renderMe();
  renderBalances([]);
  renderOpenOrders([]);
  renderOrderHistory([]);
  setText(els.userDepositAddress, "Login required");
}

async function refreshMe() {
  try {
    const payload = await api("/api/me");
    state.me = payload.user || null;
  } catch (_) {
    state.me = null;
  }

  renderMe();
}

function renderMe() {
  if (state.me) {
    setText(els.currentUser, `${state.me.email} (${state.me.id})`);
    els.logoutBtn.classList.remove("hidden");
  } else {
    setText(els.currentUser, "Not logged in");
    els.logoutBtn.classList.add("hidden");
    setText(els.userDepositAddress, "Login required");
  }
}

/* =========================
   CONFIG / WALLET
========================= */

async function loadConfig() {
  const cfg = await api("/api/config");
  state.config = cfg;

  setText(els.tokenAddress, cfg.tokenAddress || "-");
  setText(els.vaultAddress, cfg.vaultAddress || "-");
}

async function loadDepositAddress() {
  if (!state.me) {
    setText(els.userDepositAddress, "Login required");
    return;
  }

  try {
    const payload = await api("/api/wallet/me");
    setText(els.userDepositAddress, payload.address || "-");
  } catch {
    setText(els.userDepositAddress, "Unavailable");
  }
}

function renderWalletAddress(address) {
  setText(els.connectedAddress, address || "Not connected");
}

async function connectMetaMask() {
  try {
    if (!window.ethereum) {
      throw new Error("MetaMask not found.");
    }

    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }]
    });

    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    const address = await signer.getAddress();

    state.provider = provider;
    state.signer = signer;
    state.walletAddress = address;

    renderWalletAddress(address);

    if (!els.withdrawTo.value) {
      els.withdrawTo.value = address;
    }

    setStatus(els.onchainStatus, "MetaMask connected.", "success");
  } catch (e) {
    setStatus(els.onchainStatus, `Connect failed: ${e.message}`, "error");
  }
}

/* =========================
   MARKET
========================= */

function renderSummary(data) {
  setText(els.lastPrice, safeFixed(data.lastPrice, 6));
  setText(els.bestBid, safeFixed(data.bestBid, 6));
  setText(els.bestAsk, safeFixed(data.bestAsk, 6));

  if (Number.isFinite(Number(data.bestBid)) && Number.isFinite(Number(data.bestAsk))) {
    setText(els.spread, safeFixed(Number(data.bestAsk) - Number(data.bestBid), 6));
  } else {
    setText(els.spread, "-");
  }
}

function renderOrderBook(payload) {
  renderBookRows(els.bidsBody, payload.bids || []);
  renderBookRows(els.asksBody, payload.asks || []);
}

function renderBookRows(tbody, rows) {
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="2" class="empty">No data</td></tr>`;
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${safeFixed(row.price, 6)}</td>
      <td>${safeFixed(row.quantity, 6)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderTrades(trades) {
  els.tradesBody.innerHTML = "";

  if (!trades.length) {
    els.tradesBody.innerHTML = `<tr><td colspan="3" class="empty">No trades</td></tr>`;
    return;
  }

  trades.forEach((trade) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTime(trade.time)}</td>
      <td>${safeFixed(trade.price, 6)}</td>
      <td>${safeFixed(trade.quantity, 6)}</td>
    `;
    els.tradesBody.appendChild(tr);
  });
}

function prependTrade(trade) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${fmtTime(trade.time)}</td>
    <td>${safeFixed(trade.price, 6)}</td>
    <td>${safeFixed(trade.quantity, 6)}</td>
  `;

  els.tradesBody.prepend(tr);

  while (els.tradesBody.children.length > 50) {
    els.tradesBody.removeChild(els.tradesBody.lastChild);
  }
}

async function loadSummary() {
  const payload = await api(`/api/market/summary?symbol=${SYMBOL}`);
  renderSummary(payload);
}

async function loadOrderBook() {
  const payload = await api(`/api/market/orderbook?symbol=${SYMBOL}`);
  renderOrderBook(payload);
}

async function loadTrades() {
  const payload = await api(`/api/market/trades?symbol=${SYMBOL}`);
  renderTrades(payload.trades || []);
}

/* =========================
   CHART
========================= */

function initChart() {
  chart = LightweightCharts.createChart(els.chartContainer, {
    width: els.chartContainer.clientWidth || 700,
    height: 320,
    layout: {
      background: { color: "#161b22" },
      textColor: "#e6edf3"
    },
    grid: {
      vertLines: { color: "#28303a" },
      horzLines: { color: "#28303a" }
    },
    rightPriceScale: { borderColor: "#30363d" },
    timeScale: { borderColor: "#30363d" }
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#2ea043",
    borderUpColor: "#2ea043",
    wickUpColor: "#2ea043",
    downColor: "#f85149",
    borderDownColor: "#f85149",
    wickDownColor: "#f85149"
  });

  window.addEventListener("resize", () => {
    chart.applyOptions({
      width: els.chartContainer.clientWidth || 700
    });
  });
}

function renderCandles(candles) {
  const data = candles.map((c) => ({
    time: Math.floor(c.ts / 1000),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));

  candleSeries.setData(data);
}

async function loadCandles() {
  const payload = await api(`/api/market/candles?symbol=${SYMBOL}&interval=${currentInterval}`);
  renderCandles(payload.candles || []);
}

function bindIntervalButtons() {
  els.intervalButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      els.intervalButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentInterval = btn.dataset.interval;
      await loadCandles();
    });
  });
}

/* =========================
   BALANCES / ORDERS
========================= */

function renderBalances(rows) {
  els.balancesBody.innerHTML = "";

  if (!rows.length) {
    els.balancesBody.innerHTML = `<tr><td colspan="3" class="empty">No balances</td></tr>`;
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.asset}</td>
      <td>${safeFixed(row.available, 6)}</td>
      <td>${safeFixed(row.locked, 6)}</td>
    `;
    els.balancesBody.appendChild(tr);
  });
}

async function loadBalances() {
  if (!state.me) {
    renderBalances([]);
    return;
  }

  const payload = await api("/api/balances/me");
  renderBalances(payload.balances || []);
}

function renderOpenOrders(rows) {
  els.openOrdersBody.innerHTML = "";

  if (!rows.length) {
    els.openOrdersBody.innerHTML = `<tr><td colspan="6" class="empty">No open orders</td></tr>`;
    return;
  }

  rows.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.side}</td>
      <td>${o.type}</td>
      <td>${o.price != null ? safeFixed(o.price, 6) : "-"}</td>
      <td>${safeFixed(o.remaining, 6)}</td>
      <td><button type="button" data-order-id="${o.id}">Cancel</button></td>
    `;
    els.openOrdersBody.appendChild(tr);
  });

  els.openOrdersBody.querySelectorAll("button[data-order-id]").forEach((btn) => {
    btn.addEventListener("click", () => cancelOrder(btn.dataset.orderId));
  });
}

function renderOrderHistory(rows) {
  els.orderHistoryBody.innerHTML = "";

  if (!rows.length) {
    els.orderHistoryBody.innerHTML = `<tr><td colspan="6" class="empty">No order history</td></tr>`;
    return;
  }

  rows.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${o.side}</td>
      <td>${o.type}</td>
      <td>${o.price != null ? safeFixed(o.price, 6) : "-"}</td>
      <td>${safeFixed(o.quantity, 6)}</td>
      <td>${o.status}</td>
    `;
    els.orderHistoryBody.appendChild(tr);
  });
}

async function loadOpenOrders() {
  if (!state.me) {
    renderOpenOrders([]);
    return;
  }

  const payload = await api(`/api/orders/open?symbol=${SYMBOL}`);
  renderOpenOrders(payload.orders || []);
}

async function loadOrderHistory() {
  if (!state.me) {
    renderOrderHistory([]);
    return;
  }

  const payload = await api(`/api/orders/history?symbol=${SYMBOL}`);
  renderOrderHistory(payload.orders || []);
}

/* =========================
   ORDER FORM
========================= */

function handleOrderTypeUI() {
  const isMarket = els.orderType.value === "market";
  els.orderPrice.disabled = isMarket;
  els.orderPrice.required = !isMarket;

  if (isMarket) {
    els.orderPrice.value = "";
    els.orderPrice.style.opacity = "0.6";
  } else {
    els.orderPrice.style.opacity = "1";
  }
}

async function submitOrder(event) {
  event.preventDefault();

  try {
    if (!state.me) throw new Error("Login first.");

    const side = els.orderSide.value;
    const type = els.orderType.value;
    const quantity = String(els.orderQty.value || "").trim();
    const price = String(els.orderPrice.value || "").trim();

    const body = {
      symbol: SYMBOL,
      side,
      type,
      quantity
    };

    if (type === "limit") {
      body.price = price;
    }

    const payload = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify(body)
    });

    setStatus(els.orderStatus, payload.message || "Order submitted.", "success");
    els.orderForm.reset();
    handleOrderTypeUI();

    await loadBalances();
    await loadOpenOrders();
    await loadOrderHistory();
  } catch (e) {
    setStatus(els.orderStatus, `Order failed: ${e.message}`, "error");
  }
}

async function cancelOrder(orderId) {
  try {
    await api(`/api/orders/${orderId}`, { method: "DELETE" });
    setStatus(els.orderStatus, `Order ${orderId} cancelled.`, "success");
    await loadOpenOrders();
    await loadOrderHistory();
    await loadBalances();
  } catch (e) {
    setStatus(els.orderStatus, `Cancel failed: ${e.message}`, "error");
  }
}

/* =========================
   DEPOSIT / WITHDRAW
========================= */

function requireSigner() {
  if (!state.signer || !state.config) {
    throw new Error("Connect MetaMask first.");
  }
  return state.signer;
}

function requireLoggedInUser() {
  if (!state.me || !state.me.id) {
    throw new Error("Login first.");
  }
  return state.me;
}

function parseDepositAmountWei() {
  const raw = String(els.depositAmount.value || "").trim();
  if (!raw) throw new Error("Deposit amount is required.");
  return ethers.parseUnits(raw, 18);
}

async function approveDeposit() {
  try {
    const signer = requireSigner();
    const amountWei = parseDepositAmountWei();

    const token = new ethers.Contract(
      state.config.tokenAddress,
      ["function approve(address spender,uint256 amount) external returns (bool)"],
      signer
    );

    setStatus(els.onchainStatus, "Sending approve...", "success");
    const tx = await token.approve(state.config.vaultAddress, amountWei);
    await tx.wait();

    setStatus(els.onchainStatus, `Approve confirmed: ${tx.hash}`, "success");
  } catch (e) {
    setStatus(els.onchainStatus, `Approve failed: ${e.message}`, "error");
  }
}

async function depositToVault(event) {
  event.preventDefault();

  try {
    const signer = requireSigner();
    const me = requireLoggedInUser();
    const amountWei = parseDepositAmountWei();

    const vault = new ethers.Contract(
      state.config.vaultAddress,
      ["function deposit(bytes32 userId,uint256 amount) external"],
      signer
    );

    const userHash = ethers.keccak256(ethers.toUtf8Bytes(String(me.id)));

    setStatus(els.onchainStatus, "Sending deposit...", "success");
    const tx = await vault.deposit(userHash, amountWei);
    await tx.wait();

    setStatus(els.onchainStatus, `Deposit confirmed: ${tx.hash}`, "success");
    setTimeout(async () => {
      await loadBalances();
      await loadOrderHistory();
    }, 4000);
  } catch (e) {
    setStatus(els.onchainStatus, `Deposit failed: ${e.message}`, "error");
  }
}

async function requestWithdraw(event) {
  event.preventDefault();

  try {
    const me = requireLoggedInUser();
    const to = String(els.withdrawTo.value || "").trim();
    const amountHuman = String(els.withdrawAmount.value || "").trim();

    if (!to) throw new Error("Destination address is required.");
    if (!amountHuman) throw new Error("Withdraw amount is required.");

    setStatus(els.onchainStatus, "Sending withdraw request...", "success");

    const payload = await api("/api/withdraw", {
      method: "POST",
      body: JSON.stringify({
        userId: me.id,
        to,
        amountHuman
      })
    });

    setStatus(els.onchainStatus, `Withdraw tx sent: ${payload.txHash}`, "success");
    setTimeout(loadBalances, 4000);
  } catch (e) {
    setStatus(els.onchainStatus, `Withdraw failed: ${e.message}`, "error");
  }
}

/* =========================
   REFRESH
========================= */

async function refreshTradingData() {
  await Promise.allSettled([
    loadSummary(),
    loadOrderBook(),
    loadTrades(),
    loadCandles(),
    loadBalances(),
    loadOpenOrders(),
    loadOrderHistory(),
    loadDepositAddress()
  ]);
}

async function refreshAll() {
  await Promise.allSettled([loadConfig(), refreshMe()]);
  await refreshTradingData();
}

/* =========================
   BINDINGS
========================= */

function bindEvents() {
  els.registerForm.addEventListener("submit", register);
  els.loginForm.addEventListener("submit", login);
  els.logoutBtn.addEventListener("click", logout);

  els.orderType.addEventListener("change", handleOrderTypeUI);
  els.orderForm.addEventListener("submit", submitOrder);

  els.connectBtn.addEventListener("click", connectMetaMask);
  els.approveBtn.addEventListener("click", approveDeposit);
  els.depositForm.addEventListener("submit", depositToVault);
  els.withdrawForm.addEventListener("submit", requestWithdraw);

  bindIntervalButtons();
}

/* =========================
   INIT
========================= */

async function init() {
  bindEvents();
  initChart();
  handleOrderTypeUI();
  renderWalletAddress("");
  connectSocket();

  await refreshAll();

  setInterval(refreshTradingData, REFRESH_MS);
}

init();