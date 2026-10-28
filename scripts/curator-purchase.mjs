import { purchaseDocumentedResource } from "./purchase.mjs";
import { SERVICES, serviceParameters, validateCatalog } from "../src/curator-catalog.mjs";

export function validateCuratorDelivery(response, record, now) {
  if (!response?.resource?.cache) throw new Error("Museum delivery is missing cache metadata");
  return validateCatalog(response.resource, record.resourceService, record.parameters, now);
}

export async function purchaseCurator({ service, parameters = {}, maxAmountAtomic = "1000", ...options }) {
  const query = serviceParameters(service, parameters);
  if (!/^\d+$/.test(String(maxAmountAtomic)) || BigInt(maxAmountAtomic) < 1000n) throw new Error("Purchase budget must cover exactly 1000 test-USDC atomic units");
  const definition = SERVICES[service];
  return purchaseDocumentedResource({ ...options, documentPath: definition.documentationPath, targetPath: definition.path, parameters: query, recordFields: { resourceService: service, parameters: query, budgetAtomic: String(maxAmountAtomic) }, documentMarkers: [service, definition.path, '"priceAtomic": "1000"'], validateDelivery: validateCuratorDelivery });
}
