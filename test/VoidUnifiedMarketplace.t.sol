// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2Royalty} from "../contracts/VoidReleaseFactoryV2Royalty.sol";
import {VoidReleaseFactoryV2RoyaltySettled} from "../contracts/VoidReleaseFactoryV2RoyaltySettled.sol";
import {VoidRelease1155V4Royalty} from "../contracts/VoidRelease1155V4Royalty.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {VoidUnifiedMarketplace} from "../contracts/VoidUnifiedMarketplace.sol";

interface VmUnified {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function assume(bool) external;
}

/// @dev Genesis stand-in (Launchpeg ERC1155SingleBundle with a 500 bps OZ ERC-2981 default royalty) with failure modes.
contract UnifiedMockGenesis {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    address public royaltyReceiver;
    uint256 public royaltyBps = 500;
    // 0 normal, 1 revert, 2 short return, 3 dirty address word, 4 absurd amount, 5 gas burn, 6 no-op transfer
    uint256 public mode;

    constructor(address receiver) { royaltyReceiver = receiver; }
    function mint(address to, uint256 id, uint256 value) external { balanceOf[to][id] += value; }
    function setRoyalty(address receiver, uint256 bps) external { royaltyReceiver = receiver; royaltyBps = bps; }
    function setMode(uint256 m) external { mode = m; }
    function setApprovalForAll(address operator, bool approved) external { isApprovedForAll[msg.sender][operator] = approved; }
    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        if (mode == 1) revert("broken");
        if (mode == 2) assembly { mstore(0, 1) return(0, 32) }
        if (mode == 3) assembly { mstore(0, not(0)) mstore(32, 1) return(0, 64) }
        if (mode == 4) return (royaltyReceiver, price * 2);
        if (mode == 5) { while (true) {} }
        return (royaltyReceiver, (price * royaltyBps) / 10_000);
    }
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external {
        if (from != msg.sender) require(isApprovedForAll[from][msg.sender], "not approved");
        if (mode == 6) return;
        balanceOf[from][id] -= value;
        balanceOf[to][id] += value;
        if (to.code.length > 0) require(UnifiedHook(to).onERC1155Received(msg.sender, from, id, value, data) == 0xf23a6e61, "receiver rejected");
    }
    // Factory-only methods a spoofing collection might add; the Genesis path must never rely on them.
    function royaltyBpsOf(uint256) external pure returns (uint96) { return 250; }
    function payoutOf(uint256) external view returns (address) { return royaltyReceiver; }
}

interface UnifiedHook { function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4); }

contract UnifiedRejectsAvax {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
}

contract UnifiedWrongSelectorBuyer {
    function buy(VoidUnifiedMarketplace m, uint256 id) external payable { m.buy{value: msg.value}(id, 1); }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xdeadbeef; }
}

/// @dev Royalty receiver / seller that tries to re-enter `buy` when paid.
contract UnifiedReentrant {
    VoidUnifiedMarketplace public market;
    uint256 public target;
    bool public reentered;
    function arm(VoidUnifiedMarketplace m, uint256 id) external { market = m; target = id; }
    receive() external payable {
        if (address(market) != address(0) && !reentered) {
            reentered = true;
            market.buy{value: msg.value}(target, 1); // must revert Reentrancy, failing the payout
        }
    }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
}

/// @dev A registry that claims every address is a release; used only to show it is never consulted unless configured.
contract UnifiedLyingRegistry { function isRelease(address) external pure returns (bool) { return true; } }
contract UnifiedRevertingRegistry { function isRelease(address) external pure returns (bool) { revert("nope"); } }

