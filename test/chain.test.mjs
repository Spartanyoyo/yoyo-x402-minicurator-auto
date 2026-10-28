import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { auditPurchase, chainClient, rpcUrls } from "../scripts/chain.mjs";
import { authorizationNonce, fakeRpc, purchaseRecord, signer, seller } from "./fixtures.mjs";

test("read-only RPC falls back once when the primary endpoint is unavailable", async t => {
  const calls = { primary: 0, backup: 0 };
  let backupHealthy = true;
  const primary = createServer((_req, res) => {
    calls.primary++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end("{}");
  });
  const backup = createServer(async (req, res) => {
    calls.backup++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.method, "eth_chainId");
    if (!backupHealthy) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x14a34" }));
  });
  t.after(() => {
    primary.closeAllConnections();
    backup.closeAllConnections();
    primary.close();
    backup.close();
  });
  primary.listen(0, "127.0.0.1");
  backup.listen(0, "127.0.0.1");
  await Promise.all([once(primary, "listening"), once(backup, "listening")]);
  const env = { BASE_SEPOLIA_RPCS: `http://127.0.0.1:${primary.address().port},http://127.0.0.1:${backup.address().port}` };
  assert.equal(await chainClient({ env }).getChainId(), 84532);
  assert.deepEqual(calls, { primary: 1, backup: 1 });
  backupHealthy = false;
  calls.primary = 0;
  calls.backup = 0;
  await assert.rejects(chainClient({ env }).getChainId());
  assert.deepEqual(calls, { primary: 1, backup: 1 });
});

test("JSON-RPC rate-limit errors switch to the next endpoint", async t => {
  const calls = [];
  const limited = createServer(async (req, res) => {
    calls.push("limited");
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32005, message: "Too Many Requests" } }));
  });
  const healthy = createServer(async (req, res) => {
    calls.push("healthy");
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x14a34" }));
  });
  t.after(() => {
    for (const server of [limited, healthy]) { server.closeAllConnections(); server.close(); }
  });
  limited.listen(0, "127.0.0.1");
  healthy.listen(0, "127.0.0.1");
  await Promise.all([once(limited, "listening"), once(healthy, "listening")]);
  const env = { BASE_SEPOLIA_RPCS: `http://127.0.0.1:${limited.address().port},http://127.0.0.1:${healthy.address().port}` };
  assert.equal(await chainClient({ env }).getChainId(), 84532);
  assert.deepEqual(calls, ["limited", "healthy"]);
});
test("RPC configuration preserves legacy variables and accepts an ordered override", () => {
  const defaults = rpcUrls({});
  assert.equal(defaults.length, 8);
  assert.equal(new Set(defaults).size, defaults.length);
  assert.ok(defaults.every(url => url.startsWith("https://")));
  const legacy = rpcUrls({ BASE_SEPOLIA_RPC: "https://primary.example", BASE_SEPOLIA_FALLBACK_RPC: "https://backup.example" });
  assert.deepEqual(legacy, ["https://primary.example/", "https://backup.example/", ...defaults]);
  assert.equal(rpcUrls({ BASE_SEPOLIA_RPC: defaults[6] }).length, defaults.length);
  assert.deepEqual(rpcUrls({ BASE_SEPOLIA_RPCS: " https://one.example,https://one.example/,https://two.example ", BASE_SEPOLIA_RPC: "https://ignored.example" }), ["https://one.example/", "https://two.example/"]);
});

test("unsafe or empty RPC lists are rejected without making requests", () => {
  for (const value of ["", "https://one.example,", "http://remote.example", "https://user:password@example.com", "https://one.example/#fragment", "file:///C:/test"]) {
    assert.throws(() => chainClient({ env: { BASE_SEPOLIA_RPCS: value } }), /RPC list/);
  }
});

