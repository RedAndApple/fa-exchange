require("@nomicfoundation/hardhat-toolbox");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "chain.env.rtf");
let raw = "";
try {
  raw = fs.readFileSync(envPath, "utf8");
} catch (error) {
  throw new Error(
    `Cannot read ${envPath}. Put chain.env.rtf in /chain with RPC_URL and PRIVATE_KEY.`
  );
}

function extractValue(key, content) {
  // RTF text may include control sequences like "\" and "}" after values.
  const regex = new RegExp(`${key}\\s*=\\s*([^\\\\\\s\\}]+)`, "i");
  const match = content.match(regex);
  return match ? match[1].trim() : "";
}

const RPC_URL = extractValue("RPC_URL", raw) || process.env.RPC_URL || "";
let PRIVATE_KEY = extractValue("PRIVATE_KEY", raw) || process.env.PRIVATE_KEY || "";

// Normalize private key: strip 0x and non-hex artifacts from RTF.
PRIVATE_KEY = PRIVATE_KEY.replace(/^0x/i, "").replace(/[^a-fA-F0-9]/g, "").trim();
const normalizedAccount =
  PRIVATE_KEY.length === 64 ? `0x${PRIVATE_KEY}` : "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  networks: {
    sepolia: {
      url: RPC_URL,
      accounts: normalizedAccount ? [normalizedAccount] : []
    }
  }
};