/// @notice Local EVM, nothing deployed or broadcast. Proves the three economic paths by recipient balance deltas.
contract VoidUnifiedMarketplaceTest {
    VmUnified internal constant vm = VmUnified(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant GENESIS_RECEIVER = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant ARTIST = address(0xA7157);
    address internal constant HOLDER = address(0xB0B);
    address internal constant BUYER = address(0xB0B2);
    bytes32 internal constant EDITION_ID = keccak256("edition");
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant PRICE = 0.4 ether;

    VoidReleaseFactoryV2Royalty internal productionFactory;
    VoidReleaseFactoryV2RoyaltySettled internal settledFactory;
    UnifiedMockGenesis internal genesis;
    VoidUnifiedMarketplace internal market;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(T0);
        productionFactory = new VoidReleaseFactoryV2Royalty(NANO);
        settledFactory = new VoidReleaseFactoryV2RoyaltySettled(NANO);
        genesis = new UnifiedMockGenesis(GENESIS_RECEIVER);
        market = new VoidUnifiedMarketplace(NANO, address(settledFactory), address(productionFactory), address(genesis), 3, GENESIS_RECEIVER);
        genesis.mint(HOLDER, 0, 5);
        genesis.mint(HOLDER, 4, 1);
        vm.prank(HOLDER);
        genesis.setApprovalForAll(address(market), true);
    }

    // ------------------------------------------------------------------ helpers

    function _key(address factory, bytes32 app, address artist) internal view returns (bytes32) {
        return keccak256(abi.encode("the-void:studio-release:v2", block.chainid, factory, app, artist));
    }

    function _settledRelease(bytes32 app) internal returns (VoidRelease1155V4Royalty release, VoidPrimarySaleSettled sale, uint256 tokenId) {
        bytes32 key = _key(address(settledFactory), app, ARTIST);
        vm.prank(ARTIST);
        (address r, address s,) = settledFactory.createRelease(app, key, "Release", "REL", "ipfs://release");
        release = VoidRelease1155V4Royalty(r);
        sale = VoidPrimarySaleSettled(s);
        vm.prank(ARTIST);
        tokenId = release.createEditionWithMintEnd(key, EDITION_ID, 0, "ipfs://edition", ARTIST, 250, uint64(T0 + 30 days));
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, 0, uint64(T0 + 30 days), false);
    }

    function _productionRelease(bytes32 app) internal returns (VoidRelease1155V4Royalty release, VoidPrimarySale sale, uint256 tokenId) {
        bytes32 key = _key(address(productionFactory), app, ARTIST);
        vm.prank(ARTIST);
        (address r, address s,) = productionFactory.createRelease(app, key, "Release", "REL", "ipfs://release");
        release = VoidRelease1155V4Royalty(r);
        sale = VoidPrimarySale(s);
        vm.prank(ARTIST);
        tokenId = release.createEditionWithMintEnd(key, EDITION_ID, 0, "ipfs://edition", ARTIST, 250, uint64(T0 + 30 days));
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, 0, uint64(T0 + 30 days), false);
    }

    /// @dev HOLDER buys `qty` on the primary sale, approves the market and lists `qty` at `price`.
    function _listSettled(uint256 qty, uint256 price) internal returns (VoidRelease1155V4Royalty release, uint256 tokenId, uint256 listingId) {
        VoidPrimarySaleSettled sale;
        (release, sale, tokenId) = _settledRelease(keccak256(abi.encode("app", qty, price)));
        vm.deal(HOLDER, PRICE * qty);
        vm.prank(HOLDER);
        sale.purchase{value: PRICE * qty}(tokenId, qty);
        vm.prank(HOLDER);
        release.setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        listingId = market.createListing(address(release), HOLDER, tokenId, qty, price, 0);
    }

    function _listGenesis(uint256 tokenId, uint256 amount, uint256 price) internal returns (uint256 listingId) {
        vm.prank(HOLDER);
        listingId = market.createListing(address(genesis), HOLDER, tokenId, amount, price, 0);
    }

    function _buy(uint256 listingId, uint256 qty, uint256 value) internal {
        vm.deal(BUYER, value);
        vm.prank(BUYER);
        market.buy{value: value}(listingId, qty);
    }

    // ------------------------------------------------------------------ economics: Genesis 0 / 5 / 95

    function testGenesisResalePaysZeroPlatformFullRoyaltyAndSellerBalanceDeltas() public {
        uint256 listingId = _listGenesis(0, 2, 1 ether);
        uint256 nano0 = NANO.balance; uint256 rec0 = GENESIS_RECEIVER.balance; uint256 sel0 = HOLDER.balance;
        _buy(listingId, 2, 2 ether);
        require(NANO.balance - nano0 == 0, "platform 0%");
        require(GENESIS_RECEIVER.balance - rec0 == 0.1 ether, "royalty 5%");
        require(HOLDER.balance - sel0 == 1.9 ether, "seller 95%");
        require(BUYER.balance == 0 && address(market).balance == 0, "nothing retained");
        require(genesis.balanceOf(BUYER, 0) == 2 && genesis.balanceOf(HOLDER, 0) == 3, "delivered");
        require(market.listingStatus(listingId) == VoidUnifiedMarketplace.Status.SOLD, "sold");
        // Genesis royalty configuration untouched by the marketplace.
        require(genesis.royaltyReceiver() == GENESIS_RECEIVER && genesis.royaltyBps() == 500, "genesis unchanged");
    }

    function testGenesisPreviewAndClassification() public view {
        (VoidUnifiedMarketplace.AssetClass c, uint256 fee, address r, uint256 roy, uint256 net) = market.previewSettlement(address(genesis), 3, 1 ether);
        require(c == VoidUnifiedMarketplace.AssetClass.GENESIS && fee == 0 && r == GENESIS_RECEIVER && roy == 0.05 ether && net == 0.95 ether, "preview");
        require(market.assetClassOf(address(genesis), 4) == VoidUnifiedMarketplace.AssetClass.UNSUPPORTED, "id out of range");
    }

    // ------------------------------------------------------------------ economics: factory secondary 2.5 / 2.5 / 95

    function testCorrectedFactoryResalePaysPlatformRoyaltyAndSellerBalanceDeltas() public {
        (VoidRelease1155V4Royalty release, uint256 tokenId, uint256 listingId) = _listSettled(1, 1 ether);
        uint256 nano0 = NANO.balance; uint256 art0 = ARTIST.balance; uint256 sel0 = HOLDER.balance;
        _buy(listingId, 1, 1 ether);
        require(NANO.balance - nano0 == 0.025 ether, "platform 2.5%");
        require(ARTIST.balance - art0 == 0.025 ether, "royalty 2.5%");
        require(HOLDER.balance - sel0 == 0.95 ether, "seller 95%");
        require(release.balanceOf(BUYER, tokenId) == 1 && address(market).balance == 0, "delivered, nothing retained");
    }

    function testProductionFactoryReleaseIsAlsoAcceptedWithFactoryEconomics() public {
        (VoidRelease1155V4Royalty release, VoidPrimarySale sale, uint256 tokenId) = _productionRelease(keccak256("prod"));
        vm.deal(HOLDER, PRICE);
        vm.prank(HOLDER);
        sale.purchase{value: PRICE}(tokenId, 1);
        vm.prank(HOLDER);
        release.setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        uint256 listingId = market.createListing(address(release), HOLDER, tokenId, 1, 2 ether, 0);
        uint256 nano0 = NANO.balance; uint256 art0 = ARTIST.balance; uint256 sel0 = HOLDER.balance;
        _buy(listingId, 1, 2 ether);
        require(NANO.balance - nano0 == 0.05 ether && ARTIST.balance - art0 == 0.05 ether && HOLDER.balance - sel0 == 1.9 ether, "2.5/2.5/95");
    }

    // ------------------------------------------------------------------ economics: primary 2.5 pushed / 97.5 claimable

    function testPrimarySalePushesPlatformFeeAndArtistClaimsOnce() public {
        (, VoidPrimarySaleSettled sale, uint256 tokenId) = _settledRelease(keccak256("primary"));
        uint256 nano0 = NANO.balance;
        vm.deal(BUYER, PRICE * 2);
        vm.prank(BUYER);
        sale.purchase{value: PRICE * 2}(tokenId, 2);
        require(NANO.balance - nano0 == 0.02 ether, "2.5% pushed in the purchase");
        require(sale.balances(ARTIST) == 0.78 ether && address(sale).balance == 0.78 ether, "97.5% claimable, held");
        require(sale.balances(NANO) == 0, "no platform credit");
        vm.prank(BUYER);
        vm.expectRevert(VoidPrimarySaleSettled.NothingToWithdraw.selector);
        sale.withdraw();
        uint256 art0 = ARTIST.balance;
        vm.prank(ARTIST);
        sale.withdraw();
        require(ARTIST.balance - art0 == 0.78 ether && address(sale).balance == 0, "claimed");
        vm.prank(ARTIST);
        vm.expectRevert(VoidPrimarySaleSettled.NothingToWithdraw.selector);
        sale.withdraw();
    }

    function testPrimarySaleRevertsAtomicallyWhenPlatformRejects() public {
        UnifiedRejectsAvax rejecting = new UnifiedRejectsAvax();
        VoidReleaseFactoryV2RoyaltySettled f = new VoidReleaseFactoryV2RoyaltySettled(address(rejecting));
        bytes32 app = keccak256("rej");
        bytes32 key = _key(address(f), app, ARTIST);
        vm.prank(ARTIST);
        (address r, address s,) = f.createRelease(app, key, "R", "R", "ipfs://r");
        vm.prank(ARTIST);
        uint256 tokenId = VoidRelease1155V4Royalty(r).createEditionWithMintEnd(key, EDITION_ID, 0, "ipfs://e", ARTIST, 250, uint64(T0 + 1 days));
        vm.prank(ARTIST);
        VoidPrimarySaleSettled(s).configureSale(tokenId, PRICE, 0, 0, 0, uint64(T0 + 1 days), false);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert();
        VoidPrimarySaleSettled(s).purchase{value: PRICE}(tokenId, 1);
        require(BUYER.balance == PRICE && VoidRelease1155V4Royalty(r).balanceOf(BUYER, tokenId) == 0 && VoidPrimarySaleSettled(s).balances(ARTIST) == 0, "atomic");
    }

    // ------------------------------------------------------------------ rounding

    function testRoundingDustGoesToSellerAndAmountsAlwaysSum() public {
        uint256[5] memory prices = [uint256(1), 39, 41, 399, 1e30];
        for (uint256 i; i < prices.length; i++) {
            (, uint256 f, , uint256 r, uint256 n) = market.previewSettlement(address(genesis), 0, prices[i]);
            require(f == 0 && r == prices[i] * 500 / 10_000 && f + r + n == prices[i], "genesis sums");
        }
        (,, uint256 listingId) = _listSettled(1, 39);
        uint256 nano0 = NANO.balance; uint256 art0 = ARTIST.balance; uint256 sel0 = HOLDER.balance;
        _buy(listingId, 1, 39);
        require(NANO.balance == nano0 && ARTIST.balance == art0 && HOLDER.balance - sel0 == 39, "sub-40-wei: fee and royalty round to 0, seller gets all");
    }

    function testFuzzGenesisSettlementSums(uint256 price) public {
        vm.assume(price > 0 && price < type(uint256).max / 10_000);
        (, uint256 f, , uint256 r, uint256 n) = market.previewSettlement(address(genesis), 1, price);
        require(f == 0 && r == price * 500 / 10_000 && n == price - r, "genesis");
    }

    function testFuzzFactorySettlementSums(uint256 price) public {
        vm.assume(price > 0 && price < type(uint256).max / 10_000);
        (VoidRelease1155V4Royalty release, , uint256 tokenId) = _settledRelease(keccak256(abi.encode(price)));
        (VoidUnifiedMarketplace.AssetClass c, uint256 f, address rr, uint256 r, uint256 n) = market.previewSettlement(address(release), tokenId, price);
        require(c == VoidUnifiedMarketplace.AssetClass.FACTORY_RELEASE && rr == ARTIST, "class");
        require(f == price * 250 / 10_000 && r == price * 250 / 10_000 && f + r + n == price, "factory");
    }

    function testOverflowBoundaryPriceTimesAmountReverts() public {
        vm.prank(HOLDER);
        vm.expectRevert(); // price * amount overflows during validation
        market.createListing(address(genesis), HOLDER, 0, 5, type(uint256).max / 2, 0);
    }

    // ------------------------------------------------------------------ classification and authorization

    function testArbitraryCollectionAndLookAlikeGenesisAreRejected() public {
        UnifiedMockGenesis lookalike = new UnifiedMockGenesis(GENESIS_RECEIVER);
        lookalike.mint(HOLDER, 0, 1);
        vm.prank(HOLDER);
        lookalike.setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        vm.expectRevert(VoidUnifiedMarketplace.UnsupportedAsset.selector);
        market.createListing(address(lookalike), HOLDER, 0, 1, 1 ether, 0);
        vm.expectRevert(VoidUnifiedMarketplace.UnsupportedAsset.selector);
        market.previewSettlement(address(lookalike), 0, 1 ether);
    }

    function testGenesisTokenOutsideRangeIsRejected() public {
        vm.prank(HOLDER);
        vm.expectRevert(VoidUnifiedMarketplace.UnsupportedAsset.selector);
        market.createListing(address(genesis), HOLDER, 4, 1, 1 ether, 0);
    }

    function testCloneFromFakeFactoryIsRejected() public {
        VoidReleaseFactoryV2RoyaltySettled fake = new VoidReleaseFactoryV2RoyaltySettled(NANO);
        bytes32 app = keccak256("fake");
        bytes32 key = _key(address(fake), app, ARTIST);
        vm.prank(ARTIST);
        (address r,,) = fake.createRelease(app, key, "F", "F", "ipfs://f");
        require(market.assetClassOf(r, 1) == VoidUnifiedMarketplace.AssetClass.UNSUPPORTED, "fake factory clone refused");
    }

    function testRevertingRegistryCountsAsUnregisteredAndGenesisStillWorks() public {
        UnifiedRevertingRegistry bad = new UnifiedRevertingRegistry();
        VoidUnifiedMarketplace m = new VoidUnifiedMarketplace(NANO, address(settledFactory), address(bad), address(genesis), 3, GENESIS_RECEIVER);
        (VoidRelease1155V4Royalty release,, uint256 tokenId) = _settledRelease(keccak256("rr"));
        require(m.assetClassOf(address(release), tokenId) == VoidUnifiedMarketplace.AssetClass.FACTORY_RELEASE, "primary registry still consulted");
        require(m.assetClassOf(address(0xdead), 0) == VoidUnifiedMarketplace.AssetClass.UNSUPPORTED, "revert = not registered");
    }

    function testGenesisWinsOverAnyRegistryClaimSoFactoryEconomicsNeverApplyToIt() public {
        UnifiedLyingRegistry liar = new UnifiedLyingRegistry();
        VoidUnifiedMarketplace m = new VoidUnifiedMarketplace(NANO, address(liar), address(0), address(genesis), 3, GENESIS_RECEIVER);
        require(m.assetClassOf(address(genesis), 0) == VoidUnifiedMarketplace.AssetClass.GENESIS, "genesis classified by address first");
        require(m.assetClassOf(address(genesis), 9) == VoidUnifiedMarketplace.AssetClass.UNSUPPORTED, "out-of-range Genesis id not admitted via registry");
    }

    function testFactoryReleaseWithoutRoyaltyPolicyIsRejectedEvenIfRegistered() public {
        // Genesis-shaped royalty at a registered address would be refused: royaltyInfo must equal the 250 bps policy.
        (VoidRelease1155V4Royalty release,, uint256 tokenId) = _settledRelease(keccak256("pol"));
        vm.expectRevert(VoidUnifiedMarketplace.RoyaltyPolicyViolation.selector);
        market.previewSettlement(address(release), tokenId + 99, 1 ether); // unknown edition: royaltyBpsOf 0
    }

    function testConstructorValidation() public {
        vm.expectRevert(VoidUnifiedMarketplace.InvalidAddress.selector);
        new VoidUnifiedMarketplace(address(0), address(settledFactory), address(0), address(genesis), 3, GENESIS_RECEIVER);
        vm.expectRevert(VoidUnifiedMarketplace.InvalidAddress.selector);
        new VoidUnifiedMarketplace(NANO, address(0), address(0), address(genesis), 3, GENESIS_RECEIVER);
        vm.expectRevert(VoidUnifiedMarketplace.InvalidAddress.selector);
        new VoidUnifiedMarketplace(NANO, address(settledFactory), address(settledFactory), address(genesis), 3, GENESIS_RECEIVER);
        vm.expectRevert(VoidUnifiedMarketplace.InvalidAddress.selector);
        new VoidUnifiedMarketplace(NANO, address(settledFactory), address(0), address(settledFactory), 3, GENESIS_RECEIVER);
        vm.expectRevert(VoidUnifiedMarketplace.InvalidAddress.selector);
        new VoidUnifiedMarketplace(NANO, address(settledFactory), address(0), address(genesis), 3, NANO);
        vm.expectRevert(VoidUnifiedMarketplace.InvalidAddress.selector);
        new VoidUnifiedMarketplace(NANO, address(settledFactory), address(0), address(genesis), 3, address(0));
    }

    function testUnauthorizedListingAndCancellation() public {
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.InvalidAddress.selector);
        market.createListing(address(genesis), HOLDER, 0, 1, 1 ether, 0); // listing on someone else's behalf
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.InsufficientBalance.selector);
        market.createListing(address(genesis), BUYER, 0, 1, 1 ether, 0);
        uint256 id = _listGenesis(0, 1, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.NotSeller.selector);
        market.cancelListing(id);
        vm.prank(HOLDER);
        market.cancelListing(id);
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.ListingNotActive.selector);
        market.buy{value: 1 ether}(id, 1);
    }

    // ------------------------------------------------------------------ adversarial ERC-2981 (Genesis path)

    function _expectGenesisBuyRefused(uint256 listingId, bytes4 err) internal {
        uint256 rec0 = GENESIS_RECEIVER.balance; uint256 sel0 = HOLDER.balance;
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(err);
        market.buy{value: 1 ether}(listingId, 1);
        require(GENESIS_RECEIVER.balance == rec0 && HOLDER.balance == sel0 && genesis.balanceOf(BUYER, 0) == 0, "nothing moved");
    }

    function testAdversarialRoyaltyResponsesRefuseGenesisSale() public {
        uint256 id = _listGenesis(0, 1, 1 ether);
        for (uint256 m = 1; m <= 5; m++) {
            genesis.setMode(m);
            _expectGenesisBuyRefused(id, VoidUnifiedMarketplace.RoyaltyPolicyViolation.selector);
        }
        genesis.setMode(0);
        genesis.setRoyalty(address(0xBAD), 500); // redirected receiver (e.g. a proxy upgrade)
        _expectGenesisBuyRefused(id, VoidUnifiedMarketplace.RoyaltyPolicyViolation.selector);
        genesis.setRoyalty(GENESIS_RECEIVER, 600); // excessive
        _expectGenesisBuyRefused(id, VoidUnifiedMarketplace.RoyaltyPolicyViolation.selector);
        genesis.setRoyalty(GENESIS_RECEIVER, 400); // short-changed royalty
        _expectGenesisBuyRefused(id, VoidUnifiedMarketplace.RoyaltyPolicyViolation.selector);
        genesis.setRoyalty(GENESIS_RECEIVER, 500);
        _buy(id, 1, 1 ether);
        require(GENESIS_RECEIVER.balance == 0.05 ether, "recovers once policy holds");
    }

    function testListingRefusedUpFrontWhenRoyaltyBroken() public {
        genesis.setMode(1);
        vm.prank(HOLDER);
        vm.expectRevert(VoidUnifiedMarketplace.RoyaltyPolicyViolation.selector);
        market.createListing(address(genesis), HOLDER, 0, 1, 1 ether, 0);
    }

    // ------------------------------------------------------------------ failed transfers and reentrancy

    function testPlatformRecipientRejectingAvaxRevertsFactorySale() public {
        UnifiedRejectsAvax rejecting = new UnifiedRejectsAvax();
        VoidReleaseFactoryV2RoyaltySettled f = new VoidReleaseFactoryV2RoyaltySettled(NANO);
        VoidUnifiedMarketplace m = new VoidUnifiedMarketplace(address(rejecting), address(f), address(0), address(genesis), 3, GENESIS_RECEIVER);
        bytes32 app = keccak256("plat");
        bytes32 key = _key(address(f), app, ARTIST);
        vm.prank(ARTIST);
        (address r, address s,) = f.createRelease(app, key, "R", "R", "ipfs://r");
        VoidRelease1155V4Royalty release = VoidRelease1155V4Royalty(r);
        vm.prank(ARTIST);
        uint256 tokenId = release.createEditionWithMintEnd(key, EDITION_ID, 0, "ipfs://e", ARTIST, 250, uint64(T0 + 1 days));
        vm.prank(ARTIST);
        VoidPrimarySaleSettled(s).configureSale(tokenId, PRICE, 0, 0, 0, uint64(T0 + 1 days), false);
        vm.deal(HOLDER, PRICE);
        vm.prank(HOLDER);
        VoidPrimarySaleSettled(s).purchase{value: PRICE}(tokenId, 1);
        vm.prank(HOLDER);
        release.setApprovalForAll(address(m), true);
        vm.prank(HOLDER);
        uint256 id = m.createListing(r, HOLDER, tokenId, 1, 1 ether, 0);
        uint256 art0 = ARTIST.balance;
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.TransferFailed.selector);
        m.buy{value: 1 ether}(id, 1);
        require(release.balanceOf(HOLDER, tokenId) == 1 && ARTIST.balance == art0 && m.listingStatus(id) == VoidUnifiedMarketplace.Status.ACTIVE, "atomic");
    }

    function testReentrantRoyaltyReceiverCannotReenterAndSaleReverts() public {
        UnifiedReentrant receiver = new UnifiedReentrant();
        genesis.setRoyalty(address(receiver), 500);
        VoidUnifiedMarketplace m = new VoidUnifiedMarketplace(NANO, address(settledFactory), address(0), address(genesis), 3, address(receiver));
        vm.prank(HOLDER);
        genesis.setApprovalForAll(address(m), true);
        vm.prank(HOLDER);
        uint256 id = m.createListing(address(genesis), HOLDER, 0, 2, 1 ether, 0);
        receiver.arm(m, id);
        vm.deal(address(receiver), 1 ether);
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.TransferFailed.selector);
        m.buy{value: 1 ether}(id, 1);
        require(genesis.balanceOf(BUYER, 0) == 0 && m.getListing(id).amount == 2, "rolled back");
    }

    function testReentrantSellerCannotReenter() public {
        UnifiedReentrant seller = new UnifiedReentrant();
        genesis.mint(address(seller), 1, 2);
        vm.prank(address(seller));
        genesis.setApprovalForAll(address(market), true);
        vm.prank(address(seller));
        uint256 id = market.createListing(address(genesis), address(seller), 1, 2, 1 ether, 0);
        seller.arm(market, id);
        vm.deal(address(seller), 1 ether);
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.TransferFailed.selector);
        market.buy{value: 1 ether}(id, 1);
        require(genesis.balanceOf(address(seller), 1) == 2, "rolled back");
    }

    function testSellerRejectingAvaxRevertsSale() public {
        UnifiedRejectsAvax seller = new UnifiedRejectsAvax();
        genesis.mint(address(seller), 2, 1);
        vm.prank(address(seller));
        genesis.setApprovalForAll(address(market), true);
        vm.prank(address(seller));
        uint256 id = market.createListing(address(genesis), address(seller), 2, 1, 1 ether, 0);
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.TransferFailed.selector);
        market.buy{value: 1 ether}(id, 1);
        require(GENESIS_RECEIVER.balance == 0 && genesis.balanceOf(address(seller), 2) == 1, "atomic");
    }

    function testReceiverRejectingTokensRevertsSale() public {
        uint256 id = _listGenesis(0, 1, 1 ether);
        UnifiedWrongSelectorBuyer b = new UnifiedWrongSelectorBuyer();
        vm.deal(address(b), 1 ether);
        vm.expectRevert();
        b.buy{value: 1 ether}(market, id);
        require(GENESIS_RECEIVER.balance == 0 && genesis.balanceOf(HOLDER, 0) == 5, "atomic");
    }

    function testTokenThatDoesNotDeliverRevertsBeforePayout() public {
        uint256 id = _listGenesis(0, 1, 1 ether);
        genesis.setMode(6);
        // mode 6 also breaks nothing in royaltyInfo (only transfer), so the sale reaches delivery
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.TokensNotDelivered.selector);
        market.buy{value: 1 ether}(id, 1);
        require(GENESIS_RECEIVER.balance == 0 && HOLDER.balance == 0, "no payout");
    }

    // ------------------------------------------------------------------ replay, stale, invalid input

    function testReplayStaleAndInvalidPurchases() public {
        uint256 id = _listGenesis(0, 1, 1 ether);
        vm.deal(BUYER, 3 ether);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.IncorrectPayment.selector);
        market.buy{value: 0.5 ether}(id, 1);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.InsufficientQuantity.selector);
        market.buy{value: 0}(id, 0);
        vm.prank(HOLDER);
        vm.expectRevert(VoidUnifiedMarketplace.SelfPurchase.selector);
        market.buy{value: 0}(id, 1);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(id, 1);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.ListingNotActive.selector);
        market.buy{value: 1 ether}(id, 1); // replay
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.ListingNotActive.selector);
        market.buy{value: 1 ether}(999, 1); // unknown
        vm.expectRevert(VoidUnifiedMarketplace.UnknownListing.selector);
        market.listingStatus(999);

        // Stale: seller moved tokens away / revoked approval after listing.
        uint256 id2 = _listGenesis(0, 4, 0.1 ether);
        vm.prank(HOLDER);
        genesis.setApprovalForAll(address(market), false);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.InsufficientApproval.selector);
        market.buy{value: 0.1 ether}(id2, 1);
        vm.prank(HOLDER);
        genesis.setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        genesis.safeTransferFrom(HOLDER, address(0xCAFE), 0, 4, "");
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.InsufficientBalance.selector);
        market.buy{value: 0.1 ether}(id2, 1);
    }

    function testZeroPriceZeroAmountAndExpiry() public {
        vm.prank(HOLDER);
        vm.expectRevert(VoidUnifiedMarketplace.InvalidPrice.selector);
        market.createListing(address(genesis), HOLDER, 0, 1, 0, 0);
        vm.prank(HOLDER);
        vm.expectRevert(VoidUnifiedMarketplace.InvalidAmount.selector);
        market.createListing(address(genesis), HOLDER, 0, 0, 1 ether, 0);
        vm.prank(HOLDER);
        vm.expectRevert(VoidUnifiedMarketplace.InvalidExpiry.selector);
        market.createListing(address(genesis), HOLDER, 0, 1, 1 ether, uint64(T0));
        vm.prank(HOLDER);
        uint256 id = market.createListing(address(genesis), HOLDER, 0, 1, 1 ether, uint64(T0 + 10));
        vm.expectRevert(VoidUnifiedMarketplace.InvalidExpiry.selector);
        market.expireListing(id);
        vm.warp(T0 + 11);
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(VoidUnifiedMarketplace.Expired.selector);
        market.buy{value: 1 ether}(id, 1);
        market.expireListing(id);
        require(market.listingStatus(id) == VoidUnifiedMarketplace.Status.EXPIRED, "expired");
    }

    function testWrongChainRefused() public {
        uint256 id = _listGenesis(0, 1, 1 ether);
        vm.chainId(1);
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert();
        market.buy{value: 1 ether}(id, 1);
    }

    function testPartialFillsSettleEachPurchaseIndependently() public {
        (VoidRelease1155V4Royalty release, uint256 tokenId, uint256 id) = _listSettled(3, 1 ether);
        uint256 nano0 = NANO.balance; uint256 art0 = ARTIST.balance;
        _buy(id, 1, 1 ether);
        _buy(id, 2, 2 ether);
        require(NANO.balance - nano0 == 0.075 ether && ARTIST.balance - art0 == 0.075 ether, "per-fill fee and royalty, no double charge");
        require(release.balanceOf(BUYER, tokenId) == 3 && market.listingStatus(id) == VoidUnifiedMarketplace.Status.SOLD, "sold out");
    }
}
