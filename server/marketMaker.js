module.exports = function startMarketMaker(engine) {
  const MM_USER = "mm1";

  let basePrice = 1.0;
  let tick = 0;

  function rand(min, max) {
    return Math.random() * (max - min) + min;
  }

  function nextBasePrice() {
    const summary = engine.getSummary();
    const anchor = Number(summary.lastPrice || summary.bestBid || summary.bestAsk || basePrice || 1);

    // мягкое смещение цены
    const drift = rand(-0.005, 0.005);

    // иногда чуть сильнее двигаем рынок
    tick += 1;
    const pulse = tick % 15 === 0 ? rand(-0.02, 0.02) : 0;

    basePrice = anchor + drift + pulse;

    if (basePrice < 0.5) basePrice = 0.5;
    if (basePrice > 5) basePrice = 5;

    return basePrice;
  }

  function placeOrders() {
    const mid = nextBasePrice();

    const spread = rand(0.005, 0.02);
    const bid = Number((mid - spread).toFixed(4));
    const ask = Number((mid + spread).toFixed(4));

    const bidQty = Number(rand(5, 20).toFixed(4));
    const askQty = Number(rand(5, 20).toFixed(4));

    try {
      engine.createOrder({
        userId: MM_USER,
        side: "buy",
        type: "limit",
        price: bid,
        quantity: bidQty
      });
    } catch (_) {}

    try {
      engine.createOrder({
        userId: MM_USER,
        side: "sell",
        type: "limit",
        price: ask,
        quantity: askQty
      });
    } catch (_) {}
  }

  // первый импульс почти сразу
  setTimeout(placeOrders, 800);

  // дальше регулярно
  setInterval(placeOrders, 2000);
};