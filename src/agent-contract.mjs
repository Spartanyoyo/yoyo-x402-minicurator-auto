import { createHash } from "node:crypto";
import { SERVICES, serviceParameters } from "./curator-catalog.mjs";

export const AGENT_FEE = 3000;
export const MAX_CALLS = 9;
export const CONCURRENCY = 3;
export const MAX_ROUNDS = 5;
export const RETENTION_MS = 7 * 86400000;
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
export function taskInput(input) {
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !["goal", "budgetAtomic"].includes(key))) throw new Error("Only goal and budgetAtomic are accepted");
  if (typeof input.goal !== "string" || input.goal.trim().length < 5 || input.goal.length > 2000) throw new Error("goal must contain 5..2000 characters");
  const budget = input.budgetAtomic ?? "9000";
  if (typeof budget !== "string" || !/^[3-9]000$/.test(budget)) throw new Error("budgetAtomic must be 3000..9000 in units of 1000; three museums require at least three detail purchases");
  return { goal: input.goal.trim(), budgetAtomic: budget };
}
export function taskIdentity(input, token) {
  if (!/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("A random 32-byte hexadecimal bearer token is required");
  return sha256(JSON.stringify({ ...taskInput(input), tokenHash: sha256(token) }));
}
export function paymentAmount(input) { return String(Number(input.budgetAtomic) + AGENT_FEE); }
export function validateCalls(plan, remaining) {
  if (!plan || typeof plan.finish !== "boolean" || !Array.isArray(plan.calls) || plan.calls.length > Math.min(CONCURRENCY, remaining)) throw new Error("Invalid agent plan or exceeded remaining budget");
  if (plan.finish && plan.calls.length || !plan.finish && !plan.calls.length) throw new Error("Plan must finish or make progress");
  return plan.calls.map(call => {
    if (!call || !SERVICES[call.service] || Object.keys(call).some(key => !["service", "parameters"].includes(key)) || !call.parameters || Array.isArray(call.parameters)) throw new Error("Unknown tool or invalid tool arguments");
    return { service: call.service, parameters: serviceParameters(call.service, call.parameters) };
  });
}
export const callKey = call => sha256(JSON.stringify([call.service, call.parameters]));

export async function readTextBounded(response, maximum = 2 * 1024 * 1024) {
  if (Number(response.headers.get("content-length")) > maximum) throw new Error("Response exceeds size limit");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error("Response exceeds size limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

// Small chunks avoid per-value storage limits; a transaction makes each snapshot atomic.
export class JsonStore {
  constructor(storage) { this.storage = storage; }
  async get(key) {
    return this.storage.transaction(async tx => {
    const meta = await tx.get(`${key}:meta`);
    if (!meta) return undefined;
    const parts = await Promise.all(Array.from({ length: meta.parts }, (_, i) => tx.get(`${key}:${i}`)));
    if (parts.some(part => typeof part !== "string")) throw new Error("Incomplete persisted record");
    const value = parts.join("");
    if (sha256(value) !== meta.hash) throw new Error("Persisted record hash mismatch");
    return JSON.parse(value);
    });
  }
  async put(key, value) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error("Persisted record exceeds 2 MiB");
    const parts = [];
    for (let i = 0; i < encoded.length; i += 16000) parts.push(encoded.slice(i, i + 16000));
    await this.storage.transaction(async tx => {
      const previous = await tx.get(`${key}:meta`);
      for (let i = 0; i < parts.length; i++) await tx.put(`${key}:${i}`, parts[i]);
      for (let i = parts.length; i < (previous?.parts ?? 0); i++) await tx.delete(`${key}:${i}`);
      await tx.put(`${key}:meta`, { parts: parts.length, hash: sha256(encoded) });
    });
  }
}

export async function mapLimited(items, limit, operation) {
  let next = 0; const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) break;
      try { results[index] = { status: "fulfilled", value: await operation(items[index], index) }; }
      catch (error) { results[index] = { status: "rejected", reason: error.message }; }
    }
  }));
  return results;
}
