// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactory} from "../contracts/VoidReleaseFactory.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {ReleaseMarketplaceV3} from "../contracts/ReleaseMarketplaceV3.sol";

interface Vm { function prank(address) external; function deal(address, uint256) external; }

contract ReleaseMarketplaceV3Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VoidReleaseFactory internal factory;
    VoidRelease1155V4 internal releaseA;
    VoidRelease1155V4 internal releaseB;
    VoidPrimarySale internal saleA;
    VoidPrimarySale internal saleB;
    ReleaseMarketplaceV3 internal market;
    address internal artist = address(0xA11CE);
    address internal safe = address(0x5AFE);
    address internal platform = address(0xFEE);
    address internal collector = address(0xC011);
    address internal buyer = address(0xB0B);
    bytes32 internal constant RELEASE_A = keccak256("market-a");
    bytes32 internal constant RELEASE_B = keccak256("market-b");
    bytes32 internal constant EDITION = keccak256("market-edition");
    uint256 internal constant PRICE = 1 ether;

    function setUp() public {
        factory = new VoidReleaseFactory(platform, 250, safe);
        (address a, address saleA_,) = factory.createRelease(artist, RELEASE_A, "Market A", "MA", "");
        (address b, address saleB_,) = factory.createRelease(artist, RELEASE_B, "Market B", "MB", "");
        releaseA = VoidRelease1155V4(a); releaseB = VoidRelease1155V4(b);
        saleA = VoidPrimarySale(saleA_); saleB = VoidPrimarySale(saleB_);
        market = new ReleaseMarketplaceV3(platform, 250, address(factory));
        vm.prank(artist); uint256 idA = releaseA.createEdition(RELEASE_A, EDITION, 3, "ipfs://a", artist, 500);
        vm.prank(artist); uint256 idB = releaseB.createEdition(RELEASE_B, EDITION, 3, "ipfs://b", artist, 500);
        require(idA == idB, "same numeric token id fixture");
        vm.prank(address(saleA)); releaseA.mint(collector, idA, 1, "");
        vm.prank(address(saleB)); releaseB.mint(collector, idB, 1, "");
        vm.prank(collector); releaseA.setApprovalForAll(address(market), true);
        vm.prank(collector); releaseB.setApprovalForAll(address(market), true);
    }

    function testMarketplaceSettlesOnlyListedReleaseContract() public {
        uint256 id = releaseA.tokenIdFor(RELEASE_A, EDITION);
        vm.prank(collector);
        uint256 listingId = market.createListing(address(releaseA), collector, id, 1, PRICE, 0);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        market.buy{value: PRICE}(listingId, 1);
        require(releaseA.balanceOf(buyer, id) == 1 && releaseA.balanceOf(collector, id) == 0, "A ownership settled");
        require(releaseB.balanceOf(buyer, id) == 0 && releaseB.balanceOf(collector, id) == 1, "B ownership cannot be touched");
    }

    function testMarketplaceRejectsContractsNotCreatedByReleaseFactory() public {
        uint256 id = releaseA.tokenIdFor(RELEASE_A, EDITION);
        vm.prank(collector);
        try market.createListing(address(0xBEEF), collector, id, 1, PRICE, 0) { revert("unregistered contract listed"); } catch {}
    }
}
