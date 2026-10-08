// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2} from "../contracts/VoidReleaseFactoryV2.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidProvenanceAnchor} from "../contracts/VoidProvenanceAnchor.sol";
import {ReleaseMarketplaceV3} from "../contracts/ReleaseMarketplaceV3.sol";

interface VmFactoryV2Market {
    function prank(address) external;
    function deal(address, uint256) external;
}

/// @notice Proves the Studio secondary path: FactoryV2 → V4 clone → PrimarySale →
/// ProvenanceAnchor → ReleaseMarketplaceV3 @ 250 bps. Does not use Factory V1.
contract FactoryV2ReleaseMarketplaceV3Test {
    VmFactoryV2Market internal constant vm = VmFactoryV2Market(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant PLATFORM = address(0xFEE);
    address internal constant ARTIST = address(0xA11CE);
    address internal constant COLLECTOR = address(0xC011);
    address internal constant BUYER = address(0xB0B);
    bytes32 internal constant APP_RELEASE = keccak256("factory-v2-secondary-app");
    bytes32 internal constant EDITION = keccak256("factory-v2-secondary-edition");
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant MARKET_FEE_BPS = 250;
    uint96 internal constant ROYALTY_BPS = 500;

    function releaseKey(VoidReleaseFactoryV2 factory, bytes32 applicationReleaseId, address artist) internal view returns (bytes32) {
        return keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), applicationReleaseId, artist));
    }

    function testFactoryV2CloneListsAndSettlesOnMarketplaceV3At250Bps() public {
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(PLATFORM);
        ReleaseMarketplaceV3 market = new ReleaseMarketplaceV3(PLATFORM, MARKET_FEE_BPS, address(factory));

        require(market.platformFeeBps() == 250, "marketplace fee must be 250 bps");
        require(address(market.registry()) == address(factory), "marketplace registry must be FactoryV2");
        require(factory.PLATFORM_FEE_BPS() == 250, "primary fee locked at 250 bps");

        bytes32 key = releaseKey(factory, APP_RELEASE, ARTIST);
        vm.prank(ARTIST);
        (address releaseContract, address primarySale, address provenanceAnchor) = factory.createRelease(
            APP_RELEASE, key, "Secondary V4", "SV4", "ipfs://secondary-v4"
        );

        require(factory.isRelease(releaseContract), "FactoryV2 must register the V4 clone");
        require(factory.primarySaleOf(releaseContract) == primarySale, "primary sale must be factory-bound");
        require(factory.provenanceAnchorOf(releaseContract) == provenanceAnchor, "provenance must be factory-bound");
        require(VoidProvenanceAnchor(provenanceAnchor).releaseContract() == releaseContract, "anchor bound to clone");
        require(VoidPrimarySale(primarySale).platformFeeBps() == 250, "primary sale fee sealed at 250");
        require(VoidPrimarySale(primarySale).owner() == address(factory), "fee control sealed in FactoryV2");

        VoidRelease1155V4 release = VoidRelease1155V4(releaseContract);
        vm.prank(ARTIST);
        uint256 tokenId = release.createEdition(key, EDITION, 3, "ipfs://edition", ARTIST, ROYALTY_BPS);
        require(tokenId == release.tokenIdFor(key, EDITION), "token id must derive from release+edition keys");

        bytes32 provenanceRoot = keccak256("secondary-path-provenance");
        vm.prank(ARTIST);
        VoidProvenanceAnchor(provenanceAnchor).anchor(key, EDITION, provenanceRoot);
        require(VoidProvenanceAnchor(provenanceAnchor).isAnchored(key, EDITION, provenanceRoot), "provenance must remain bound");

        vm.prank(ARTIST);
        VoidPrimarySale(primarySale).configureSale(tokenId, PRICE, 2, 2, 0, 0, false);
        vm.deal(COLLECTOR, PRICE);
        vm.prank(COLLECTOR);
        VoidPrimarySale(primarySale).purchase{value: PRICE}(tokenId, 1);
        require(release.balanceOf(COLLECTOR, tokenId) == 1, "collector must own the primary-purchased edition");

        // Unregistered foreign contract cannot list — FactoryV1 is never consulted.
        vm.prank(COLLECTOR);
        try market.createListing(address(0xBEEF), COLLECTOR, tokenId, 1, PRICE, 0) {
            revert("unregistered contract must not list");
        } catch {}

        vm.prank(COLLECTOR);
        release.setApprovalForAll(address(market), true);
        vm.prank(COLLECTOR);
        uint256 listingId = market.createListing(address(release), COLLECTOR, tokenId, 1, PRICE, 0);
        require(listingId == 1, "first listing id");
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV3.Status.ACTIVE), "listing active");

        uint256 platformBefore = PLATFORM.balance;
        uint256 artistBefore = ARTIST.balance;
        uint256 sellerBefore = COLLECTOR.balance;
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        market.buy{value: PRICE}(listingId, 1);

        require(release.balanceOf(BUYER, tokenId) == 1, "buyer receives exact token");
        require(release.balanceOf(COLLECTOR, tokenId) == 0, "seller balance cleared");
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV3.Status.SOLD), "listing sold");

        uint256 expectedPlatformFee = (PRICE * MARKET_FEE_BPS) / 10_000;
        uint256 expectedRoyalty = (PRICE * uint256(ROYALTY_BPS)) / 10_000;
        uint256 expectedSellerProceeds = PRICE - expectedPlatformFee - expectedRoyalty;
        require(expectedPlatformFee == 0.025 ether, "platform fee is exactly 250 bps of 1 ether");
        require(PLATFORM.balance == platformBefore + expectedPlatformFee, "platform fee paid");
        require(ARTIST.balance == artistBefore + expectedRoyalty, "artist royalty paid");
        require(COLLECTOR.balance == sellerBefore + expectedSellerProceeds, "seller proceeds paid");
        require(VoidProvenanceAnchor(provenanceAnchor).isAnchored(key, EDITION, provenanceRoot), "provenance still bound after secondary sale");
    }
}
