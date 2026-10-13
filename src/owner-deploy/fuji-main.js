import { startPage } from "./page.js";

// The Fuji Rabby test page: only the Fuji test plans are bundled here, never a mainnet plan.
startPage("fuji", import.meta.glob("../../deploy/fuji/approved-plans/*.json", { eager: true }));
