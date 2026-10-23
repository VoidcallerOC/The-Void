// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactoryV2RoyaltySettled} from "../contracts/VoidReleaseFactoryV2RoyaltySettled.sol";
import {VoidRelease1155V4Royalty} from "../contracts/VoidRelease1155V4Royalty.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {installGenesisStandIn} from "./helpers/MockGenesisCollection.sol";

interface VmClaimSettled {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
}

/// @notice The exact production combination for the Forgive & Forget Single: a clone from
/// VoidReleaseFactoryV2RoyaltySettled (VoidRelease1155V4Royalty), its VoidPrimarySaleSettled, and
/// GenesisHolderClaim, on chain id 43114 with the production schedule (24 h free claim inside a 7-day
/// public sale at 0.25 AVAX, open edition, per-wallet limit 20). The existing claim tests cover the
/// non-settled VoidPrimarySale. Test keys are local cheat-code fixtures only. Nothing here reads or
/// writes a real chain.
contract GenesisHolderClaimSettledSingleTest {
    VmClaimSettled internal constant vm = VmClaimSettled(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xBAD5;
    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    address internal constant CLAIMANT_TWO = address(0xCA12);
    address internal constant COLLECTOR = address(0xC011);
    address internal constant ROGUE = address(0xBAD);
    bytes32 internal constant APP = keccak256("forgive-and-forget-single");
    bytes32 internal constant APP_OTHER = keccak256("unrelated-release");
    bytes32 internal constant EDITION_ID = keccak256("forgive-and-forget");
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant WALLET_LIMIT = 20;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant CLAIM_START = T0 + 1 hours;
    uint256 internal constant CLAIM_END = CLAIM_START + 1 days;
    uint256 internal constant PUBLIC_END = CLAIM_START + 7 days - 1;

    VoidReleaseFactoryV2RoyaltySettled internal factory;
    VoidRelease1155V4Royalty internal release;
    VoidPrimarySaleSettled internal sale;
    GenesisHolderClaim internal claimContract;
    bytes32 internal releaseKey;
    uint256 internal tokenId;

    function setUp() public {
        vm.chainId(43114);
        // GenesisHolderClaim reads Genesis balances on chain id 43114; this suite does not test eligibility.
        installGenesisStandIn(true);
        vm.warp(T0);
        factory = new VoidReleaseFactoryV2RoyaltySettled(NANO);
        releaseKey = keyFor(APP);
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = factory.createRelease(APP, releaseKey, "Forgive & Forget", "FNF", "ipfs://fnf");
        release = VoidRelease1155V4Royalty(releaseAddress);
        sale = VoidPrimarySaleSettled(saleAddress);
        tokenId = newEdition(EDITION_ID);
        configure(tokenId, PRICE, 0, WALLET_LIMIT, CLAIM_START, PUBLIC_END);
        claimContract = deployClaim(tokenId, CLAIM_START, 1 days, 7 days, PRICE);
    }

    // ---- helpers -----------------------------------------------------------------------------

    function keyFor(bytes32 app) internal view returns (bytes32) {
        return keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), app, ARTIST));
    }

    function newEdition(bytes32 editionId) internal returns (uint256 id) {
        vm.prank(ARTIST);
        id = release.createEditionWithMintEnd(releaseKey, editionId, 0, "ipfs://fnf-edition", ARTIST, 250, uint64(PUBLIC_END));
    }

    function configure(uint256 id, uint256 price, uint256 maxSupply, uint256 walletLimit, uint256 start, uint256 end) internal {
        vm.prank(ARTIST);
        sale.configureSale(id, price, maxSupply, walletLimit, uint64(start), uint64(end), false);
    }

    function deployClaim(uint256 id, uint256 start, uint256 claimWindow, uint256 publicWindow, uint256 price)
        internal
        returns (GenesisHolderClaim)
    {
        return new GenesisHolderClaim(address(release), address(sale), id, 0, 0, start, claimWindow, publicWindow, price, ADMIN, vm.addr(SIGNER_KEY));
    }

    function tryDeployClaim(uint256 id, uint256 start, uint256 claimWindow, uint256 publicWindow, uint256 price)
        internal
        returns (bool ok, bytes memory reason)
    {
        try this.deployClaimExternal(id, start, claimWindow, publicWindow, price) {
            ok = true;
        } catch (bytes memory data) {
            reason = data;
        }
    }

    /// External wrapper so a constructor revert can be caught with its revert data.
    function deployClaimExternal(uint256 id, uint256 start, uint256 claimWindow, uint256 publicWindow, uint256 price) external {
        deployClaim(id, start, claimWindow, publicWindow, price);
    }

    function grantIssuer(address to) internal {
        bytes32 role = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(role, to);
    }

    function selectorOf(bytes memory data) internal pure returns (bytes4) {
        require(data.length >= 4, "no revert selector");
        return bytes4(data);
    }

    function voucherFor(GenesisHolderClaim c, address claimant, uint256 nonce) internal view returns (GenesisHolderClaim.ClaimVoucher memory) {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: c.GENESIS_CONTRACT(),
            genesisChainId: c.GENESIS_CHAIN_ID(),
            eligibilityRule: c.ELIGIBILITY_RULE(),
            destinationChainId: 43114,
            releaseContract: c.releaseContract(),
            tokenId: c.tokenId(),
            quantity: 1,
            allocation: c.allocation(),
            nonce: nonce,
            deadline: block.timestamp + 300
        });
    }

    function attempt(GenesisHolderClaim c, address caller, GenesisHolderClaim.ClaimVoucher memory v, uint256 key)
        internal
        returns (bool ok, bytes memory data)
    {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(key, c.voucherDigest(v));
        vm.prank(caller);
        (ok, data) = address(c).call(abi.encodeCall(GenesisHolderClaim.claim, (v, abi.encodePacked(r, s, sv))));
    }

    function claimOk(address claimant, uint256 nonce) internal returns (bool ok) {
        (ok,) = attempt(claimContract, claimant, voucherFor(claimContract, claimant, nonce), SIGNER_KEY);
    }

    function claimFails(address claimant, uint256 nonce, bytes4 expected, string memory why) internal {
        (bool ok, bytes memory data) = attempt(claimContract, claimant, voucherFor(claimContract, claimant, nonce), SIGNER_KEY);
        require(!ok, why);
        require(selectorOf(data) == expected, string.concat(why, ": wrong revert"));
    }

    function buy(address buyer, uint256 qty) internal returns (bool ok) {
        vm.deal(buyer, buyer.balance + PRICE * qty);
        vm.prank(buyer);
        (ok,) = address(sale).call{value: PRICE * qty}(abi.encodeCall(sale.purchase, (tokenId, qty)));
    }

    function saleSold() internal view returns (uint256 sold) {
        (,, sold,,,,,) = sale.sales(tokenId);
    }

    function minted() internal view returns (uint256) {
        return release.edition(tokenId).mintedSupply;
    }

    // ---- exact combination -------------------------------------------------------------------

    /// The Single is the Settled factory's own clone and sale, the claim binds to exactly those, and the
    /// production schedule, price and uncapped open edition are what the claim stored.
    function testBindsToTheSettledFactoryCloneAndItsSale() public {
        require(factory.isRelease(address(release)), "release is not a factory clone");
        require(factory.primarySaleOf(address(release)) == address(sale), "sale is not the clone's sale");
        require(address(sale.releases()) == address(release), "sale is not bound to the release");
        require(sale.platformRecipient() == NANO && sale.PLATFORM_FEE_BPS() == 250, "sale fee wiring");
        require(release.maxSupplyOf(tokenId) == 0, "open edition");
        require(release.hasRole(release.ISSUER_ROLE(), address(sale)), "sale cannot mint on the release");
        require(!release.hasRole(release.ISSUER_ROLE(), ARTIST), "the artist keeps no direct mint authority");
        require(release.hasRole(release.DEFAULT_ADMIN_ROLE(), ARTIST) && release.hasRole(release.ARTIST_ROLE(), ARTIST), "artist roles");
        require(claimContract.releaseContract() == address(release) && claimContract.primarySale() == address(sale), "claim binding");
        require(claimContract.tokenId() == tokenId && claimContract.destinationChainId() == 43114, "claim token and chain");
        require(claimContract.allocation() == 0 && claimContract.publicAllocation() == 0, "uncapped allocations");
        require(claimContract.claimStart() == CLAIM_START && claimContract.claimEnd() == CLAIM_END, "claim window");
        require(claimContract.publicSaleStart() == CLAIM_START && claimContract.publicSaleEnd() == PUBLIC_END, "public window");
        require(claimContract.publicPriceWei() == PRICE, "price");
        require(claimContract.admin() == ADMIN && claimContract.signer() == vm.addr(SIGNER_KEY), "admin and signer");
    }

    // ---- issuer authorization ----------------------------------------------------------------

    function testClaimCannotMintUntilTheArtistGrantsIssuerRole() public {
        vm.warp(CLAIM_START);
        require(!release.hasRole(release.ISSUER_ROLE(), address(claimContract)), "claim starts without ISSUER_ROLE");
        (bool ok,) = attempt(claimContract, CLAIMANT, voucherFor(claimContract, CLAIMANT, 1), SIGNER_KEY);
        require(!ok, "claim minted without ISSUER_ROLE");
        require(!claimContract.hasClaimed(CLAIMANT) && !claimContract.usedNonces(1), "a failed mint left claim state");
        require(claimContract.claimedSupply() == 0 && release.balanceOf(CLAIMANT, tokenId) == 0 && minted() == 0, "state changed");
        grantIssuer(address(claimContract));
        require(claimOk(CLAIMANT, 1), "claim after the grant");
        require(release.balanceOf(CLAIMANT, tokenId) == 1, "minted after the grant");
    }

    function testOnlyTheArtistCanAuthorizeTheClaimAndRevokingItStopsClaimsOnly() public {
        bytes32 role = release.ISSUER_ROLE();
        address[4] memory outsiders = [address(this), NANO, ADMIN, vm.addr(SIGNER_KEY)];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            (bool ok,) = address(release).call(abi.encodeCall(release.grantRole, (role, address(claimContract))));
            require(!ok, "an outsider granted ISSUER_ROLE");
        }
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START);
        require(claimOk(CLAIMANT, 1), "claim");
        vm.prank(ARTIST);
        release.revokeRole(role, address(claimContract));
        require(!claimOk(CLAIMANT_TWO, 2), "claim minted after the artist revoked it");
        require(buy(COLLECTOR, 1), "paid sales must not depend on the claim's role");
        require(release.balanceOf(COLLECTOR, tokenId) == 1 && release.balanceOf(CLAIMANT, tokenId) == 1, "ownership");
    }

    // ---- free mint, duplicates, vouchers -----------------------------------------------------

    function testFreeClaimMintsOneTokenAndTakesNoPayment() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START);
        uint256 claimantBefore = CLAIMANT.balance;
        uint256 saleBefore = address(sale).balance;
        uint256 nanoBefore = NANO.balance;
        require(claimOk(CLAIMANT, 1), "claim");
        require(release.balanceOf(CLAIMANT, tokenId) == 1, "minted to the claimant");
        require(CLAIMANT.balance == claimantBefore, "the claimant paid");
        require(address(sale).balance == saleBefore && NANO.balance == nanoBefore, "a claim moved sale or fee funds");
        require(sale.balances(ARTIST) == 0 && sale.balances(NANO) == 0, "a claim credited sale balances");
        require(saleSold() == 0 && claimContract.claimedSupply() == 1 && minted() == 1, "supply accounting");
        require(claimContract.hasClaimed(CLAIMANT) && claimContract.usedNonces(1), "claim recorded");
    }

    function testDuplicateReplayAndForeignClaimsAreRejected() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory first = voucherFor(claimContract, CLAIMANT, 1);
        (bool ok,) = attempt(claimContract, CLAIMANT, first, SIGNER_KEY);
        require(ok, "first claim");
        (bool replay, bytes memory replayData) = attempt(claimContract, CLAIMANT, first, SIGNER_KEY);
        require(!replay && selectorOf(replayData) == GenesisHolderClaim.AlreadyClaimed.selector, "replay by the same wallet");
        claimFails(CLAIMANT, 2, GenesisHolderClaim.AlreadyClaimed.selector, "second voucher for the same wallet");
        (bool stolen, bytes memory stolenData) = attempt(claimContract, COLLECTOR, first, SIGNER_KEY);
        require(!stolen && selectorOf(stolenData) == GenesisHolderClaim.InvalidVoucher.selector, "another wallet used the voucher");
        // The nonce is spent even for a different wallet.
        claimFails(CLAIMANT_TWO, 1, GenesisHolderClaim.Replay.selector, "spent nonce");
        require(release.balanceOf(CLAIMANT, tokenId) == 1 && minted() == 1 && claimContract.claimedSupply() == 1, "exactly one mint");
    }

    function testBadVouchersAreRejected() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory v = voucherFor(claimContract, CLAIMANT, 1);
        (bool ok, bytes memory data) = attempt(claimContract, CLAIMANT, v, OTHER_KEY);
        require(!ok && selectorOf(data) == GenesisHolderClaim.InvalidSignature.selector, "signature from another key");
        v = voucherFor(claimContract, CLAIMANT, 2);
        v.deadline = block.timestamp - 1;
        (ok, data) = attempt(claimContract, CLAIMANT, v, SIGNER_KEY);
        require(!ok && selectorOf(data) == GenesisHolderClaim.ExpiredVoucher.selector, "expired voucher");
        v = voucherFor(claimContract, CLAIMANT, 3);
        v.tokenId = tokenId + 1;
        (ok, data) = attempt(claimContract, CLAIMANT, v, SIGNER_KEY);
        require(!ok && selectorOf(data) == GenesisHolderClaim.InvalidVoucher.selector, "voucher for another token");
        v = voucherFor(claimContract, CLAIMANT, 4);
        v.releaseContract = address(sale);
        (ok, data) = attempt(claimContract, CLAIMANT, v, SIGNER_KEY);
        require(!ok && selectorOf(data) == GenesisHolderClaim.InvalidVoucher.selector, "voucher for another release");
        v = voucherFor(claimContract, CLAIMANT, 5);
        v.genesisContract = address(release);
        (ok, data) = attempt(claimContract, CLAIMANT, v, SIGNER_KEY);
        require(!ok && selectorOf(data) == GenesisHolderClaim.InvalidVoucher.selector, "voucher naming another collection");
        v = voucherFor(claimContract, CLAIMANT, 6);
        v.quantity = 0;
        (ok, data) = attempt(claimContract, CLAIMANT, v, SIGNER_KEY);
        require(!ok && selectorOf(data) == GenesisHolderClaim.InvalidVoucher.selector, "zero quantity");
        require(minted() == 0 && claimContract.claimedSupply() == 0, "a bad voucher minted");
    }

    // ---- schedule ----------------------------------------------------------------------------

    function testClaimWindowBoundaries() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START - 1);
        claimFails(CLAIMANT, 1, GenesisHolderClaim.ClaimNotOpen.selector, "claim before the start");
        vm.warp(CLAIM_START);
        require(claimOk(CLAIMANT, 1), "claim at the start");
        vm.warp(CLAIM_END - 1);
        require(claimOk(CLAIMANT_TWO, 2), "claim in the last second");
        vm.warp(CLAIM_END);
        claimFails(COLLECTOR, 3, GenesisHolderClaim.ClaimWindowClosed.selector, "claim at the end");
        vm.warp(PUBLIC_END);
        claimFails(COLLECTOR, 3, GenesisHolderClaim.ClaimWindowClosed.selector, "claim during the public tail");
        require(minted() == 2 && claimContract.claimedSupply() == 2, "only in-window claims minted");
    }

    function testPublicSaleOpensWithTheClaimsAndClosesExactlySevenDaysLater() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START - 1);
        require(!buy(COLLECTOR, 1), "paid mint before the sale opens");
        vm.warp(CLAIM_START);
        require(buy(COLLECTOR, 1), "paid mint at the claim start");
        vm.warp(CLAIM_END + 1 days);
        require(buy(COLLECTOR, 1), "paid mint after the claims close");
        vm.warp(PUBLIC_END);
        require(buy(COLLECTOR, 1), "paid mint in the last second");
        vm.warp(PUBLIC_END + 1);
        require(!buy(COLLECTOR, 1), "paid mint after seven days");
        require(release.balanceOf(COLLECTOR, tokenId) == 3 && saleSold() == 3 && minted() == 3, "three paid mints");
    }

    // ---- interaction with paid sales ---------------------------------------------------------

    function testPaidSaleFeeRoutingIsUnaffectedByClaims() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START);
        require(claimOk(CLAIMANT, 1), "claim");
        uint256 nanoBefore = NANO.balance;
        require(buy(COLLECTOR, 2), "paid mint");
        require(NANO.balance == nanoBefore + 0.0125 ether, "2.5% pushed to the platform recipient in the purchase");
        require(sale.balances(ARTIST) == 0.4875 ether && sale.balances(NANO) == 0, "97.5% credited to the artist payout, none to the Nano balance");
        require(address(sale).balance == 0.4875 ether, "the sale holds only the artist share");
        uint256 artistBefore = ARTIST.balance;
        vm.prank(ARTIST);
        sale.withdraw();
        require(ARTIST.balance == artistBefore + 0.4875 ether && address(sale).balance == 0, "artist withdraws exactly the 97.5%");
        require(saleSold() == 2 && claimContract.claimedSupply() == 1 && minted() == 3, "sold, claimed and minted add up");
    }

    function testClaimsAndPurchasesInterleaveWithConsistentAccounting() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START);
        require(buy(COLLECTOR, 1), "purchase first");
        require(claimOk(CLAIMANT, 1), "claim after a purchase");
        require(buy(CLAIMANT, 1), "a claimant may also buy");
        require(claimOk(CLAIMANT_TWO, 2), "claim after more purchases");
        require(saleSold() == 2 && claimContract.claimedSupply() == 2 && minted() == 4, "accounting");
        require(release.balanceOf(CLAIMANT, tokenId) == 2 && release.balanceOf(CLAIMANT_TWO, tokenId) == 1, "balances");
    }

    function testPerWalletLimitCountsOnlyPaidPurchases() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START);
        require(claimOk(CLAIMANT, 1), "claim");
        require(sale.walletPurchased(tokenId, CLAIMANT) == 0, "a claim counted as a purchase");
        require(buy(CLAIMANT, WALLET_LIMIT), "twenty paid copies on top of the claim");
        require(!buy(CLAIMANT, 1), "the 21st paid copy");
        require(release.balanceOf(CLAIMANT, tokenId) == WALLET_LIMIT + 1, "claim plus limit");
    }

    /// Deploying the claim against an edition that already sold copies publicly: claim accounting starts
    /// from the sale's own sold count.
    function testClaimDeployedAfterPublicSalesStillAccountsCorrectly() public {
        uint256 id = newEdition(keccak256("already-published"));
        configure(id, PRICE, 0, WALLET_LIMIT, CLAIM_START, PUBLIC_END);
        vm.warp(CLAIM_START);
        vm.deal(COLLECTOR, 3 * PRICE);
        vm.prank(COLLECTOR);
        sale.purchase{value: 3 * PRICE}(id, 3);
        // The constructor needs claimStart >= now, so this claim's window starts at the current time.
        GenesisHolderClaim late = deployClaim(id, CLAIM_START, 1 days, 7 days, PRICE);
        grantIssuer(address(late));
        GenesisHolderClaim.ClaimVoucher memory v = voucherFor(late, CLAIMANT, 1);
        (bool ok,) = attempt(late, CLAIMANT, v, SIGNER_KEY);
        require(ok, "claim after earlier paid sales");
        require(release.balanceOf(CLAIMANT, id) == 1 && release.edition(id).mintedSupply == 4 && late.claimedSupply() == 1, "accounting");
    }

    // ---- fail-closed drift and mismatches ----------------------------------------------------

    function testClaimFailsClosedWhenTheSaleDriftsAndRecoversWhenRestored() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START);
        configure(tokenId, PRICE + 1, 0, WALLET_LIMIT, CLAIM_START, PUBLIC_END);
        claimFails(CLAIMANT, 1, GenesisHolderClaim.PublicPriceChanged.selector, "price drift");
        configure(tokenId, PRICE, 0, WALLET_LIMIT, CLAIM_START, PUBLIC_END + 1);
        claimFails(CLAIMANT, 1, GenesisHolderClaim.PublicSaleSchedule.selector, "end drift");
        configure(tokenId, PRICE, 0, WALLET_LIMIT, CLAIM_START + 1, PUBLIC_END);
        claimFails(CLAIMANT, 1, GenesisHolderClaim.PublicSaleSchedule.selector, "start drift");
        configure(tokenId, PRICE, 5, 5, CLAIM_START, PUBLIC_END);
        claimFails(CLAIMANT, 1, GenesisHolderClaim.PublicAllocationChanged.selector, "cap drift");
        require(minted() == 0, "a drifted claim minted");
        configure(tokenId, PRICE, 0, WALLET_LIMIT, CLAIM_START, PUBLIC_END);
        require(claimOk(CLAIMANT, 1), "claim once the sale is restored");
    }

    function testClaimFailsClosedWhenAnotherIssuerMintsOutsideTheSale() public {
        grantIssuer(address(claimContract));
        grantIssuer(ROGUE);
        vm.warp(CLAIM_START);
        vm.prank(ROGUE);
        release.mint(COLLECTOR, tokenId, 1, "");
        (bool ok, bytes memory data) = attempt(claimContract, CLAIMANT, voucherFor(claimContract, CLAIMANT, 1), SIGNER_KEY);
        require(!ok && selectorOf(data) == GenesisHolderClaim.SupplyAccountingMismatch.selector, "claim ignored an outside mint");
    }

    function testDeploymentRefusesAnIncompatibleSaleOrEdition() public {
        // Sale not configured at all.
        uint256 bare = newEdition(keccak256("no-sale"));
        (bool ok, bytes memory reason) = tryDeployClaim(bare, CLAIM_START, 1 days, 7 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.PublicAllocationChanged.selector, "unconfigured sale");
        // Wrong price, start, end and cap.
        configure(bare, 0.2 ether, 0, 0, CLAIM_START, PUBLIC_END);
        (ok, reason) = tryDeployClaim(bare, CLAIM_START, 1 days, 7 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.PublicPriceChanged.selector, "wrong price");
        configure(bare, PRICE, 0, 0, CLAIM_START + 1, PUBLIC_END);
        (ok, reason) = tryDeployClaim(bare, CLAIM_START, 1 days, 7 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.PublicSaleSchedule.selector, "wrong start");
        configure(bare, PRICE, 0, 0, CLAIM_START, PUBLIC_END - 1);
        (ok, reason) = tryDeployClaim(bare, CLAIM_START, 1 days, 7 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.PublicSaleSchedule.selector, "wrong end");
        configure(bare, PRICE, 10, 0, CLAIM_START, PUBLIC_END);
        (ok, reason) = tryDeployClaim(bare, CLAIM_START, 1 days, 7 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.PublicAllocationChanged.selector, "capped sale");
        // A token that does not exist on the release.
        (ok,) = tryDeployClaim(uint256(keccak256("missing")), CLAIM_START, 1 days, 7 days, PRICE);
        require(!ok, "claim bound to a token that does not exist");
        // An edition that already has a mint outside the sale.
        uint256 minted1 = newEdition(keccak256("outside-mint"));
        configure(minted1, PRICE, 0, 0, CLAIM_START, PUBLIC_END);
        grantIssuer(ROGUE);
        vm.prank(ROGUE);
        release.mint(COLLECTOR, minted1, 1, "");
        (ok, reason) = tryDeployClaim(minted1, CLAIM_START, 1 days, 7 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.SupplyAccountingMismatch.selector, "mint outside the sale");
    }

    function testProductionScheduleAndPriceAreEnforced() public {
        (bool ok, bytes memory reason) = tryDeployClaim(tokenId, CLAIM_START, 12 hours, 7 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.InvalidConfiguration.selector, "12 hour claim window");
        (ok, reason) = tryDeployClaim(tokenId, CLAIM_START, 1 days, 3 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.InvalidConfiguration.selector, "3 day public window");
        (ok, reason) = tryDeployClaim(tokenId, CLAIM_START, 1 days, 7 days, 0.1 ether);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.InvalidConfiguration.selector, "price other than 0.25 AVAX");
        (ok, reason) = tryDeployClaim(tokenId, T0 - 1, 1 days, 7 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.InvalidConfiguration.selector, "claim start in the past");
        vm.chainId(1);
        (ok, reason) = tryDeployClaim(tokenId, CLAIM_START, 1 days, 7 days, PRICE);
        require(!ok && selectorOf(reason) == GenesisHolderClaim.InvalidConfiguration.selector, "another chain");
    }

    // ---- pause and unrelated releases --------------------------------------------------------

    function testAdminPauseStopsClaimsButNotPaidSales() public {
        grantIssuer(address(claimContract));
        vm.warp(CLAIM_START);
        vm.prank(ARTIST);
        (bool denied,) = address(claimContract).call(abi.encodeCall(GenesisHolderClaim.pause, ()));
        require(!denied, "the artist is not the claim admin in this fixture");
        vm.prank(ADMIN);
        claimContract.pause();
        claimFails(CLAIMANT, 1, GenesisHolderClaim.Paused.selector, "claim while paused");
        require(buy(COLLECTOR, 1), "paid sale while claims are paused");
        vm.prank(ADMIN);
        claimContract.unpause();
        require(claimOk(CLAIMANT, 1), "claim after unpause");
    }

    function testClaimHasNoAuthorityOverAnUnrelatedFactoryRelease() public {
        grantIssuer(address(claimContract));
        bytes32 otherKey = keyFor(APP_OTHER);
        vm.prank(ARTIST);
        (address otherReleaseAddress, address otherSaleAddress,) = factory.createRelease(APP_OTHER, otherKey, "Other", "OTH", "ipfs://other");
        VoidRelease1155V4Royalty other = VoidRelease1155V4Royalty(otherReleaseAddress);
        require(!other.hasRole(other.ISSUER_ROLE(), address(claimContract)), "claim holds a role on an unrelated release");
        vm.prank(address(claimContract));
        (bool ok,) = otherReleaseAddress.call(abi.encodeCall(other.mint, (CLAIMANT, 1, 1, "")));
        require(!ok, "claim minted on an unrelated release");
        // A voucher naming the other release is refused before any mint.
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory v = voucherFor(claimContract, CLAIMANT, 1);
        v.releaseContract = otherReleaseAddress;
        (bool claimed, bytes memory data) = attempt(claimContract, CLAIMANT, v, SIGNER_KEY);
        require(!claimed && selectorOf(data) == GenesisHolderClaim.InvalidVoucher.selector, "voucher for an unrelated release");
        require(otherSaleAddress != address(sale), "distinct sales");
        require(minted() == 0 && claimContract.claimedSupply() == 0, "unrelated activity touched the Single");
    }
}
