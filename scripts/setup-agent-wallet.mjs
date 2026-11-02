import { readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const path = ".env.phase2b.local";
let config = readFileSync(path, "utf8");
let key = config.split(/\r?\n/).find(line => line.startsWith("AGENT_WALLET_KEY="))?.split("=")[1];
if (!key) {
  key = generatePrivateKey();
  config = config.replace(/^AGENT_WALLET_KEY=.*$/m, `AGENT_WALLET_KEY=${key}`);
  writeFileSync(path, config, { mode: 0o600 });
}
console.log(JSON.stringify({ cloudWallet: privateKeyToAccount(key).address, dedicatedTestWallet: true }));
