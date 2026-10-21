// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2Royalty} from "../contracts/VoidReleaseFactoryV2Royalty.sol";
import {VoidReleaseFactoryV2RoyaltySettled} from "../contracts/VoidReleaseFactoryV2RoyaltySettled.sol";
import {VoidRelease1155V4Royalty} from "../contracts/VoidRelease1155V4Royalty.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {ReleaseMarketplaceV4} from "../contracts/ReleaseMarketplaceV4.sol";

interface VmMultiCollection {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

/// @dev Stand-in for a collection The Void's factories did not create (Genesis is a Launchpeg ERC1155SingleBundle
/// paying a 5% ERC-2981 royalty). It holds a balance, approves operators and reports a royalty, so the only thing
/// that can refuse it is the marketplace's registry check.
contract ExternalCollectionStandIn {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    address public immutable royaltyReceiver;

    constructor(address holder, address receiver) {
        balanceOf[holder][0] = 1;
        royaltyReceiver = receiver;
    }

    function setApprovalForAll(address operator, bool approved) external { isApprovedForAll[msg.sender][operator] = approved; }
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) { return (royaltyReceiver, salePrice * 500 / 10_000); }
    function royaltyBpsOf(uint256) external pure returns (uint96) { return 250; }
    function payoutOf(uint256) external view returns (address) { return royaltyReceiver; }
}

