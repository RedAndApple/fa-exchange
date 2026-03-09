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

  const tokenRead = new ethers.Contract(tokenAddress, erc20Abi, provider);

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
  }

  async function sweepUserDeposit(userId, txHash, logIndex) {
    const sweepId = `${txHash}:${logIndex}`;
    if (sweptTransfers.has(sweepId)) return;

    const user = usersById[userId];
    if (!user) return;

    try {
      const userSigner = getUserSigner(user);
      const userToken = new ethers.Contract(tokenAddress, erc20Abi, userSigner);

      await ensureGasForSweep(user.depositAddress);

      const tokenBal = await userToken.balanceOf(user.depositAddress);
      if (tokenBal <= 0n) {
        sweptTransfers.add(sweepId);
        return;
      }

      console.log(
        `Sweeping ${ethers.formatUnits(tokenBal, 18)} FA from ${user.depositAddress} to ${vaultAddress}`
      );

      const tx = await userToken.transfer(vaultAddress, tokenBal);
      await tx.wait();

      sweptTransfers.add(sweepId);
      console.log(`Sweep complete for ${userId}: ${tx.hash}`);
    } catch (e) {
      console.error(`Sweep failed for ${userId}:`, e.message);
    }
  }

  function start() {
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

        console.log("Direct deposit credited");
        console.log("user:", userId);
        console.log("from:", from);
        console.log("to:", to);
        console.log("amount:", ethers.formatUnits(value, 18));

        setTimeout(() => {
          sweepUserDeposit(userId, txHash, logIndex).catch((e) =>
            console.error("Sweep error:", e.message)
          );
        }, 3000);
      } catch (e) {
        console.error("Direct deposit watcher error:", e.message);
      }
    });
  }

  return {
    start,
    sweepUserDeposit
  };
};