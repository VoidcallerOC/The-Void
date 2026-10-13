import { getAddress } from "ethers";
import { MAINNET_ARTIST_WALLET } from "./mainnet-signing-requests.mjs";

// The Fuji Genesis claim deployment, signed by the owner in Rabby from the same page and machinery as
// the probe test. Fuji only: this kind can never bind, predict or sign a mainnet transaction.
export const FUJI_CLAIM_KIND = "genesis-claim-fuji";
export const FUJI_CLAIM_ARTIST = getAddress(MAINNET_ARTIST_WALLET);
// The voucher signer of a Fuji claim deployed before the real signer is chosen. No signing key for this
// address is held by anyone, so no signature can recover to it: claim() reverts with InvalidSignature
// for every voucher until the claim admin (the artist) rotates the signer with setSigner. This is the
// well-known dead address, never an account of the owner, the artist or the platform.
export const FUJI_PLACEHOLDER_SIGNER = getAddress("0x000000000000000000000000000000000000dEaD");
// Fuji test schedule from FORGIVE-FORGET-GENESIS-CLAIM.md: 5-minute Genesis claim, 10-minute public sale.
export const FUJI_CLAIM_WINDOW_SECONDS = 300;
export const FUJI_PUBLIC_WINDOW_SECONDS = 600;
export const FUJI_PUBLIC_PRICE_WEI = "10000000000000000"; // 0.01 AVAX, release -28's existing test price