/// @notice Local EVM, nothing deployed. Each factory release is its own contract address and trades on the
/// ReleaseMarketplaceV4 whose immutable registry is the factory that created it. This pins down, for the
/// production factory and the corrected (settled) factory side by side:
/// - the production marketplace keeps accepting production-factory releases and refuses corrected-factory ones;
/// - a marketplace built for the corrected factory accepts every release that factory creates, at its own address;
/// - collections no canonical factory registered (a Genesis-like collection, a clone from a look-alike factory) are refused;
/// - the primary fee is taken once at purchase and the marketplace fee once per resale, never both on one payment.
contract MarketplaceMultiCollectionCompatibilityTest {
    VmMultiCollection internal constant vm = VmMultiCollection(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ARTIST2 = address(0xA7158);
    address internal constant HOLDER = address(0xB0B);
    address internal constant BUYER = address(0xB0B2);
    bytes32 internal constant EDITION_ID = keccak256("edition");
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant PRICE = 0.4 ether;

    VoidReleaseFactoryV2Royalty internal productionFactory;
    VoidReleaseFactoryV2RoyaltySettled internal settledFactory;
    ReleaseMarketplaceV4 internal productionMarket;
    ReleaseMarketplaceV4 internal settledMarket;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(T0);
        productionFactory = new VoidReleaseFactoryV2Royalty(NANO);
        settledFactory = new VoidReleaseFactoryV2RoyaltySettled(NANO);
        productionMarket = new ReleaseMarketplaceV4(NANO, 250, address(productionFactory));
        settledMarket = new ReleaseMarketplaceV4(NANO, 250, address(settledFactory));
    }

    function _key(address factory, bytes32 app, address artist) internal view returns (bytes32) {
        return keccak256(abi.encode("the-void:studio-release:v2", block.chainid, factory, app, artist));
    }

    function _edition(VoidRelease1155V4Royalty release, bytes32 key, address artist) internal returns (uint256 tokenId) {
        vm.prank(artist);
        tokenId = release.createEditionWithMintEnd(key, EDITION_ID, 0, "ipfs://edition", artist, 250, uint64(T0 + 30 days));
    }

    function _productionRelease(bytes32 app, address artist) internal returns (VoidRelease1155V4Royalty release, VoidPrimarySale sale, uint256 tokenId) {
        bytes32 key = _key(address(productionFactory), app, artist);
        vm.prank(artist);
        (address r, address s,) = productionFactory.createRelease(app, key, "Release", "REL", "ipfs://release");
        release = VoidRelease1155V4Royalty(r);
        sale = VoidPrimarySale(s);
        tokenId = _edition(release, key, artist);
        vm.prank(artist);
        sale.configureSale(tokenId, PRICE, 0, 0, 0, uint64(T0 + 30 days), false);
    }

    function _settledRelease(VoidReleaseFactoryV2RoyaltySettled factory, bytes32 app, address artist)
        internal
        returns (VoidRelease1155V4Royalty release, VoidPrimarySaleSettled sale, uint256 tokenId)
    {
        bytes32 key = _key(address(factory), app, artist);
        vm.prank(artist);
        (address r, address s,) = factory.createRelease(app, key, "Release", "REL", "ipfs://release");
        release = VoidRelease1155V4Royalty(r);
        sale = VoidPrimarySaleSettled(s);
        tokenId = _edition(release, key, artist);
        vm.prank(artist);
        sale.configureSale(tokenId, PRICE, 0, 0, 0, uint64(T0 + 30 days), false);
    }

    function _list(ReleaseMarketplaceV4 market, address token, uint256 tokenId, uint256 price) internal returns (uint256 listingId) {
        vm.prank(HOLDER);
        VoidRelease1155V4Royalty(token).setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        listingId = market.createListing(token, HOLDER, tokenId, 1, price, 0);
    }

    // ---- production factory release on the production marketplace (unchanged path)

    function testProductionFactoryReleaseStillListsAndResellsOnTheProductionMarketplace() public {
        (VoidRelease1155V4Royalty release, VoidPrimarySale sale, uint256 tokenId) = _productionRelease(keccak256("prod"), ARTIST);
        vm.deal(HOLDER, 1 ether);
        vm.prank(HOLDER);
        sale.purchase{value: PRICE}(tokenId, 1);
        // The production sale credits, it does not push: that behaviour is out of scope and unchanged.
        require(NANO.balance == 0 && sale.balances(NANO) == 0.01 ether, "production sale credits the platform");

        uint256 listingId = _list(productionMarket, address(release), tokenId, 1 ether);
        require(productionMarket.getListing(listingId).tokenContract == address(release), "listing names the release address");
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        productionMarket.buy{value: 1 ether}(listingId, 1);
        require(NANO.balance == 0.025 ether && release.balanceOf(BUYER, tokenId) == 1, "resale settled on the production marketplace");
    }

    function testCorrectedFactoryMarketplaceRefusesProductionFactoryReleases() public {
        (VoidRelease1155V4Royalty release, VoidPrimarySale sale, uint256 tokenId) = _productionRelease(keccak256("prod"), ARTIST);
        vm.deal(HOLDER, 1 ether);
        vm.prank(HOLDER);
        sale.purchase{value: PRICE}(tokenId, 1);
        vm.prank(HOLDER);
        release.setApprovalForAll(address(settledMarket), true);
        vm.prank(HOLDER);
        vm.expectRevert(ReleaseMarketplaceV4.UnsupportedRelease.selector);
        settledMarket.createListing(address(release), HOLDER, tokenId, 1, 1 ether, 0);
    }

    // ---- the exact rejection condition for corrected-factory releases

    function testProductionMarketplaceRejectsCorrectedFactoryReleasesBecauseItsRegistryIsTheProductionFactory() public {
        (VoidRelease1155V4Royalty release, VoidPrimarySaleSettled sale, uint256 tokenId) = _settledRelease(settledFactory, keccak256("a"), ARTIST);
        require(address(productionMarket.registry()) == address(productionFactory), "registry is fixed at construction");
        require(settledFactory.isRelease(address(release)) && !productionFactory.isRelease(address(release)), "registered only by its own factory");
        vm.deal(HOLDER, 1 ether);
        vm.prank(HOLDER);
        sale.purchase{value: PRICE}(tokenId, 1);
        vm.prank(HOLDER);
        release.setApprovalForAll(address(productionMarket), true);
        vm.prank(HOLDER);
        vm.expectRevert(ReleaseMarketplaceV4.UnsupportedRelease.selector);
        productionMarket.createListing(address(release), HOLDER, tokenId, 1, 1 ether, 0);
    }

    // ---- two independent corrected-factory collections on one marketplace

    function testTwoCorrectedFactoryCollectionsWithDifferentAddressesBothTradeOnItsMarketplace() public {
        (VoidRelease1155V4Royalty releaseA, VoidPrimarySaleSettled saleA, uint256 tokenA) = _settledRelease(settledFactory, keccak256("a"), ARTIST);
        (VoidRelease1155V4Royalty releaseB, VoidPrimarySaleSettled saleB, uint256 tokenB) = _settledRelease(settledFactory, keccak256("b"), ARTIST2);
        require(address(releaseA) != address(releaseB) && address(releaseA) != address(settledFactory), "distinct collection addresses");
        require(address(saleA) != address(saleB), "each collection has its own sale");

        vm.deal(HOLDER, 2 ether);
        vm.prank(HOLDER);
        saleA.purchase{value: PRICE}(tokenA, 1);
        vm.prank(HOLDER);
        saleB.purchase{value: PRICE}(tokenB, 1);

        uint256 listingA = _list(settledMarket, address(releaseA), tokenA, 1 ether);
        uint256 listingB = _list(settledMarket, address(releaseB), tokenB, 2 ether);
        require(settledMarket.getListing(listingA).tokenContract == address(releaseA), "listing A names collection A");
        require(settledMarket.getListing(listingB).tokenContract == address(releaseB), "listing B names collection B");

        vm.deal(BUYER, 3 ether);
        uint256 artistBefore = ARTIST.balance;
        uint256 artist2Before = ARTIST2.balance;
        vm.prank(BUYER);
        settledMarket.buy{value: 1 ether}(listingA, 1);
        vm.prank(BUYER);
        settledMarket.buy{value: 2 ether}(listingB, 1);
        require(releaseA.balanceOf(BUYER, tokenA) == 1 && releaseB.balanceOf(BUYER, tokenB) == 1, "each token moved on its own contract");
        require(ARTIST.balance - artistBefore == 0.025 ether, "royalty A to artist A");
        require(ARTIST2.balance - artist2Before == 0.05 ether, "royalty B to artist B");
    }

    // ---- collections no canonical factory registered

    function testGenesisLikeCollectionIsRefusedByBothFactoryMarketplaces() public {
        ExternalCollectionStandIn external_ = new ExternalCollectionStandIn(HOLDER, ARTIST);
        vm.prank(HOLDER);
        external_.setApprovalForAll(address(productionMarket), true);
        vm.prank(HOLDER);
        external_.setApprovalForAll(address(settledMarket), true);
        vm.prank(HOLDER);
        vm.expectRevert(ReleaseMarketplaceV4.UnsupportedRelease.selector);
        productionMarket.createListing(address(external_), HOLDER, 0, 1, 1 ether, 0);
        vm.prank(HOLDER);
        vm.expectRevert(ReleaseMarketplaceV4.UnsupportedRelease.selector);
        settledMarket.createListing(address(external_), HOLDER, 0, 1, 1 ether, 0);
    }

    function testCloneFromALookAlikeFactoryIsRefused() public {
        // Same bytecode as the corrected factory, different address: the registry is keyed by address, not code.
        VoidReleaseFactoryV2RoyaltySettled lookAlike = new VoidReleaseFactoryV2RoyaltySettled(NANO);
        (VoidRelease1155V4Royalty release, VoidPrimarySaleSettled sale, uint256 tokenId) = _settledRelease(lookAlike, keccak256("x"), ARTIST);
        vm.deal(HOLDER, 1 ether);
        vm.prank(HOLDER);
        sale.purchase{value: PRICE}(tokenId, 1);
        vm.prank(HOLDER);
        release.setApprovalForAll(address(settledMarket), true);
        vm.prank(HOLDER);
        vm.expectRevert(ReleaseMarketplaceV4.UnsupportedRelease.selector);
        settledMarket.createListing(address(release), HOLDER, tokenId, 1, 1 ether, 0);
    }

    // ---- fees: primary once at purchase, marketplace once per resale

    function testPrimaryFeeIsTakenOnceAndResaleChargesOnlyTheMarketplaceFeeAndRoyalty() public {
        (VoidRelease1155V4Royalty release, VoidPrimarySaleSettled sale, uint256 tokenId) = _settledRelease(settledFactory, keccak256("a"), ARTIST);
        vm.deal(HOLDER, 1 ether);
        vm.prank(HOLDER);
        sale.purchase{value: PRICE}(tokenId, 1);
        require(NANO.balance == 0.01 ether, "2.5% of the primary pushed during purchase");
        require(sale.balances(ARTIST) == 0.39 ether && sale.balances(NANO) == 0, "97.5% claimable; platform never credited");
        require(address(sale).balance == 0.39 ether, "sale holds only the artist's claim");

        uint256 listingId = _list(settledMarket, address(release), tokenId, 1 ether);
        vm.deal(BUYER, 1 ether);
        uint256 sellerBefore = HOLDER.balance;
        vm.prank(BUYER);
        settledMarket.buy{value: 1 ether}(listingId, 1);

        require(NANO.balance == 0.01 ether + 0.025 ether, "platform: one primary fee + one marketplace fee");
        require(ARTIST.balance == 0.025 ether, "artist royalty paid once by the marketplace");
        require(HOLDER.balance - sellerBefore == 0.95 ether, "seller 95%");
        require(sale.balances(ARTIST) == 0.39 ether && address(sale).balance == 0.39 ether, "resale does not touch the primary sale");
        require(address(settledMarket).balance == 0, "marketplace holds nothing");
    }
}
