const hre = require("hardhat");

async function main() {
  const TOKEN_ADDRESS = "0xad5B2Aa0E22fA085436C7Ae8F12f9F449D6A7F38";

  const Vault = await hre.ethers.getContractFactory("ExchangeVault");
  const vault = await Vault.deploy(TOKEN_ADDRESS);

  await vault.waitForDeployment();

  console.log("Vault deployed to:", await vault.getAddress());
  console.log("Token used:", TOKEN_ADDRESS);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});