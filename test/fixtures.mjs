import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { NETWORK, USDC } from "../src/app.mjs";
import { tokenAbi } from "../scripts/chain.mjs";

export const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
export const seller = "0x303782B1b788527bE6cC28C6F16aA2A3Ba26b59f";
export const transaction = `0x${"ab".repeat(32)}`;
export const authorizationNonce = `0x${"ac".repeat(32)}`;
export const location = { latitude: 31.2304, longitude: 121.4737 };

export function weather() {
  const time = new Date().toISOString();
  return {
    location: { ...location }, provider: "MET Norway", dataType: "model_forecast_nearest_time_not_station_observation",
    attribution: "Weather data from MET Norway, CC BY 4.0", license: "https://creativecommons.org/licenses/by/4.0/",
    source: "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=31.2304&lon=121.4737",
    updatedAt: time, forecastTime: time, retrievedAt: time,
    temperature: { value: 18, unit: "celsius" }, relativeHumidity: { value: 50, unit: "%" }, windSpeed: { value: 2, unit: "m/s" }, summary: null,
  };
}

export function purchaseRecord() {
  const time = new Date().toISOString();
  return {
    at: time, buyer: signer.address, seller, location: { ...location }, network: NETWORK, asset: USDC,
    before: { block: "100", buyer: "10000", seller: "0" },
    authorization: { from: signer.address, to: seller, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: authorizationNonce },
    settlement: { success: true, transaction, network: NETWORK, payer: signer.address },
    http: [{ paid: true, status: 200, receivedAt: time, headers: { "x-request-id": "request-test" } }],
    response: { requestId: "request-test", weather: weather() },
  };
}

export function fakeRpc({ chainId = 84532, buyerBalance = 10000n, receiptStatus = "success", extraTransfers = [], receiptError, logError, authorizationAuthorizer = signer.address, authorizationEventNonce = authorizationNonce, omitAuthorizationEvent = false } = {}) {
  const transfer = { transactionHash: transaction, blockNumber: 102n, logIndex: 0, args: { from: signer.address, to: seller, value: 1000n } };
  const calls = { logs: [], receipts: 0 };
  const rpc = {
    getChainId: async () => chainId,
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ timestamp: 1000n }),
    readContract: async ({ args: [address], blockNumber }) => address.toLowerCase() === signer.address.toLowerCase() ? buyerBalance - (blockNumber > 100n ? 1000n : 0n) : blockNumber > 100n ? 1000n : 0n,
    waitForTransactionReceipt: async () => {
      calls.receipts++;
      if (receiptError) throw receiptError;
      const logs = [{ address: USDC, topics: encodeEventTopics({ abi: tokenAbi, eventName: "Transfer", args: transfer.args }), data: encodeAbiParameters([{ type: "uint256" }], [1000n]) }];
      const eventNonce = typeof authorizationEventNonce === "function" ? authorizationEventNonce() : authorizationEventNonce;
      if (!omitAuthorizationEvent) logs.push({ address: USDC, topics: encodeEventTopics({ abi: tokenAbi, eventName: "AuthorizationUsed", args: { authorizer: authorizationAuthorizer, nonce: eventNonce } }), data: "0x" });
      return { transactionHash: transaction, blockNumber: 102n, status: receiptStatus, logs };
    },
    getLogs: async options => {
      calls.logs.push(options);
      if (logError) throw logError;
      return [transfer, ...extraTransfers].filter(log => log.blockNumber >= options.fromBlock && log.blockNumber <= options.toBlock && Object.entries(options.args).every(([key, addresses]) => addresses.some(address => address.toLowerCase() === log.args[key].toLowerCase())));
    },
  };
  return { rpc, calls };
}
