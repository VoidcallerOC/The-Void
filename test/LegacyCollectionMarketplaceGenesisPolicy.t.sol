// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegacyCollectionMarketplace} from "../contracts/LegacyCollectionMarketplace.sol";
import {MockGenesis, VmLegacy} from "./LegacyCollectionMarketplace.t.sol";

/// @notice The audit candidate's exact Genesis policy, enforced by the contract (not by the frontend):
/// token ids 0-3, a 500 bps royalty cap, no platform fee (0% platform / full royalty / rest to the seller). Plus fuzzed reconciliation of the contract's arithmetic with the
/// documented formulas.
contract LegacyCollectionMarketplaceGenesisPolicyTest {
    VmLegacy internal constant vm = VmLegacy(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant FEE = address(0xFEE5);
    address internal constant OWNER = address(0x0A11);
    address internal constant CREATOR = address(0xC4EA);
    address internal constant SELLER = address(0x5E11);
    address internal constant BUYER = address(0xB0B);

    LegacyCollectionMarketplace internal market;
    MockGenesis internal genesis;

    function setUp() public {
        market = new LegacyCollectionMarketplace(OWNER);
        genesis = new MockGenesis(CREATOR);
        vm.prank(OWNER);
        market.allowCollection(address(genesis), 500, 0, 3); // the candidate's initial policy
        for (uint256 id = 0; id < 6; id++) genesis.mint(SELLER, id, 100);
        vm.deal(BUYER, 1_000_000 ether);
        vm.prank(SELLER);
        genesis.setApprovalForAll(address(market), true);
    }

    function selector(bytes memory ret) internal pure returns (bytes4 s) { assembly { s := mload(add(ret, 32)) } }

    // ---------------------------------------------------------------- policy exactly as configured

    function testPolicyIsExactlyTokens0To3WithA500BpsCap() public view {
        LegacyCollectionMarketplace.Collection memory c = market.getCollection(address(genesis));
        require(c.enabled && c.maxRoyaltyBps == 500 && c.minTokenId == 0 && c.maxTokenId == 3, "candidate policy");
        require(market.platformFeeBps() == 0, "no platform fee");
        require(market.ROYALTY_CEILING_BPS() == 1000, "owner can never configure a cap above 10%");
    }

    function testTokenIds0Through3AreListedAndBought() public {
        for (uint256 id = 0; id <= 3; id++) {
            vm.prank(SELLER);
            uint256 listingId = market.createListingWithMinProceeds(address(genesis), SELLER, id, 1, 1 ether, 0, 0.95 ether);
            vm.prank(BUYER);
            market.buy{value: 1 ether}(listingId, 1);
            require(genesis.balanceOf(BUYER, id) == 1, "bought");
        }
        require(CREATOR.balance == 4 * 0.05 ether && FEE.balance == 0, "5% royalty on each, nothing to the platform");
    }

    function testTokenIdsOutsideTheScopeAreRefusedForListingAndForExistingListings() public {
        for (uint256 id = 4; id <= 5; id++) {
            vm.prank(SELLER);
            try market.createListingWithMinProceeds(address(genesis), SELLER, id, 1, 1 ether, 0, 1) { revert("out-of-scope id listed"); } catch (bytes memory e) {
                require(selector(e) == LegacyCollectionMarketplace.UnsupportedToken.selector, "UnsupportedToken");
            }
        }
        vm.prank(SELLER);
        try market.createListingWithMinProceeds(address(genesis), SELLER, type(uint256).max, 1, 1 ether, 0, 1) { revert("max id listed"); } catch {}
        // Narrowing the range after listing makes the existing listing unbuyable but still cancelable.
        vm.prank(SELLER);
        uint256 listingId = market.createListingWithMinProceeds(address(genesis), SELLER, 3, 1, 1 ether, 0, 1);
        vm.prank(OWNER);
        market.allowCollection(address(genesis), 500, 0, 2);
        vm.prank(BUYER);
        (bool ok,) = address(market).call{value: 1 ether}(abi.encodeCall(market.buy, (listingId, 1)));
        require(!ok, "narrowed scope blocks the sale");
        vm.prank(SELLER);
        market.cancelListing(listingId);
    }

    function testRoyaltyAtTheCapIsAcceptedAndOneBpsAboveIsRefused() public {
        genesis.setRoyalty(CREATOR, 500);
        vm.prank(SELLER);
        uint256 listingId = market.createListingWithMinProceeds(address(genesis), SELLER, 0, 1, 1 ether, 0, 1);
        genesis.setRoyalty(CREATOR, 501);
        vm.prank(BUYER);
        (bool ok, bytes memory ret) = address(market).call{value: 1 ether}(abi.encodeCall(market.buy, (listingId, 1)));
        require(!ok && selector(ret) == LegacyCollectionMarketplace.RoyaltyAboveCap.selector, "501 bps refused");
        require(genesis.balanceOf(BUYER, 0) == 0 && BUYER.balance == 1_000_000 ether, "nothing moved");
        vm.prank(SELLER);
        try market.createListingWithMinProceeds(address(genesis), SELLER, 0, 1, 1 ether, 0, 1) { revert("listing above the cap"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.RoyaltyAboveCap.selector, "refused at listing too");
        }
        genesis.setRoyalty(CREATOR, 500);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(listingId, 1);
        require(CREATOR.balance == 0.05 ether, "exactly 5% at the cap");
    }

    function testAnotherCollectionStaysRefusedEvenWithIdenticalBehaviour() public {
        MockGenesis clone = new MockGenesis(CREATOR);
        clone.mint(SELLER, 0, 1);
        vm.prank(SELLER);
        clone.setApprovalForAll(address(market), true);
        vm.prank(SELLER);
        try market.createListingWithMinProceeds(address(clone), SELLER, 0, 1, 1 ether, 0, 0.9 ether) { revert("non-allowlisted collection"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.UnsupportedCollection.selector, "UnsupportedCollection");
        }
    }

    function testDocumentedSettlementAtTheReportedRates() public {
        vm.prank(SELLER);
        uint256 id = market.createListingWithMinProceeds(address(genesis), SELLER, 1, 4, 1 ether, 0, 0.95 ether);
        uint256 sellerBefore = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: 4 ether}(id, 4);
        require(SELLER.balance - sellerBefore == 3.8 ether, "95% to the seller");
        require(CREATOR.balance == 0.2 ether, "5% to the creator");
        require(FEE.balance == 0, "0% to the platform");
        require(address(market).balance == 0, "nothing retained");
    }

    // ---------------------------------------------------------------- owner powers, stated precisely

    /// The marketplace owner can move the cap (<= 10%) and pause/disable; it can never touch a listing, a floor, a token or funds.
    /// What it CAN influence is how much royalty an UNPROTECTED listing tolerates; a floor makes a listing immune to that.
    function testOwnerCannotAlterSellerProceedsOfAProtectedListingAndOnlyWidensTheCapForUnprotectedOnes() public {
        vm.prank(SELLER);
        uint256 protectedId = market.createListingWithMinProceeds(address(genesis), SELLER, 0, 1, 1 ether, 0, 0.95 ether);
        vm.prank(SELLER);
        uint256 unprotectedId = market.createListingWithMinProceeds(address(genesis), SELLER, 1, 1, 1 ether, 0, 1);

        vm.prank(OWNER);
        market.allowCollection(address(genesis), 1000, 0, 3); // the widest cap the contract permits
        genesis.setRoyalty(CREATOR, 900); // the collection's own admin, not the marketplace owner, sets the royalty

        vm.prank(BUYER);
        (bool ok,) = address(market).call{value: 1 ether}(abi.encodeCall(market.buy, (protectedId, 1)));
        require(!ok, "the floor holds however the owner sets the cap");
        uint256 sellerBefore = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: 1 ether}(unprotectedId, 1);
        require(SELLER.balance - sellerBefore == 0.91 ether, "an unprotected listing pays what the collection's royalty dictates (documented risk)");

        // None of the owner's calls can change a listing, a floor or a balance.
        require(market.minSellerProceedsPerUnit(protectedId) == 0.95 ether && market.getListing(protectedId).price == 1 ether && market.getListing(protectedId).seller == SELLER, "listing untouched");
        require(address(market).balance == 0, "the marketplace never holds funds between transactions");
        vm.prank(OWNER);
        (bool cancelled,) = address(market).call(abi.encodeCall(market.cancelListing, (protectedId)));
        require(!cancelled, "owner cannot cancel a seller's listing");
        vm.prank(OWNER);
        (bool floorChanged,) = address(market).call(abi.encodeCall(market.setMinSellerProceeds, (protectedId, 0)));
        require(!floorChanged, "owner cannot lower a seller's floor");
        vm.prank(OWNER);
        market.setPaused(true);
        vm.prank(SELLER);
        market.cancelListing(protectedId); // the seller can always exit
    }

    // ---------------------------------------------------------------- fuzz: contract arithmetic == documented formulas

    /// settlement conservation, exact rounding and the seller-floor invariant for arbitrary price, quantity and royalty <= cap
    function testFuzzSettlementMatchesTheDocumentedFormulaAndNeverShortsTheFloor(uint96 priceRaw, uint8 qRaw, uint16 bpsRaw) public {
        uint256 price = uint256(priceRaw) % 1e22 + 100; // below 100 wei no protective floor exists (see the tiny-price test)
        uint256 q = uint256(qRaw) % 40 + 1;
        uint256 bps = uint256(bpsRaw) % 501;
        genesis.setRoyalty(CREATOR, bps);
        uint256 floorPerUnit = (price * (10_000 - bps)) / 10_000;
        vm.prank(SELLER);
        uint256 id = market.createListingWithMinProceeds(address(genesis), SELLER, 0, q, price, 0, floorPerUnit);

        uint256 sale = price * q;
        uint256 sellerBefore = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: sale}(id, q);

        uint256 fee = FEE.balance;
        uint256 royalty = CREATOR.balance;
        uint256 seller = SELLER.balance - sellerBefore;
        require(fee == 0, "no platform fee at any price, quantity or royalty");
        require(royalty == (sale * bps) / 10_000, "royalty = royaltyInfo(S), paid in full");
        require(seller == sale - royalty, "seller = S - royalty");
        require(seller >= floorPerUnit * q, "the exact-rate floor is always cleared at the live royalty");
        require(address(market).balance == 0 && genesis.balanceOf(BUYER, 0) == q, "no residue, tokens delivered");
    }

    /// any royalty above the cap is refused with nothing moved
    function testFuzzRoyaltyAboveTheCapIsAlwaysRefused(uint16 bpsRaw, uint96 priceRaw) public {
        uint256 bps = 501 + (uint256(bpsRaw) % 2000);
        uint256 price = uint256(priceRaw) % 1e22 + 10_000; // large enough that 1 bp is >= 1 wei
        vm.prank(SELLER);
        uint256 id = market.createListingWithMinProceeds(address(genesis), SELLER, 2, 1, price, 0, 1);
        genesis.setRoyalty(CREATOR, bps);
        vm.prank(BUYER);
        (bool ok,) = address(market).call{value: price}(abi.encodeCall(market.buy, (id, 1)));
        require(!ok && genesis.balanceOf(BUYER, 2) == 0 && CREATOR.balance == 0 && FEE.balance == 0, "refused, nothing moved");
    }

    /// With a floor set at one royalty, a purchase at any later royalty either reverts with nothing moved or clears the floor.
    function testFuzzFloorHoldsWheneverTheRoyaltyChangesAfterListing(uint16 listedRaw, uint16 laterRaw, uint96 priceRaw, uint8 qRaw) public {
        uint256 listedBps = uint256(listedRaw) % 501;
        uint256 laterBps = uint256(laterRaw) % 501;
        uint256 price = uint256(priceRaw) % 1e22 + 100; // below 100 wei no protective floor exists (see the tiny-price test)
        uint256 q = uint256(qRaw) % 20 + 1;
        genesis.setRoyalty(CREATOR, listedBps);
        uint256 floorPerUnit = (price * (10_000 - listedBps)) / 10_000;
        vm.prank(SELLER);
        uint256 id = market.createListingWithMinProceeds(address(genesis), SELLER, 1, q, price, 0, floorPerUnit);

        genesis.setRoyalty(CREATOR, laterBps);
        uint256 sale = price * q;
        uint256 sellerBefore = SELLER.balance;
        uint256 buyerBefore = BUYER.balance;
        vm.prank(BUYER);
        (bool ok,) = address(market).call{value: sale}(abi.encodeCall(market.buy, (id, q)));
        if (ok) {
            require(SELLER.balance - sellerBefore >= floorPerUnit * q, "a completed sale always clears the floor");
        } else {
            require(laterBps > listedBps, "only a royalty increase may block the sale");
            require(BUYER.balance == buyerBefore && SELLER.balance == sellerBefore && genesis.balanceOf(BUYER, 1) == 0 && market.getListing(id).amount == q, "atomic revert");
        }
        if (laterBps <= listedBps) require(ok, "a lower or equal royalty always sells");
    }
}