test("RPC list skips unavailable and rate-limited endpoints in order and stops after success", async t => {
  const calls = [];
  let healthy = true;
  const servers = [503, 429, 200, 200].map((status, index) => createServer(async (req, res) => {
    calls.push(index);
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const responseStatus = index >= 2 && !healthy ? 503 : status;
    res.writeHead(responseStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x14a34" }));
  }));
  t.after(() => {
    for (const server of servers) { server.closeAllConnections(); server.close(); }
  });
  await Promise.all(servers.map(async server => { server.listen(0, "127.0.0.1"); await once(server, "listening"); }));
  const urls = servers.map(server => `http://127.0.0.1:${server.address().port}`);
  const env = { BASE_SEPOLIA_RPCS: [urls[0], ...urls].join(",") };
  assert.equal(await chainClient({ env }).getChainId(), 84532);
  assert.deepEqual(calls, [0, 1, 2]);
  calls.length = 0;
  healthy = false;
  await assert.rejects(chainClient({ env }).getChainId());
  assert.deepEqual(calls, [0, 1, 2, 3]);
});

test("a single configured RPC is not automatically retried", async t => {
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.writeHead(503); res.end(); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await assert.rejects(chainClient({ env: { BASE_SEPOLIA_RPCS: `http://127.0.0.1:${server.address().port}` } }).getChainId());
  assert.equal(calls, 1);
});

test("audit requires both confirmed payment and matching weather delivery", async () => {
  const record = purchaseRecord();
  const { rpc } = fakeRpc();
  await auditPurchase(record, rpc);
  assert.equal(record.status, "verified");
  assert.equal(record.audit.paymentVerified, true);
  assert.equal(record.audit.deliveryVerified, true);
  assert.equal(record.audit.authorizationEventMatch, true);
  assert.equal(record.audit.settlementPayerMatches, true);
  assert.equal(record.authorizationEvents.length, 1);
  assert.equal(record.authorizationEvents[0].nonce, authorizationNonce);
  assert.equal(record.intervalTransfers.length, 1);
});

for (const [name, mutate, rpcOptions = {}] of [
  ["authorization nonce", () => {}, { authorizationEventNonce: `0x${"00".repeat(32)}` }],
  ["authorization authorizer", () => {}, { authorizationAuthorizer: "0x2222222222222222222222222222222222222222" }],
  ["authorization payer", record => { record.authorization.from = "0x2222222222222222222222222222222222222222"; }],
  ["authorization payee", record => { record.authorization.to = "0x2222222222222222222222222222222222222222"; }],
  ["authorization amount", record => { record.authorization.value = "999"; }],
  ["authorization start time", record => { record.authorization.validAfter = "1001"; }],
  ["authorization end time", record => { record.authorization.validBefore = "999"; }],
  ["settlement payer", record => { record.settlement.payer = "0x2222222222222222222222222222222222222222"; }],
  ["declared network", record => { record.network = "eip155:8453"; }],
  ["declared asset", record => { record.asset = "0x2222222222222222222222222222222222222222"; }],
  ["AuthorizationUsed event", () => {}, { omitAuthorizationEvent: true }],
]) {
  test(`audit rejects a tampered or missing ${name}`, async () => {
    const record = purchaseRecord();
    mutate(record);
    await auditPurchase(record, fakeRpc(rpcOptions).rpc);
    assert.equal(record.status, "audit_failed");
    assert.equal(record.audit.paymentVerified, false);
  });
}

for (const [name, mutate] of [
  ["missing weather", record => { record.response = {}; }],
  ["wrong coordinates", record => { record.response.weather.location.latitude = 0; }],
  ["wrong request ID", record => { record.response.requestId = "another-request"; }],
  ["failed HTTP delivery", record => { record.http[0].status = 502; }],
]) {
  test(`audit does not mark ${name} as a complete purchase`, async () => {
    const record = purchaseRecord();
    mutate(record);
    await auditPurchase(record, fakeRpc().rpc);
    assert.equal(record.status, "paid_delivery_failed");
    assert.equal(record.audit.paymentVerified, true);
    assert.equal(record.audit.deliveryVerified, false);
  });
}

test("historical delivery is validated at its original response time", async () => {
  const record = purchaseRecord();
  const time = "2026-10-16T12:58:30.000Z";
  record.http[0].receivedAt = time;
  for (const field of ["updatedAt", "forecastTime", "retrievedAt"]) record.response.weather[field] = time;
  await auditPurchase(record, fakeRpc().rpc);
  assert.equal(record.status, "verified");
});

test("offsetting unrelated transfers cannot pass a balance-only audit", async () => {
  const other = "0x2222222222222222222222222222222222222222";
  const extraTransfers = [
    { transactionHash: `0x${"cd".repeat(32)}`, blockNumber: 101n, logIndex: 1, args: { from: signer.address, to: other, value: 500n } },
    { transactionHash: `0x${"ef".repeat(32)}`, blockNumber: 101n, logIndex: 2, args: { from: other, to: signer.address, value: 500n } },
  ];
  const record = purchaseRecord();
  await auditPurchase(record, fakeRpc({ extraTransfers }).rpc);
  assert.equal(record.status, "audit_failed");
  assert.equal(record.audit.buyerDelta, "1000");
  assert.equal(record.audit.noOtherTransfers, false);
});

test("initial balance snapshots are checked against the original block", async () => {
  const record = purchaseRecord();
  record.before.buyer = "20000";
  await auditPurchase(record, fakeRpc().rpc);
  assert.equal(record.status, "audit_failed");
  assert.equal(record.audit.initialBalancesMatch, false);
});

test("failed chain receipt cannot pass the audit", async () => {
  const record = purchaseRecord();
  await auditPurchase(record, fakeRpc({ receiptStatus: "reverted" }).rpc);
  assert.equal(record.status, "audit_failed");
  assert.equal(record.audit.chainSuccess, false);
});

test("audit failures cannot preserve a stale verified status", async () => {
  const record = purchaseRecord();
  record.status = "verified";
  record.audit = { paymentVerified: true };
  await assert.rejects(auditPurchase(record, fakeRpc({ logError: new Error("RPC unavailable") }).rpc), /RPC unavailable/);
  assert.equal(record.status, "settled_audit_pending");
  assert.equal(record.audit, undefined);
});

test("wrong-chain RPC is rejected before receipt or balance claims", async () => {
  const { rpc, calls } = fakeRpc({ chainId: 1 });
  await assert.rejects(auditPurchase(purchaseRecord(), rpc), /not Base Sepolia/);
  assert.equal(calls.receipts, 0);
});

test("transfer log queries are paginated within the public RPC limit", async () => {
  const record = purchaseRecord();
  const { rpc, calls } = fakeRpc();
  const receipt = rpc.waitForTransactionReceipt;
  rpc.waitForTransactionReceipt = async () => ({ ...await receipt(), blockNumber: 451n });
  await auditPurchase(record, rpc);
  assert.equal(record.status, "verified");
  assert.equal(calls.logs.length, 6);
  assert.ok(calls.logs.every(query => query.toBlock - query.fromBlock < 150n));
  assert.ok(calls.logs.every(query => query.args.from?.includes(seller) || query.args.to?.includes(seller)));
});
