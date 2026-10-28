import { mkdirSync, writeFileSync } from "node:fs";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { validateProbe } from "./probe-checks.mjs";

const base = new URL(process.argv[2] ?? process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021");
const record = { at: new Date().toISOString(), baseUrl: base.origin, status: "checking" };
mkdirSync("evidence/verification", { recursive: true });
const file = `evidence/verification/probe-${Date.now()}.json`;
const save = () => writeFileSync(file, JSON.stringify(record, null, 2));
save();
for (const path of ["/F-02.md", "/health", "/weather?latitude=31.2304&longitude=121.4737"]) {
  try {
    const response = await fetch(new URL(path, base), { redirect: "error", signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    record[path] = { status: response.status, receivedAt: new Date().toISOString(), headers: Object.fromEntries(response.headers), body: text };
    save();
    if (!path.endsWith(".md")) record[path].body = JSON.parse(text);
    const required = response.headers.get("payment-required");
    if (required) record[path].paymentRequired = decodePaymentRequiredHeader(required);
    save();
    console.log(JSON.stringify({ path, status: response.status }));
  } catch (error) {
    record.status = "failed";
    record.error = { path, message: error.message };
    save();
    throw error;
  }
}
try {
  validateProbe(record, process.env.SELLER_ADDRESS);
  record.status = "passed";
  save();
} catch (error) {
  record.status = "failed";
  record.error = { message: error.message };
  save();
  throw new Error(`${error.message}; inspect ${file}`);
}
console.log(JSON.stringify({ evidence: file, docsRead: true, statuses: [200, 200, 402], quote: record["/weather?latitude=31.2304&longitude=121.4737"].paymentRequired }, null, 2));
