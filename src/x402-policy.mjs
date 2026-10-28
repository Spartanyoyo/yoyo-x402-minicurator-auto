import { NETWORK, PRICE_ATOMIC, USDC } from "./app.mjs";

export function isSafePaymentRequirement(requirement, seller) {
  return requirement?.network === NETWORK &&
    requirement.scheme === "exact" &&
    requirement.asset?.toLowerCase() === USDC.toLowerCase() &&
    typeof seller === "string" && seller.length > 0 &&
    requirement.payTo?.toLowerCase() === seller.toLowerCase() &&
    requirement.amount === PRICE_ATOMIC &&
    Number.isInteger(requirement.maxTimeoutSeconds) &&
    requirement.maxTimeoutSeconds > 0 &&
    requirement.maxTimeoutSeconds <= 300 &&
    requirement.extra?.name === "USDC" &&
    requirement.extra?.version === "2" &&
    (requirement.extra?.paymentFlow == null || requirement.extra.paymentFlow === "authorization") &&
    (requirement.extra?.assetTransferMethod == null || requirement.extra.assetTransferMethod === "eip3009");
}
