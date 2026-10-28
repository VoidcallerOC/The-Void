export const BRIDGE_CONFIG = Object.freeze({
  cChain: {
    id: 43114,
    hexId: "0xa86a",
    name: "Avalanche C-Chain",
    short: "C-CHAIN",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  },
  grotto: {
    id: 36463,
    hexId: "0x8e6f",
    name: "The Grotto",
    short: "GROTTO",
    rpc: "https://subnets.avax.network/thegrotto/mainnet/rpc",
    nativeCurrency: { name: "HERESY", symbol: "HERESY", decimals: 18 },
  },
  relic: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE",
  sourceBridge: "0x68539f95FB2758327A9C7EdEDa1002b0F3Ec8992",
  remoteBridge: "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa",
  teleporter: "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf",
  relayer: "0x9c1d2140bad125bacf4a0dff1efa94265056988e",
});
