import { startPage } from "./page.js";

// The mainnet owner deployment page: only the mainnet approved plans are bundled here.
startPage("mainnet", import.meta.glob("../../deploy/mainnet/approved-plans/*.json", { eager: true }));
