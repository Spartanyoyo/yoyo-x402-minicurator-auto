import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = new URL("../.env.local", import.meta.url);
const sellerFile = new URL("../private/seller-key.txt", import.meta.url);
if (existsSync(envFile) || existsSync(sellerFile)) {
  throw new Error("Wallet files already exist; refusing to overwrite them.");
}
const buyerKey = generatePrivateKey();
const sellerKey = generatePrivateKey();
const buyer = privateKeyToAccount(buyerKey).address;
const seller = privateKeyToAccount(sellerKey).address;
mkdirSync(new URL("../private/", import.meta.url), { recursive: true });
mkdirSync(new URL("../evidence/transactions/", import.meta.url), { recursive: true });
writeFileSync(envFile, [
  `EVM_PRIVATE_KEY=${buyerKey}`,
  `BUYER_ADDRESS=${buyer}`,
  `SELLER_ADDRESS=${seller}`,
  "RESOURCE_SERVER_URL=http://localhost:4021",
  "BASE_SEPOLIA_RPC=https://sepolia.base.org",
  "",
].join("\n"), { mode: 0o600, flag: "wx" });
writeFileSync(sellerFile, `${sellerKey}\n`, { mode: 0o600, flag: "wx" });
const publicInfo = {
  network: "eip155:84532",
  chain: "Base Sepolia",
  asset: "USDC (testnet)",
  assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  buyer,
  seller,
  createdAt: new Date().toISOString(),
};
writeFileSync(new URL("../evidence/transactions/wallets-public.json", import.meta.url), JSON.stringify(publicInfo, null, 2));
console.log(JSON.stringify({ ...publicInfo, localDirectory: root, privateKeys: "Saved locally; not printed." }, null, 2));
