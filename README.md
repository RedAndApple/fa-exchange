# CEX 3 — FA/USDT Centralized Exchange MVP

Проект переведен на модель "Binance-like CEX" с одной парой `FA/USDT`:

- серверный matching engine (limit/market, price-time priority)
- order book / trades / open orders / history / balances
- registration/login/session
- автоматическое создание пользовательского депозитного адреса
- свечи OHLCV (`1m`, `5m`, `1h`) по реальным сделкам
- сохранен рабочий on-chain flow `MetaMask -> approve -> vault.deposit(userHash, amount)`
- сохранен `POST /api/withdraw` через `ExchangeVault.withdraw`

## Структура backend

`server/`:

- `index.js` — сборка API + watcher Deposited + seed рынка
- `db.js` — JSON persistence (`server/data/db.json`)
- `auth.js` — session token auth
- `users.js` — register/login/logout/me
- `wallets.js` — user deposit wallet model
- `ledger.js` — внутренние балансы available/locked
- `matchingEngine.js` — создание/матчинг/отмена ордеров
- `marketData.js` — summary/orderbook/trades/candles
- `env` — текущая конфигурация RPC/token/vault

## 1) Запуск server

```bash
cd "server"
npm install
node index.js
```

Сервер стартует на `http://localhost:3000` (если в `server/env` не задан другой `PORT`).

## 2) Запуск frontend

Можно просто открыть `index.html` в браузере.

Если браузер блокирует некоторые запросы с `file://`, поднимите статический сервер:

```bash
cd ".."
python3 -m http.server 8080
```

Откройте `http://localhost:8080`.

## 3) Регистрация и вход

1. В блоке `Register` создайте аккаунт (email + password).
2. После регистрации выполняется auto-login.
3. Можно использовать `Login`/`Logout`.
4. Текущий пользователь читается через `GET /api/me`.

## 4) On-chain approve/deposit (сохраненный рабочий flow)

1. Нажмите `Connect MetaMask`.
2. Введите amount в `Approve + Deposit to Vault`.
3. Нажмите `Approve`.
4. Нажмите `Deposit`.

Фронт отправляет `vault.deposit(keccak256(userId), amount)` — watcher на сервере ловит `Deposited` и зачисляет `FA` во внутренний ledger пользователя.

## 5) Торговля FA/USDT

1. Выберите `side` (`buy`/`sell`) и `type` (`limit`/`market`).
2. Для limit укажите цену и количество.
3. Нажмите `Submit Order`.
4. Результат отображается в:
   - `Order Book`
   - `Recent Trades`
   - `Open Orders`
   - `Order History`
   - `Balances`
5. Свечной график (`1m/5m/1h`) строится по `GET /api/market/candles`.

## 6) Withdraw проверка

1. В блоке `Withdraw Request` укажите адрес и amount.
2. Нажмите `Request Withdraw`.
3. Сервер:
   - дебетует внутренний `FA_available`
   - вызывает `vault.withdraw(to, amount)`
   - записывает withdrawal history

Если on-chain withdraw не проходит, внутренний баланс откатывается обратно.

## API (основные)

- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `GET /api/wallet/me`
- `GET /api/balances/me`
- `POST /api/orders`
- `GET /api/orders/open`
- `GET /api/orders/history`
- `DELETE /api/orders/:id`
- `GET /api/market/summary`
- `GET /api/market/orderbook`
- `GET /api/market/trades`
- `GET /api/market/candles?interval=1m`
- `GET /api/config` (legacy preserved)
- `GET /api/balances` (legacy adapted)
- `POST /api/withdraw` (preserved)

## Важно

- Текущая рабочая связка token/vault/server сохранена.
- Добавлена модель пользовательских депозитных адресов (`wallets`) для следующего шага.
- TODO в коде: переход watcher на прямой `ERC20 Transfer(to=userDepositAddress)` без userHash.
