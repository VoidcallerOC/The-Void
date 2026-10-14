import { ethers } from "ethers";
import { releaseDeploymentForFactory } from "../../config/release-network.js";

const saleIface = new ethers.Interface(["function releases() view returns (address)"]);
const factoryIface = new ethers.Interface(["function primarySaleOf(address release) view returns (address)"]);

function checksum(value) {
  const text = String(value || "").trim();
  if (!ethers.isAddress(text) || ethers.getAddress(text) === ethers.ZeroAddress) return "";
  return ethers.getAddress(text);
}

/**
 * The persisted release -> clone -> dedicated sale -> factory binding for one published
 * edition. The edition row's own sale wins; otherwise the release's binding row is used
 * only when it names the same release, chain and clone. Anything missing, ambiguous or
 * mismatched resolves to null so Studio stays blocked.
 */
export function resolveCatalogSaleBinding(catalog, { releaseId, edition, chainId } = {}) {
  const release = checksum(edition?.releaseContractAddress || edition?.contractAddress);
  const editionChain = Number(edition?.chainId);
  if (!releaseId || !release || (chainId != null && editionChain !== Number(chainId))) return null;
  const matches = (catalog?.releaseBindings || []).filter((binding) => binding.releaseId === releaseId && Number(binding.chainId) === editionChain && checksum(binding.releaseContractAddress) === release && checksum(binding.primarySaleAddress));
  const sales = new Set(matches.map((binding) => checksum(binding.primarySaleAddress)));
  const edition_sale = checksum(edition?.primarySaleAddress);
  if (edition_sale) sales.add(edition_sale);
  if (sales.size !== 1) return null;
  const [primarySaleAddress] = sales;
  const factoryAddress = checksum(edition?.factoryAddress) || checksum(matches.find((binding) => checksum(binding.factoryAddress))?.factoryAddress);
  return { chainId: editionChain, releaseContractAddress: release, primarySaleAddress, factoryAddress };
}

/**
 * Read-only chain check of a resolved binding: the factory is a recorded release-per-contract
 * deployment on this chain, it reports exactly this sale for the clone, and the sale reports
 * exactly this clone. Throws on any mismatch; nothing is sent.
 */
export async function verifyReleaseSaleBinding(provider, binding) {
  const release = checksum(binding?.releaseContractAddress);
  const sale = checksum(binding?.primarySaleAddress);
  const factory = checksum(binding?.factoryAddress);
  if (!release || !sale || !factory) throw new Error("The release, its dedicated sale and its Factory must all be recorded before a sale can be configured.");
  const deployment = releaseDeploymentForFactory(factory);
  if (!deployment || Number(deployment.chainId) !== Number(binding.chainId)) throw new Error("The release's Factory is not a recorded deployment on this chain.");
  const call = async (to, iface, name, args) => iface.decodeFunctionResult(name, await provider.request({ method: "eth_call", params: [{ to, data: iface.encodeFunctionData(name, args) }, "latest"] }))[0];
  const [factorySale, saleRelease] = await Promise.all([call(factory, factoryIface, "primarySaleOf", [release]), call(sale, saleIface, "releases", [])]);
  if (checksum(factorySale) !== sale) throw new Error("The Factory does not report this sale for the release.");
  if (checksum(saleRelease) !== release) throw new Error("The sale contract does not belong to this release.");
  return { ...binding, releaseContractAddress: release, primarySaleAddress: sale, factoryAddress: factory };
}
