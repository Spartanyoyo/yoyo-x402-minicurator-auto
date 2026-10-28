import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { checkRpcEndpoint } from "../scripts/rpc-health.mjs";

test("RPC health records a working chain and an unavailable endpoint independently", async t => {
  let goodCalls = 0;
  let badCalls = 0;
  const good = createServer(async (req, res) => {
    goodCalls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const result = request.method === "eth_chainId" ? "0x14a34" : request.method === "eth_blockNumber" ? "0x2e4f00" : null;
    assert.ok(result, `unexpected method ${request.method}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  const bad = createServer((_req, res) => {
    badCalls++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(() => {
    good.closeAllConnections();
    bad.closeAllConnections();
    good.close();
    bad.close();
  });
  good.listen(0, "127.0.0.1");
  bad.listen(0, "127.0.0.1");
  await Promise.all([once(good, "listening"), once(bad, "listening")]);

  const goodResult = await checkRpcEndpoint(`http://127.0.0.1:${good.address().port}`);
  const badResult = await checkRpcEndpoint(`http://127.0.0.1:${bad.address().port}`);
  assert.deepEqual({ ok: goodResult.ok, chainId: goodResult.chainId, blockNumber: goodResult.blockNumber }, { ok: true, chainId: 84532, blockNumber: "3034880" });
  assert.equal(goodCalls, 2);
  assert.equal(badResult.ok, false);
  assert.equal(badCalls, 1);
  assert.ok(badResult.error.message);
});