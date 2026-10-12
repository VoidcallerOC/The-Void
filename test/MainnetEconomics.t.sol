// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2} from "../contracts/VoidReleaseFactoryV2.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {ReleaseMarketplaceV3} from "../contracts/ReleaseMarketplaceV3.sol";

interface VmMainnetEconomics {
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
}

/// @notice The final mainnet economics on the exact contracts the mainnet workflow deploys
/// (VoidReleaseFactoryV2 + ReleaseMarketplaceV3): one passive platform fee recipient takes 2.5% of
/// primary sales and 2.5% of resales; each release's own artist payout takes a 2.5% resale royalty;
/// the seller keeps 95%. The artist royalty never reaches the platform fee recipient.
contract MainnetEconomicsTest {
    VmMainnetEconomics internal constant vm = VmMainnetEconomics(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant PLATFORM = address(0xFEE5);
    address internal constant ARTIST_A = address(0xA11CE);
    address internal constant PAYOUT_A = address(0xA11CE2);
    address internal constant ARTIST_B = address(0xB0B0);
    address internal constant COLLECTOR = address(0xC011);
    address internal constant BUYER = address(0xB0B);
    address internal constant STRANGER = address(0x5757);
    uint96 internal constant ROYALTY_BPS = 250;

    VoidReleaseFactoryV2 internal factory;
    ReleaseMarketplaceV3 internal market;
    VoidRelease1155V4 internal cloneA;
    VoidRelease1155V4 internal cloneB;
    uint256 internal tokenA;
    uint256 internal tokenB;

    function setUp() public {
        factory = new VoidReleaseFactoryV2(PLATFORM);
        market = new ReleaseMarketplaceV3(PLATFORM, 250, address(factory));
    }

    function release(address artist, address payout, bytes32 appId, bytes32 editionId) internal returns (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) {
        bytes32 key = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), appId, artist));
        vm.prank(artist);
        (address releaseContract, address primarySale,) = factory.createRelease(appId, key, "Release", "REL", "ipfs://release");
        clone = VoidRelease1155V4(releaseContract);
        sale = VoidPrimarySale(primarySale);
        vm.prank(artist);
        tokenId = clone.createEdition(key, editionId, 10, "ipfs://edition", payout, ROYALTY_BPS);
        vm.prank(artist);
        sale.configureSale(tokenId, 1 ether, 10, 5, 0, 0, false);
    }

    function buyPrimary(VoidPrimarySale sale, uint256 tokenId, address buyer) internal {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        sale.purchase{value: 1 ether}(tokenId, 1);
    }

    function list(VoidRelease1155V4 clone, uint256 tokenId, address seller) internal returns (uint256 listingId) {
        vm.prank(seller);
        clone.setApprovalForAll(address(market), true);
        vm.prank(seller);
        listingId = market.createListing(address(clone), seller, tokenId, 1, 1 ether, 0);
    }

    function testPrimarySaleCreditsTwoPointFivePercentToThePlatformAndTheRestToTheArtistPayout() public {
        (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) = release(ARTIST_A, PAYOUT_A, "app-a", "edition-a");
        require(factory.PLATFORM_FEE_BPS() == 250 && sale.platformFeeBps() == 250, "primary fee sealed at 250 bps");
        buyPrimary(sale, tokenId, COLLECTOR);
        require(clone.balanceOf(COLLECTOR, tokenId) == 1, "buyer owns the edition");
        // Fees are credited without the recipient signing anything; collecting them is the owner's withdraw.
        require(sale.balances(PLATFORM) == 0.025 ether, "platform credited exactly 2.5%");
        require(sale.balances(PAYOUT_A) == 0.975 ether, "artist payout credited the remaining 97.5%");
        require(sale.balances(ARTIST_A) == 0, "nothing is credited to a wallet other than the edition payout");

        vm.prank(STRANGER);
        try sale.withdraw() { revert("a stranger cannot collect"); } catch {}
        require(sale.balances(PLATFORM) == 0.025 ether, "platform credit untouched by others");
        uint256 before = PLATFORM.balance;
        vm.prank(PLATFORM);
        sale.withdraw();
        require(PLATFORM.balance == before + 0.025 ether && sale.balances(PLATFORM) == 0, "recipient collects exactly its credit");
    }

    function testResalePaysEachReleasesOwnArtistTwoPointFivePercentThePlatformTwoPointFiveAndTheSellerNinetyFive() public {
        VoidPrimarySale saleA;
        VoidPrimarySale saleB;
        (cloneA, saleA, tokenA) = release(ARTIST_A, PAYOUT_A, "app-a", "edition-a");
        (cloneB, saleB, tokenB) = release(ARTIST_B, ARTIST_B, "app-b", "edition-b");
        buyPrimary(saleA, tokenA, COLLECTOR);
        buyPrimary(saleB, tokenB, COLLECTOR);
        assertRoyaltyRouting();

        uint256 listingA = list(cloneA, tokenA, COLLECTOR);
        uint256 listingB = list(cloneB, tokenB, COLLECTOR);
        uint256 platformBefore = PLATFORM.balance;
        uint256 payoutABefore = PAYOUT_A.balance;
        uint256 artistBBefore = ARTIST_B.balance;
        uint256 sellerBefore = COLLECTOR.balance;

        vm.deal(BUYER, 2 ether);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(listingA, 1);
        require(PLATFORM.balance == platformBefore + 0.025 ether, "marketplace fee 2.5% to the platform");
        require(PAYOUT_A.balance == payoutABefore + 0.025 ether, "release A royalty 2.5% to artist A's payout");
        require(ARTIST_B.balance == artistBBefore, "artist B is not paid for release A");
        require(COLLECTOR.balance == sellerBefore + 0.95 ether, "seller receives 95%");

        vm.prank(BUYER);
        market.buy{value: 1 ether}(listingB, 1);
        require(PLATFORM.balance == platformBefore + 0.05 ether, "second marketplace fee to the platform");
        require(ARTIST_B.balance == artistBBefore + 0.025 ether, "release B royalty to artist B");
        require(PAYOUT_A.balance == payoutABefore + 0.025 ether, "artist A is not paid for release B");
        require(COLLECTOR.balance == sellerBefore + 1.9 ether, "seller receives 95% of each resale");
        assertResaleSettled(listingA, listingB);
    }

    function assertRoyaltyRouting() internal view {
        (address receiverA, uint256 royaltyA) = cloneA.royaltyInfo(tokenA, 1 ether);
        (address receiverB, uint256 royaltyB) = cloneB.royaltyInfo(tokenB, 1 ether);
        require(receiverA == PAYOUT_A && receiverB == ARTIST_B, "royalty goes to each release's own artist payout");
        require(receiverA != PLATFORM && receiverB != PLATFORM, "royalty never goes to the platform fee recipient");
        require(royaltyA == 0.025 ether && royaltyB == 0.025 ether, "royalty is exactly 2.5%");
    }

    function assertResaleSettled(uint256 listingA, uint256 listingB) internal view {
        require(cloneA.balanceOf(BUYER, tokenA) == 1 && cloneB.balanceOf(BUYER, tokenB) == 1, "ownership moves to the buyer");
        require(cloneA.balanceOf(COLLECTOR, tokenA) == 0 && cloneB.balanceOf(COLLECTOR, tokenB) == 0, "seller no longer owns");
        require(uint8(market.listingStatus(listingA)) == uint8(ReleaseMarketplaceV3.Status.SOLD), "listing A sold");
        require(uint8(market.listingStatus(listingB)) == uint8(ReleaseMarketplaceV3.Status.SOLD), "listing B sold");
    }

    function testInvalidListingsFailWithoutMovingFundsOrTokens() public {
        (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) = release(ARTIST_A, PAYOUT_A, "app-a", "edition-a");
        buyPrimary(sale, tokenId, COLLECTOR);
        uint256 listingId = list(clone, tokenId, COLLECTOR);
        vm.deal(BUYER, 3 ether);

        vm.prank(BUYER);
        try market.buy{value: 0.5 ether}(listingId, 1) { revert("underpayment must fail"); } catch {}
        vm.prank(STRANGER);
        try market.cancelListing(listingId) { revert("only the seller cancels"); } catch {}

        // Stale: the seller moved the token away after listing.
        vm.prank(COLLECTOR);
        clone.safeTransferFrom(COLLECTOR, STRANGER, tokenId, 1, "");
        vm.prank(BUYER);
        try market.buy{value: 1 ether}(listingId, 1) { revert("stale listing must fail"); } catch {}
        vm.prank(STRANGER);
        clone.safeTransferFrom(STRANGER, COLLECTOR, tokenId, 1, "");

        // Approval revoked.
        vm.prank(COLLECTOR);
        clone.setApprovalForAll(address(market), false);
        vm.prank(BUYER);
        try market.buy{value: 1 ether}(listingId, 1) { revert("unapproved listing must fail"); } catch {}
        vm.prank(COLLECTOR);
        clone.setApprovalForAll(address(market), true);

        // Cancelled.
        vm.prank(COLLECTOR);
        market.cancelListing(listingId);
        vm.prank(BUYER);
        try market.buy{value: 1 ether}(listingId, 1) { revert("cancelled listing must fail"); } catch {}
        require(BUYER.balance == 3 ether && clone.balanceOf(COLLECTOR, tokenId) == 1, "no funds or tokens moved");

        // Sold listings cannot be bought twice; expired listings cannot be bought.
        uint256 relisted = list(clone, tokenId, COLLECTOR);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(relisted, 1);
        vm.prank(BUYER);
        try market.buy{value: 1 ether}(relisted, 1) { revert("sold listing must fail"); } catch {}
        vm.prank(BUYER);
        clone.setApprovalForAll(address(market), true);
        vm.prank(BUYER);
        uint256 expiring = market.createListing(address(clone), BUYER, tokenId, 1, 1 ether, uint64(block.timestamp + 60));
        vm.warp(block.timestamp + 61);
        vm.deal(STRANGER, 1 ether);
        vm.prank(STRANGER);
        try market.buy{value: 1 ether}(expiring, 1) { revert("expired listing must fail"); } catch {}
    }
}
