import { getAddress } from "ethers";
import { MAINNET_ARTIST_WALLET } from "./mainnet-signing-requests.mjs";

// The Fuji Genesis claim deployment, signed by the owner in Rabby from the same page and machinery as
// the probe test. Fuji only: this kind can never bind, predict or sign a mainnet transaction.
export const FUJI_CLAIM_KIND = "genesis-claim-fuji";
export const FUJI_CLAIM_ARTIST = getAddress(MAINNET_ARTIST_WALLET);
// The dedicated Genesis voucher signer: a public address only. The server holds the matching signing
// secret (GENESIS_CLAIM_SIGNER_*) and signs vouchers with it; this repo never holds a secret.
// It is a dedicated key, never the deployer, the artist/claim admin or the fee recipient.
export const FUJI_GENESIS_VOUCHER_SIGNER = getAddress("0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47");
// The old dead-address placeholder. Nobody holds a signing secret for it, so it can never sign a valid voucher; it is
// refused as a signer everywhere (plan validator, server configuration).
export const FORBIDDEN_PLACEHOLDER_SIGNER = getAddress("0x000000000000000000000000000000000000dEaD");
// Fuji test schedule from FORGIVE-FORGET-GENESIS-CLAIM.md: 5-minute Genesis claim, 10-minute public sale.
export const FUJI_CLAIM_WINDOW_SECONDS = 300;
export const FUJI_PUBLIC_WINDOW_SECONDS = 600;
export const FUJI_PUBLIC_PRICE_WEI = "10000000000000000"; // 0.01 AVAX, release -28's existing test price
