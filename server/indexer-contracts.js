function normalizeContract(item) {
  return {
    address: String(item?.address || item?.contractAddress || "").toLowerCase(),
    contractType: String(item?.type || item?.contract_type || item?.contractType || "").toUpperCase(),
    status: item?.status ? String(item.status).toUpperCase() : null,
  };
}

function section(contractType, indexedItems, configuredItems) {
  const seen = indexedItems.filter((item) => item.contractType === contractType);
  const expected = configuredItems.filter((item) => item.contractType === contractType);
  const addresses = [...new Set([...expected.map((item) => item.address), ...seen.map((item) => item.address)])];
  const healthy = addresses.length > 0 && addresses.every((address) => seen.some((item) => item.address === address && (item.status === "IDLE" || item.status === "RUNNING")));
  return { contractType, configured: addresses.length > 0, healthy, address: addresses[0] || null, addresses, indexed: seen };
}

export function reportIndexedContracts({ indexed = [], configured = [] } = {}) {
  const valid = (item) => /^0x[0-9a-f]{40}$/.test(item.address);
  const indexedItems = indexed.map(normalizeContract).filter(valid);
  const configuredItems = configured.map(normalizeContract).filter(valid);
  const release = section("ERC1155", indexedItems, configuredItems);
  const primarySale = section("PRIMARY_SALE", indexedItems, configuredItems);
  return { release, primarySale, ok: release.healthy && primarySale.healthy };
}
