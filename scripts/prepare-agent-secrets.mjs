import { mkdirSync, writeFileSync } from "node:fs";
const secrets = Object.fromEntries(["AGENT_WALLET_KEY", "AGENT_LLM_API_KEY"].map(name => { if (!process.env[name]) throw new Error(`${name} is missing`); return [name, process.env[name]]; }));
mkdirSync("private/phase2b", { recursive: true });
writeFileSync("private/phase2b/secrets.json", JSON.stringify(secrets), { mode: 0o600 });
console.log("Prepared private Cloudflare Secret input; values withheld");
