# Server: Exchange API + Deposit Watcher

Бэкенд хранит внутренние FA-балансы `u1/u2/u3`, слушает депозиты из `ExchangeVault` и исполняет выводы.

## 1) Установка

```bash
cd server
npm install
```

## 2) Заполнить `.env`

```bash
cp .env.example .env
```

Поля:

- `RPC_URL` — Sepolia RPC URL
- `PRIVATE_KEY` — ключ владельца vault (этот адрес должен быть owner в `ExchangeVault`)
- `TOKEN_ADDRESS` — адрес FA токена из `chain/scripts/deploy.js`
- `VAULT_ADDRESS` — адрес vault из `chain/scripts/deploy.js`
- `CONFIRMATIONS` — число подтверждений для депозитов и withdraw wait (рекомендуется `2`)
- `PORT` — порт API (по умолчанию `3001`)

## 3) Запуск

```bash
node index.js
```

## Что делает сервер

- Следит за `Deposited(userId, from, amount)` в `ExchangeVault`
- Ждёт `CONFIRMATIONS` блоков
- Кредитит внутренние балансы для `u1/u2/u3` (через `keccak256("u1")`, `keccak256("u2")`, `keccak256("u3")`)
- Идемпотентность: ключ `txHash + logIndex`

## API

- `GET /api/config` -> `{ chainId, tokenAddress, vaultAddress }`
- `GET /api/balances` -> внутренние FA балансы `u1/u2/u3`
- `POST /api/withdraw` body:

```json
{
  "userId": "u1",
  "to": "0x...",
  "amountHuman": "12.5"
}
```

Логика withdraw:
- проверка внутреннего баланса пользователя
- вызов `vault.withdraw(to, amountWei)`
- списание внутреннего баланса
- сохранение `txHash`
