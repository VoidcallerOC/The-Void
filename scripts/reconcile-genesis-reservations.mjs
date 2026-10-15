import process from "node:process";
import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { createDatabasePool } from "../server/db.js";
import { createGenesisClaimReservationStore } from "../server/genesis-claim-store.js";
import { reconcileGenesisReservations } from "../server/genesis-claim.js";

// Settles stored Genesis claim reservations from the claim contract's hasClaimed. Read-only unless
// --apply is passed; the default run prints the transitions it would make.
//   DATABASE_URL, GENESIS_DESTINATION_RPC_URL, GENESIS_CLAIM_CONTRACT   (no signer key is needed)
const apply = process.argv.includes("--apply");
const claimContract = getAddress(process.env.GENESIS_CLAIM_CONTRACT);
const provider = new JsonRpcProvider(process.env.GENESIS_DESTINATION_RPC_URL);
const claim = new Contract(claimContract, ["function hasClaimed(address) view returns (bool)"], provider);
const pool = createDatabasePool();
try {
  const result = await reconcileGenesisReservations({
    store: createGenesisClaimReservationStore(pool),
    claimContract,
    readAlreadyClaimed: (wallet) => claim.hasClaimed(wallet),
    destinationNow: async () => (await provider.getBlock("latest")).timestamp,
    apply,
  });
  console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY_RUN", ...result }, null, 2));
} finally {
  await pool.end();
}
