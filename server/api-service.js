import { randomUUID } from "node:crypto";
import { ApiError } from "./api-errors.js";
import { assertWalletMatches, requireWalletAuth } from "./api-runtime.js";
import { checkDatabaseHealth } from "./db.js";
import { reportIndexedContracts } from "./indexer-contracts.js";
import { chainId, nonNegativeBigInt, positiveBigInt, requiredText, walletAddress } from "./validation.js";
import { isHiddenPublicArtist } from "../src/lib/summit-demo.js";
import { ARTIST_SELECT } from "./artist-verified-select.js";

const PUBLIC_STATUS = "PUBLISHED";
const ACTIVE_LISTING = "ACTIVE";
const TERMINAL_TRANSACTION_STATES = new Set(["FAILED", "FINALIZED", "RECONCILED", "REORGED"]);
