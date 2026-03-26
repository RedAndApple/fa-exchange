const { ethers } = require("ethers");

module.exports = function createDepositWatcher({
  provider,
  hotWallet,
  tokenAddress,
  vaultAddress,
  usersById,
  depositAddressToUserId,
  ledger,
  creditedTransfers,
  sweptTransfers,
  GAS_TOPUP_ETH = "0.0005",
  MIN_GAS_ETH = "0.0002",
  masterNode
}) {
  const erc20Abi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)"
  ];

  const tokenRead = tokenAddress
    ? new ethers.Contract(tokenAddress, erc20Abi, provider)
    : null;

  const lastKnownNativeBalance = {};

  function round8(value) {
    return Number(Number(value).toFixed(8));
  }

  function ensureUserLedger(userId) {
    if (!ledger[userId]) {
      ledger[userId] = {
        FA_available: 0,
        FA_locked: 0,
        USDT_available: 10000,
        USDT_locked: 0
      };
    }
    return ledger[userId];
  }

  function getUserSigner(user) {
    if (user.depositPrivateKey) {
      return new ethers.Wallet(user.depositPrivateKey, provider);
    }

    if (user.walletIndex == null) {
      throw new Error(`No walletIndex for user ${user.id}`);
    }

    const node = masterNode.deriveChild(user.walletIndex);
    return new ethers.Wallet(node.privateKey, provider);
  }

  async function ensureGasForSweep(address) {
    const current = await provider.getBalance(address);
    const minGas = ethers.parseEther(MIN_GAS_ETH);

    if (current >= minGas) return;

    const tx = await hotWallet.sendTransaction({
      to: address,
      value: ethers.parseEther(GAS_TOPUP_ETH)
    });

    await tx.wait();
    console.log(`Gas top up complete for ${address}: ${tx.hash}`);
  }

  async function sweepUserDeposit(userId, reason = "native-balance-delta") {
    const sweepId = `${userId}:${reason}`;
    if (sweptTransfers.has(sweepId)) return;

    const user = usersById[userId];
    if (!user) return;

    try {
      const userSigner = getUserSigner(user);

      await ensureGasForSweep(user.depositAddress);

      const nativeBal = await provider.getBalance(user.depositAddress);
      if (nativeBal <= 0n) {
        sweptTransfers.add(sweepId);
        return;
      }

      const feeData = await provider.getFeeData();
      const gasPrice =
        feeData.gasPrice ??
        feeData.maxFeePerGas ??
        ethers.parseUnits("1", "gwei");

      const gasLimit = 21000n;
      const fee = gasPrice * gasLimit;

      if (nativeBal <= fee) {
        console.log(
          `Sweep skipped for ${userId}: balance ${ethers.formatEther(nativeBal)} is not enough to cover fee`
        );
        return;
      }

      const amountToSend = nativeBal - fee;

      console.log(
        `Sweeping ${ethers.formatEther(amountToSend)} FA from ${user.depositAddress} to ${await hotWallet.getAddress()}`
      );

      const tx = await userSigner.sendTransaction({
        to: await hotWallet.getAddress(),
        value: amountToSend,
        gasLimit,
        gasPrice
      });

      await tx.wait();

      sweptTransfers.add(sweepId);
      console.log(`Sweep complete for ${userId}: ${tx.hash}`);
    } catch (e) {
      console.error(`Sweep failed for ${userId}:`, e.message);
    }
  }

  async function initKnownBalances() {
    const addresses = Object.keys(depositAddressToUserId);

    for (const address of addresses) {
      try {
        const bal = await provider.getBalance(address);
        lastKnownNativeBalance[address] = bal;
      } catch (e) {
        console.error(`Init balance failed for ${address}:`, e.message);
        lastKnownNativeBalance[address] = 0n;
      }
    }

    console.log("Native balance watcher initialized.");
    console.log(
      "Known deposit addresses:",
      Object.keys(depositAddressToUserId)
    );
  }

  async function scanNativeDeposits() {
    try {
      const addresses = Object.keys(depositAddressToUserId);

      for (const address of addresses) {
        const userId = depositAddressToUserId[address];
        if (!userId) continue;

        let currentBal;
        try {
          currentBal = await provider.getBalance(address);
        } catch (e) {
          console.error(`Balance read failed for ${address}:`, e.message);
          continue;
        }

        const previousBal =
          lastKnownNativeBalance[address] != null
            ? lastKnownNativeBalance[address]
            : 0n;

        if (currentBal > previousBal) {
          const delta = currentBal - previousBal;
          const amount = Number(ethers.formatEther(delta));

          if (Number.isFinite(amount) && amount > 0) {
            const uniqueId = `${address}:${currentBal.toString()}`;

            if (!creditedTransfers.has(uniqueId)) {
              creditedTransfers.add(uniqueId);

              const bal = ensureUserLedger(userId);
              bal.FA_available = round8(bal.FA_available + amount);

              console.log("Direct native deposit credited by balance delta");
              console.log("user:", userId);
              console.log("address:", address);
              console.log("previous:", ethers.formatEther(previousBal));
              console.log("current:", ethers.formatEther(currentBal));
              console.log("delta:", ethers.formatEther(delta));
              console.log("new exchange balance:", bal.FA_available);

              setTimeout(() => {
                sweepUserDeposit(userId, uniqueId).catch((e) =>
                  console.error("Sweep error:", e.message)
                );
              }, 3000);
            }
          }
        }

        lastKnownNativeBalance[address] = currentBal;
      }
    } catch (e) {
      console.error("Direct native balance watcher error:", e.message);
    }
  }

  function startERC20Watcher() {
    if (!tokenRead) return;

    console.log("Watching direct ERC20 deposits to user addresses...");

    tokenRead.on("Transfer", async (from, to, value, event) => {
      try {
        const toLower = String(to).toLowerCase();
        const userId = depositAddressToUserId[toLower];

        if (!userId) return;

        const txHash = event.log.transactionHash;
        const logIndex = event.log.index;
        const uniqueId = `${txHash}:${logIndex}`;

        if (creditedTransfers.has(uniqueId)) return;

        creditedTransfers.add(uniqueId);

        const bal = ensureUserLedger(userId);
        bal.FA_available = round8(
          bal.FA_available + Number(ethers.formatUnits(value, 18))
        );

        console.log("Direct ERC20 deposit credited");
        console.log("user:", userId);
        console.log("from:", from);
        console.log("to:", to);
        console.log("amount:", ethers.formatUnits(value, 18));

        setTimeout(() => {
          sweepUserDeposit(userId, uniqueId).catch((e) =>
            console.error("Sweep error:", e.message)
          );
        }, 3000);
      } catch (e) {
        console.error("Direct ERC20 deposit watcher error:", e.message);
      }
    });
  }

  function start() {
    console.log("Watching direct NATIVE deposits to user addresses...");

    initKnownBalances()
      .then(() => scanNativeDeposits())
      .catch((e) => console.error("Init watcher failed:", e.message));

    setInterval(async () => {
      try {
        const latest = await provider.getBlockNumber();
        console.log("Watcher heartbeat. Latest block:", latest);
        await scanNativeDeposits();
      } catch (e) {
        console.error("Watcher heartbeat error:", e.message);
      }
    }, 10000);

    startERC20Watcher();
  }

  return {
    start,
    sweepUserDeposit
  };
};