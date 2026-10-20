// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegacyCollectionMarketplace} from "../contracts/LegacyCollectionMarketplace.sol";
import {MockGenesis, RejectsAvax, ReentrantReceiver, VmLegacy} from "./LegacyCollectionMarketplace.t.sol";

/// @notice Seller-proceeds protection: a purchase must leave the seller at least `minSellerProceedsPerUnit * quantity`
/// wei of net proceeds after the 2.5% fee and the collection's live ERC-2981 royalty, or the whole purchase reverts.
contract LegacyCollectionMarketplaceMinProceedsTest {
    VmLegacy internal constant vm = VmLegacy(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant FEE = address(0xFEE5);
    address internal constant OWNER = address(0x0A11);
    address internal constant CREATOR = address(0xC4EA);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant SELLER = address(0x5E11);
    address internal constant BUYER = address(0xB0B);
    address internal constant STRANGER = address(0x5757);
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant EXPECTED = 0.925 ether; // 1 - 2.5% fee - 5% royalty

    LegacyCollectionMarketplace internal market;
    MockGenesis internal genesis;

    function setUp() public {
        market = new LegacyCollectionMarketplace(FEE, 250, OWNER);
        genesis = new MockGenesis(CREATOR);
        vm.prank(OWNER);
        market.allowCollection(address(genesis), 1000, 0, 3);
        genesis.mint(SELLER, 0, 10);
        vm.deal(BUYER, 100 ether);
        vm.prank(SELLER);
        genesis.setApprovalForAll(address(market), true);
    }

    function listProtected(uint256 amount, uint256 price, uint256 minPerUnit) internal returns (uint256) {
        vm.prank(SELLER);
        return market.createListingWithMinProceeds(address(genesis), SELLER, 0, amount, price, 0, minPerUnit);
    }

    function buyCall(uint256 id, uint256 quantity, uint256 value) internal returns (bool ok, bytes memory ret) {
        vm.prank(BUYER);
        return address(market).call{value: value}(abi.encodeCall(market.buy, (id, quantity)));
    }

    function selector(bytes memory ret) internal pure returns (bytes4 s) { assembly { s := mload(add(ret, 32)) } }

    struct Snapshot { uint256 buyerAvax; uint256 sellerAvax; uint256 feeAvax; uint256 creatorAvax; uint256 marketAvax; uint256 buyerTokens; uint256 sellerTokens; uint256 remaining; uint8 status; }
    function snap(uint256 id) internal view returns (Snapshot memory s) {
        LegacyCollectionMarketplace.Listing memory l = market.getListing(id);
        s = Snapshot(BUYER.balance, SELLER.balance, FEE.balance, CREATOR.balance, address(market).balance, genesis.balanceOf(BUYER, 0), genesis.balanceOf(SELLER, 0), l.amount, uint8(l.status));
    }
    function sameSnap(Snapshot memory a, Snapshot memory b) internal pure returns (bool) {
        return a.buyerAvax == b.buyerAvax && a.sellerAvax == b.sellerAvax && a.feeAvax == b.feeAvax && a.creatorAvax == b.creatorAvax && a.marketAvax == b.marketAvax
            && a.buyerTokens == b.buyerTokens && a.sellerTokens == b.sellerTokens && a.remaining == b.remaining && a.status == b.status;
    }

    // ---------------------------------------------------------------- interface compatibility

    function testV4ShapedSelectorsAndEventsAreUnchanged() public pure {
        // These are the values the frontend (src/lib/marketplace.js) and the indexer (server/marketplace-events.js) hardcode or derive.
        require(LegacyCollectionMarketplace.cancelListing.selector == 0x305a67a8, "cancelListing");
        require(LegacyCollectionMarketplace.buy.selector == 0xd6febde8, "buy");
        require(LegacyCollectionMarketplace.getListing.selector == 0x107a274a, "getListing");
        require(keccak256("ListingCreated(uint256,address,address,uint256,uint256,uint256,uint64)") == 0xd805c12164ca2f60bbd92cc6343c957e7813dff1eb56a4c62519c3222cd6bd19, "ListingCreated topic");
        require(keccak256("ListingSold(uint256,address,address,address,uint256,uint256,uint256,uint256,uint256)") == 0x2b7afc2686848b44bb9d680f07613f88a940454a6a60984a092cd305a781e811, "ListingSold topic");
        require(keccak256("ListingCancelled(uint256)") == 0x411aee90354c51b1b04cd563fcab2617142a9d50da19232d888547c8a1b7fd8a, "ListingCancelled topic");
        // The only creation entry point; the V4-shaped createListing (0x5201ea65) is deliberately absent (see the listing-path tests).
        require(LegacyCollectionMarketplace.createListingWithMinProceeds.selector == 0x068773dd, "createListingWithMinProceeds");
        require(LegacyCollectionMarketplace.setMinSellerProceeds.selector == 0x69ce933d, "setMinSellerProceeds");
    }

    function testGetListingShapeIsUnchangedAndFloorIsASeparateView() public {
        uint256 id = listProtected(2, PRICE, EXPECTED);
        LegacyCollectionMarketplace.Listing memory l = market.getListing(id);
        require(l.listingId == id && l.seller == SELLER && l.amount == 2 && l.price == PRICE, "9-field listing as in V4");
        require(market.minSellerProceedsPerUnit(id) == EXPECTED, "floor readable separately");
        require(abi.encode(l).length == 9 * 32, "getListing still encodes exactly 9 static words");
    }

    // ---------------------------------------------------------------- satisfied / violated / reduced royalty

    function testMinimumSatisfiedAtExpectedRoyalty() public {
        uint256 id = listProtected(2, PRICE, EXPECTED);
        uint256 sellerBefore = SELLER.balance;
        (bool ok,) = buyCall(id, 1, PRICE);
        require(ok, "sale at the expected royalty succeeds");
        require(SELLER.balance - sellerBefore == EXPECTED && FEE.balance == 0.025 ether && CREATOR.balance == 0.05 ether, "92.5 / 2.5 / 5");
        (ok,) = buyCall(id, 1, PRICE);
        require(ok && market.listingStatus(id) == LegacyCollectionMarketplace.Status.SOLD, "full fill");
    }

    function testRoyaltyIncreaseBelowMinimumRevertsAtomically() public {
        uint256 id = listProtected(3, PRICE, EXPECTED);
        genesis.setRoyalty(CREATOR, 700); // seller would now net 0.905
        Snapshot memory before = snap(id);
        (bool ok, bytes memory ret) = buyCall(id, 1, PRICE);
        require(!ok && selector(ret) == LegacyCollectionMarketplace.BelowMinimumProceeds.selector, "BelowMinimumProceeds");
        require(sameSnap(before, snap(id)), "no token moved, no payment retained, listing unchanged");
        // Same for any quantity, including the whole listing.
        (ok,) = buyCall(id, 3, 3 * PRICE);
        require(!ok && sameSnap(before, snap(id)), "quantity does not bypass the floor");
    }

    function testRoyaltyDecreaseNeverShortPaysTheSeller() public {
        uint256 id = listProtected(2, PRICE, EXPECTED);
        genesis.setRoyalty(CREATOR, 100); // 1%
        uint256 sellerBefore = SELLER.balance;
        uint256 creatorBefore = CREATOR.balance;
        (bool ok,) = buyCall(id, 2, 2 * PRICE);
        require(ok, "cheaper royalty still sells");
        require(SELLER.balance - sellerBefore == 2 * 0.965 ether, "seller gets exactly price - 2.5% - 1%");
        require(CREATOR.balance - creatorBefore == 0.02 ether && FEE.balance == 0.05 ether, "creator 1%, fee 2.5%");
        require(address(market).balance == 0, "nothing left in the marketplace");
    }

    function testZeroRoyaltyPaysSellerEverythingAfterTheFee() public {
        genesis.setRoyalty(CREATOR, 0);
        uint256 id = listProtected(1, PRICE, 0.975 ether);
        uint256 sellerBefore = SELLER.balance;
        (bool ok,) = buyCall(id, 1, PRICE);
        require(ok && SELLER.balance - sellerBefore == 0.975 ether && CREATOR.balance == 0 && FEE.balance == 0.025 ether, "zero royalty");
    }

    // ---------------------------------------------------------------- redirection and malicious royalty responses

    function testRoyaltyReceiverChangeCannotRedirectSellerProceeds() public {
        uint256 id = listProtected(1, PRICE, EXPECTED);
        genesis.setRoyalty(ATTACKER, 500); // collection admin points the royalty somewhere else
        uint256 sellerBefore = SELLER.balance;
        (bool ok,) = buyCall(id, 1, PRICE);
        require(ok, "same amount, new receiver");
        require(SELLER.balance - sellerBefore == EXPECTED, "seller proceeds unchanged");
        require(ATTACKER.balance == 0.05 ether && CREATOR.balance == 0, "only the royalty follows the receiver");
    }

    function testMaliciousRoyaltyResponsesCannotBypassTheFloorOrFinishASale() public {
        uint256 id = listProtected(1, PRICE, EXPECTED);
        Snapshot memory before = snap(id);
        for (uint256 mode = 1; mode <= 6; mode++) {
            if (mode == 5) continue; // non-linear mode only matters for bulk listings (covered below)
            genesis.setRoyaltyMode(mode);
            vm.prank(BUYER);
            (bool bought,) = address(market).call{value: PRICE, gas: 3_000_000}(abi.encodeCall(market.buy, (id, 1)));
            require(!bought, "hostile royaltyInfo cannot complete a sale");
            require(sameSnap(before, snap(id)), "state untouched");
        }
        genesis.setRoyaltyMode(0);
        // A royalty that is cheap at one unit but absurd in bulk cannot be listed with a floor either.
        genesis.setRoyaltyMode(5);
        vm.prank(SELLER);
        try market.createListingWithMinProceeds(address(genesis), SELLER, 0, 2, PRICE, 0, EXPECTED) { revert("bulk listed"); } catch {}
    }

    // ---------------------------------------------------------------- rounding

    function testRoundingIsFloorBasedAndTheFloorMatchesTheRealValuedShare() public {
        uint256 price = 333; // real seller share 333 * 92.5% = 308.025; floors: fee 8, royalty 16
        uint256 minUnit = (price * (10_000 - 250 - 500)) / 10_000; // 308 = floor of the real-valued share
        require(minUnit == 308, "floor of the exact share");
        uint256 id = listProtected(3, price, minUnit);
        uint256 sellerBefore = SELLER.balance;
        (bool ok,) = buyCall(id, 3, 3 * price); // sale 999: fee 24, royalty 49, seller 926 >= 3 * 308
        require(ok && SELLER.balance - sellerBefore == 926 && FEE.balance == 24 && CREATOR.balance == 49, "full quantity rounds in the seller's favour");
        require(926 + 24 + 49 == 999, "exact conservation");
        // One unit at the same price: fee 8, royalty 16, seller 309 (one wei above the floor).
        uint256 id2 = listProtected(1, price, minUnit);
        sellerBefore = SELLER.balance;
        (ok,) = buyCall(id2, 1, price);
        require(ok && SELLER.balance - sellerBefore == 309, "1 unit nets 309");
    }

    function testAFloorAboveWhatTheFloorsCanDeliverIsRefusedAtListingTime() public {
        // 333 wei x 1: seller nets 309; a 310 floor is unattainable. 333 x 3 nets 926 < 3 * 309 = 927.
        vm.prank(SELLER);
        try market.createListingWithMinProceeds(address(genesis), SELLER, 0, 1, 333, 0, 310) { revert("310 unattainable"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.MinProceedsTooHigh.selector, "MinProceedsTooHigh");
        }
        vm.prank(SELLER);
        try market.createListingWithMinProceeds(address(genesis), SELLER, 0, 3, 333, 0, 309) { revert("309 x 3 unattainable"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.MinProceedsTooHigh.selector, "MinProceedsTooHigh");
        }
        vm.prank(SELLER);
        try market.createListingWithMinProceeds(address(genesis), SELLER, 0, 1, PRICE, 0, PRICE + 1) { revert("floor above the price"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.MinProceedsTooHigh.selector, "floor above price");
        }
    }

    function testFullQuantityAndPartialFillsAllEnforceTheFloor() public {
        uint256 id = listProtected(5, PRICE, EXPECTED);
        (bool ok,) = buyCall(id, 2, 2 * PRICE);
        require(ok, "partial fill 2");
        genesis.setRoyalty(CREATOR, 600);
        Snapshot memory before = snap(id);
        (ok,) = buyCall(id, 1, PRICE);
        require(!ok, "later unit refused after the royalty rose");
        (ok,) = buyCall(id, 3, 3 * PRICE);
        require(!ok && sameSnap(before, snap(id)), "remaining quantity refused too");
        genesis.setRoyalty(CREATOR, 500);
        (ok,) = buyCall(id, 3, 3 * PRICE);
        require(ok && market.listingStatus(id) == LegacyCollectionMarketplace.Status.SOLD, "sells once the royalty is back");
    }

    // ---------------------------------------------------------------- updates and authorization

    function testOnlyTheSellerCanUpdateTheFloorAndOnlyWhileActive() public {
        uint256 id = listProtected(1, PRICE, EXPECTED);
        vm.prank(STRANGER);
        try market.setMinSellerProceeds(id, 0) { revert("stranger lowers the floor"); } catch (bytes memory e) { require(selector(e) == LegacyCollectionMarketplace.NotSeller.selector, "NotSeller"); }
        vm.prank(OWNER);
        try market.setMinSellerProceeds(id, 0) { revert("marketplace owner lowers the floor"); } catch (bytes memory e) { require(selector(e) == LegacyCollectionMarketplace.NotSeller.selector, "owner is not the seller"); }
        vm.prank(BUYER);
        try market.setMinSellerProceeds(id, 0) { revert("buyer lowers the floor"); } catch {}
        require(market.minSellerProceedsPerUnit(id) == EXPECTED, "floor intact");
        vm.prank(SELLER);
        market.setMinSellerProceeds(id, 0.9 ether);
        require(market.minSellerProceedsPerUnit(id) == 0.9 ether, "seller lowered it");
        vm.prank(SELLER);
        market.cancelListing(id);
        vm.prank(SELLER);
        try market.setMinSellerProceeds(id, 0.8 ether) { revert("cancelled listing updated"); } catch (bytes memory e) { require(selector(e) == LegacyCollectionMarketplace.ListingNotActive.selector, "inactive"); }
        vm.prank(SELLER);
        try market.setMinSellerProceeds(777, 1) { revert("unknown listing"); } catch (bytes memory e) { require(selector(e) == LegacyCollectionMarketplace.ListingNotActive.selector, "unknown"); }
    }

    function testSellerCanLowerTheFloorAfterARoyaltyRiseAndThenTheSaleSettlesAtTheNewTruth() public {
        uint256 id = listProtected(1, PRICE, EXPECTED);
        genesis.setRoyalty(CREATOR, 700);
        (bool ok,) = buyCall(id, 1, PRICE);
        require(!ok, "protected");
        vm.prank(SELLER);
        try market.setMinSellerProceeds(id, EXPECTED) { revert("a floor that is no longer attainable"); } catch (bytes memory e) { require(selector(e) == LegacyCollectionMarketplace.MinProceedsTooHigh.selector, "unattainable"); }
        vm.prank(SELLER);
        market.setMinSellerProceeds(id, 0.9 ether);
        uint256 sellerBefore = SELLER.balance;
        (ok,) = buyCall(id, 1, PRICE);
        require(ok && SELLER.balance - sellerBefore == 0.905 ether, "seller consciously accepted 90.5%");
    }

    function testUpdatesWorkWhilePausedAndCancellationStaysSellerOnly() public {
        uint256 id = listProtected(1, PRICE, EXPECTED);
        vm.prank(OWNER);
        market.setPaused(true);
        vm.prank(SELLER);
        market.setMinSellerProceeds(id, 0.9 ether);
        vm.prank(STRANGER);
        try market.cancelListing(id) { revert("stranger cancels"); } catch (bytes memory e) { require(selector(e) == LegacyCollectionMarketplace.NotSeller.selector, "NotSeller"); }
        vm.prank(SELLER);
        market.cancelListing(id);
    }

    /// A trivially small floor is still an explicit, stored, non-zero seller choice: the listing then accepts any royalty the cap allows.
    /// (The app never sends one; the semantics are pinned here so the audit and the UI copy describe the contract truthfully.)
    function testATinyFloorIsAnExplicitChoiceThatAcceptsAnyRoyaltyUpToTheCap() public {
        vm.prank(SELLER);
        uint256 id = market.createListingWithMinProceeds(address(genesis), SELLER, 0, 1, PRICE, 0, 1);
        require(market.minSellerProceedsPerUnit(id) == 1, "the floor is stored exactly as given");
        genesis.setRoyalty(CREATOR, 900); // within this fixture's 1000 bps cap
        uint256 sellerBefore = SELLER.balance;
        (bool ok,) = buyCall(id, 1, PRICE);
        require(ok && SELLER.balance - sellerBefore == 0.885 ether, "sells at the live 9% royalty because the seller chose a 1 wei floor");
    }

    // ---------------------------------------------------------------- failed payments and reentrancy with a floor

    function testRoyaltyPaymentFailureRevertsTheWholeProtectedPurchase() public {
        RejectsAvax bad = new RejectsAvax();
        genesis.setRoyalty(address(bad), 500);
        uint256 id = listProtected(1, PRICE, EXPECTED);
        Snapshot memory before = snap(id);
        (bool ok, bytes memory ret) = buyCall(id, 1, PRICE);
        require(!ok && selector(ret) == LegacyCollectionMarketplace.TransferFailed.selector, "TransferFailed");
        require(sameSnap(before, snap(id)), "fully rolled back");
    }

    function testReentrantRoyaltyReceiverCannotDoubleSettleAProtectedListing() public {
        ReentrantReceiver attacker = new ReentrantReceiver(market);
        genesis.setRoyalty(address(attacker), 500);
        uint256 id = listProtected(3, PRICE, EXPECTED);
        attacker.arm(id);
        uint256 sellerBefore = SELLER.balance;
        (bool ok,) = buyCall(id, 1, PRICE);
        require(ok && attacker.reentered() && !attacker.reentrySucceeded(), "re-entry attempted and blocked");
        require(market.getListing(id).amount == 2 && genesis.balanceOf(BUYER, 0) == 1 && SELLER.balance - sellerBefore == EXPECTED, "exactly one unit settled");
    }

    // ---------------------------------------------------------------- ordinary ERC-1155 behaviour

    function testPlainTransfersAreUnaffectedAndAStaleProtectedListingReverts() public {
        uint256 id = listProtected(10, PRICE, EXPECTED);
        vm.prank(SELLER);
        genesis.safeTransferFrom(SELLER, STRANGER, 0, 10, "");
        require(genesis.balanceOf(STRANGER, 0) == 10 && genesis.balanceOf(address(market), 0) == 0, "plain transfer, no custody");
        (bool ok, bytes memory ret) = buyCall(id, 1, PRICE);
        require(!ok && selector(ret) == LegacyCollectionMarketplace.InsufficientBalance.selector, "stale listing refused");
    }
}
