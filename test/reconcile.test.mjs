import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePurchase } from "../scripts/reconcile.mjs";
import { purchaseRecord, signer } from "./fixtures.mjs";

function fixture({ used = false, timestamp = 1000n, changed = false, transfers = [] } = {}) {
  const record = { ...purchaseRecord(), authorization: { nonce: `0x${"22".repeat(32)}`, validBefore: "1000" } };
  const rpc = {
    getChainId: async () => 84532, getBlockNumber: async () => 102n, getBlock: async () => ({ timestamp }),
    readContract: async ({ functionName, args, blockNumber }) => functionName === "authorizationState" ? used : args[0].toLowerCase() === signer.address.toLowerCase() ? 10000n - (changed && blockNumber > 100n ? 1000n : 0n) : changed && blockNumber > 100n ? 1000n : 0n,
    getLogs: async ({ event }) => event.name === "AuthorizationUsed" ? [] : transfers,
  };
  return { record, rpc };
}
test("unused expired authorization with unchanged balances and no transfers permits an explicit retry decision", async () => { const { record, rpc } = fixture(); assert.equal((await reconcilePurchase(record, rpc)).safeToRetry, true); });
for (const [name, options] of [["unexpired", { timestamp: 999n }], ["used", { used: true }], ["changed balances", { changed: true }]]) test(`reconciliation forbids retry for ${name}`, async () => { const { record, rpc } = fixture(options); assert.equal((await reconcilePurchase(record, rpc)).safeToRetry, false); });
test("unsigned preflight failure is safe without creating or submitting a transaction", async () => { const { record, rpc } = fixture(); delete record.authorization; record.http = []; const result = await reconcilePurchase(record, rpc); assert.equal(result.signed, false); assert.equal(result.safeToRetry, true); });
