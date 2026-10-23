// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV4Sequential} from "../contracts/VoidReleaseFactoryV4Sequential.sol";
import {VoidRelease1155V6Sequential} from "../contracts/VoidRelease1155V6Sequential.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {VoidProvenanceAnchor} from "../contracts/VoidProvenanceAnchor.sol";
import {VoidUnifiedMarketplace} from "../contracts/VoidUnifiedMarketplace.sol";

interface VmSequentialFork {
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function prank(address) external;
    function deal(address, uint256) external;
    function skip(bool) external;
    function expectRevert(bytes calldata) external;
}

interface IGenesisSequentialFork {
    function balanceOf(address, uint256) external view returns (uint256);
    function isApprovedForAll(address, address) external view returns (bool);
}

/// @notice Launch rehearsal for the sequential-ID Forgive & Forget release on a LOCAL fork of Avalanche C-Chain. Nothing is
/// broadcast. Deploys VoidReleaseFactoryV4Sequential and a VoidUnifiedMarketplace bound to it, the production factory 0x262B…
/// and Genesis exactly as deploy/mainnet/SEQUENTIAL-LAUNCH.md plans them, then runs the artist's and collectors' path:
/// createRelease, createEdition(bytes32(1)) => token 1, configureSale(1, ...), a public purchase, a resale on the new
/// marketplace, and checks that the existing marketplace 0x7596… and its live Genesis listing are untouched.
/// Skipped unless MAINNET_FORK_RPC (or MAINNET_FORK_URL) is set. A fork pass shows compatibility with live state at the fork
/// block only; it is not evidence of any mainnet transaction.
contract SequentialLaunchMainnetForkTest {
    VmSequentialFork internal constant vm = VmSequentialFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    IGenesisSequentialFork internal constant GENESIS = IGenesisSequentialFork(0xD1B4367dd9f235f9ee61878019d66E31511E98eE);
    address internal constant PRODUCTION_FACTORY = 0x262B774cf9a1949170B58E2d57F6189980FE757b;
    address internal constant CURRENT_FACTORY = 0xE744D58fA8138042f5f00a28d39f89081539C19B;
    VoidUnifiedMarketplace internal constant EXISTING_MARKET = VoidUnifiedMarketplace(0x75964C44cA586b13e98e7c30E74d2B4114f65b06);
    address internal constant OLD_FNF_CLONE = 0xF9C48A2BBCeBA7577FF17A2eeD20Fcef70eA480d; // 0xE744 clone, hash-derived token
    uint256 internal constant OLD_FNF_TOKEN = 25679935302133066722236771263728427871936411831072189551573738559199048803312;
    address internal constant PLATFORM = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant ARTIST = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant BUYER = address(0xB0B1);
    address internal constant COLLECTOR = address(0xB0B2);
    uint256 internal constant PRICE = 0.01 ether;
    bytes32 internal constant APP = keccak256("forgive-forget-sequential-rehearsal");

    VoidReleaseFactoryV4Sequential internal factory;
    VoidUnifiedMarketplace internal market;
    VoidRelease1155V6Sequential internal release;
    VoidPrimarySaleSettled internal sale;
    VoidProvenanceAnchor internal anchor;
    bytes32 internal releaseKey;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC", vm.envOr("MAINNET_FORK_URL", string("")));
        if (bytes(rpc).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpc);
        forked = true;
        require(block.chainid == 43114, "not C-Chain");
        factory = new VoidReleaseFactoryV4Sequential(PLATFORM);
        market = new VoidUnifiedMarketplace(PLATFORM, address(factory), PRODUCTION_FACTORY, address(GENESIS), 3, ARTIST);
        (release, sale, anchor, releaseKey) = _createRelease(APP, "Forgive & Forget", "FNF");
        vm.deal(BUYER, 10 ether);
        vm.deal(COLLECTOR, 10 ether);
    }

    function _createRelease(bytes32 app, string memory name, string memory symbol)
        internal
        returns (VoidRelease1155V6Sequential r, VoidPrimarySaleSettled s, VoidProvenanceAnchor a, bytes32 key)
    {
        key = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), app, ARTIST));
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress, address anchorAddress) = factory.createRelease(app, key, name, symbol, "ipfs://fnf-contract");
        r = VoidRelease1155V6Sequential(releaseAddress);
        s = VoidPrimarySaleSettled(saleAddress);
        a = VoidProvenanceAnchor(anchorAddress);
    }

    function _publishTokenOne() internal returns (uint256 tokenId) {
        vm.prank(ARTIST);
        tokenId = release.createEdition(releaseKey, bytes32(uint256(1)), 0, "ipfs://fnf-token-1", ARTIST, 250);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, 0, uint64(block.timestamp + 7 days), false);
    }

    function testFirstEditionIsTokenOneWithItsMetadataAndSettledSale() public {
        if (!forked) return;
        require(factory.RELEASE_VERSION() == 4 && factory.implementation() == address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), address(factory), bytes1(0x01)))))), "factory version 4, implementation at its nonce 1");
        require(VoidRelease1155V6Sequential(factory.implementation()).IMPLEMENTATION_VERSION() == 6, "V6 implementation");
        require(release.nextTokenId() == 1 && release.lastTokenId() == 0, "fresh clone starts at 1");
        uint256 tokenId = _publishTokenOne();
        require(tokenId == 1 && release.lastTokenId() == 1 && release.nextTokenId() == 2, "first edition is token 1");
        require(keccak256(bytes(release.uri(1))) == keccak256("ipfs://fnf-token-1"), "token 1 carries its metadata URI");
        require(keccak256(bytes(release.name())) == keccak256("Forgive & Forget") && keccak256(bytes(release.symbol())) == keccak256("FNF"), "collection name and symbol");
        require(release.payoutOf(1) == ARTIST && release.royaltyBpsOf(1) == 250, "2.5% royalty to the artist");
        require(factory.primarySaleOf(address(release)) == address(sale) && release.hasRole(release.ISSUER_ROLE(), address(sale)), "settled sale is the issuer");
        require(!release.hasRole(release.ISSUER_ROLE(), ARTIST), "artist is not an issuer");
    }

    function testStaleOrSkippedIdsRevertWithoutConsumingAndClonesNumberIndependently() public {
        if (!forked) return;
        _publishTokenOne();
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V6Sequential.NonSequentialTokenId.selector, 2, 1));
        release.createEdition(releaseKey, bytes32(uint256(1)), 0, "ipfs://retry", ARTIST, 250);
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V6Sequential.NonSequentialTokenId.selector, 2, 3));
        release.createEdition(releaseKey, bytes32(uint256(3)), 0, "ipfs://skip", ARTIST, 250);
        require(release.lastTokenId() == 1, "reverts consumed nothing");
        // A second release contract has its own numbering, starting at 1.
        (VoidRelease1155V6Sequential other,,, bytes32 otherKey) = _createRelease(keccak256("another-release"), "Another", "ANR");
        vm.prank(ARTIST);
        require(other.createEdition(otherKey, bytes32(uint256(1)), 0, "ipfs://other-1", ARTIST, 250) == 1, "second clone starts at 1");
        vm.prank(ARTIST);
        require(release.createEdition(releaseKey, bytes32(uint256(2)), 0, "ipfs://fnf-token-2", ARTIST, 250) == 2, "next edition is 2");
    }

    function testPublicPurchaseThenResaleOnTheNewMarketplace() public {
        if (!forked) return;
        _publishTokenOne();
        uint256 platformBefore = PLATFORM.balance;
        vm.prank(BUYER);
        sale.purchase{value: PRICE}(1, 1);
        require(release.balanceOf(BUYER, 1) == 1, "buyer holds token 1");
        require(PLATFORM.balance - platformBefore == (PRICE * 250) / 10_000, "2.5% platform paid in the purchase");
        require(sale.balances(ARTIST) == PRICE - (PRICE * 250) / 10_000, "97.5% credited to the artist");
        require(market.assetClassOf(address(release), 1) == VoidUnifiedMarketplace.AssetClass.FACTORY_RELEASE, "new marketplace accepts token 1");
        vm.prank(BUYER);
        release.setApprovalForAll(address(market), true);
        vm.prank(BUYER);
        uint256 listingId = market.createListing(address(release), BUYER, 1, 1, 1 ether, 0);
        uint256 p = PLATFORM.balance; uint256 a = ARTIST.balance; uint256 s = BUYER.balance;
        vm.prank(COLLECTOR);
        market.buy{value: 1 ether}(listingId, 1);
        require(release.balanceOf(COLLECTOR, 1) == 1 && release.balanceOf(BUYER, 1) == 0, "token 1 delivered");
        require(PLATFORM.balance - p == 0.025 ether && ARTIST.balance - a == 0.025 ether && BUYER.balance - s == 0.95 ether, "2.5 / 2.5 / 95 resale split");
    }

    function testProvenanceAnchorBindsTokenOne() public {
        if (!forked) return;
        _publishTokenOne();
        bytes32 root = keccak256("fnf-provenance-root");
        require(factory.provenanceAnchorOf(address(release)) == address(anchor), "anchor registered");
        vm.prank(ARTIST);
        anchor.anchor(releaseKey, bytes32(uint256(1)), root);
        require(anchor.isAnchored(releaseKey, bytes32(uint256(1)), root), "token 1 provenance anchored");
    }

    function testAssetClassesOnBothMarketplacesAndTheExistingGenesisListing() public {
        if (!forked) return;
        _publishTokenOne();
        // New marketplace: Genesis by contract, the new clone as a factory release, the retired 0xE744 clone unsupported.
        require(market.assetClassOf(address(GENESIS), 1) == VoidUnifiedMarketplace.AssetClass.GENESIS, "Genesis token 1 is Genesis");
        require(market.assetClassOf(address(release), 1) == VoidUnifiedMarketplace.AssetClass.FACTORY_RELEASE, "release token 1 is a factory release");
        require(market.assetClassOf(OLD_FNF_CLONE, OLD_FNF_TOKEN) == VoidUnifiedMarketplace.AssetClass.UNSUPPORTED, "0xE744 clone not on the new marketplace");
        // Existing marketplace: unchanged classification; it does not know the new factory.
        require(address(EXISTING_MARKET.releaseFactory()) == CURRENT_FACTORY && address(EXISTING_MARKET.legacyReleaseFactory()) == PRODUCTION_FACTORY, "existing registries unchanged");
        require(EXISTING_MARKET.assetClassOf(address(GENESIS), 0) == VoidUnifiedMarketplace.AssetClass.GENESIS, "existing: Genesis");
        require(EXISTING_MARKET.assetClassOf(OLD_FNF_CLONE, OLD_FNF_TOKEN) == VoidUnifiedMarketplace.AssetClass.FACTORY_RELEASE, "existing: 0xE744 clone");
        require(EXISTING_MARKET.assetClassOf(address(release), 1) == VoidUnifiedMarketplace.AssetClass.UNSUPPORTED, "existing marketplace refuses the new clone");
        // Its live Genesis listing (id 1: token 0, 0.01 AVAX) is untouched by the new deployment.
        VoidUnifiedMarketplace.Listing memory listing = EXISTING_MARKET.getListing(1);
        require(listing.tokenContract == address(GENESIS) && listing.tokenId == 0 && listing.price == 0.01 ether && listing.amount == 1, "listing 1 unchanged");
        require(EXISTING_MARKET.listingStatus(1) == VoidUnifiedMarketplace.Status.ACTIVE, "listing 1 still active");
    }

    function testExistingGenesisListingStillSettlesOnTheExistingMarketplace() public {
        if (!forked) return;
        VoidUnifiedMarketplace.Listing memory listing = EXISTING_MARKET.getListing(1);
        if (GENESIS.balanceOf(listing.seller, 0) == 0 || !GENESIS.isApprovedForAll(listing.seller, address(EXISTING_MARKET))) return; // seller no longer able to deliver
        vm.prank(COLLECTOR);
        EXISTING_MARKET.buy{value: listing.price}(1, 1);
        require(GENESIS.balanceOf(COLLECTOR, 0) == 1, "existing Genesis listing still buyable");
    }
}
