# Chain (Sepolia): FA Token + ExchangeVault

Этот раздел создаёт ваш собственный реальный ERC-20 токен `FA` и vault-контракт для депозитов/выводов.

## 1) Установка

```bash
cd chain
npm install
```

## 2) Заполнение `.env`

Скопируйте пример и откройте файл:

```bash
cp .env.example .env
```

Вставьте значения:

- `RPC_URL` — HTTPS RPC для Sepolia (Infura/Alchemy/Ankr и т.д.)
- `PRIVATE_KEY` — приватный ключ кошелька-деплойера (без кавычек)
- `INITIAL_SUPPLY_TOKENS` — сколько токенов FA выпустить при деплое (например `1000000`)

Важно:
- Кошелёк из `PRIVATE_KEY` должен быть пополнен Sepolia ETH для газа.
- Никогда не используйте боевой приватный ключ.

## 3) Компиляция

```bash
npx hardhat compile
```

## 4) Деплой в Sepolia

```bash
npx hardhat run scripts/deploy.js --network sepolia
```

После деплоя вы увидите:

- `TOKEN_ADDRESS=...`
- `VAULT_ADDRESS=...`

Эти адреса нужно вставить в `server/.env`.
