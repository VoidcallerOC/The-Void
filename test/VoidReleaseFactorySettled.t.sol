// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2Royalty} from "../contracts/VoidReleaseFactoryV2Royalty.sol";
import {VoidReleaseFactoryV2RoyaltySettled} from "../contracts/VoidReleaseFactoryV2RoyaltySettled.sol";
import {VoidRelease1155V4Royalty} from "../contracts/VoidRelease1155V4Royalty.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {ReleaseMarketplaceV4} from "../contracts/ReleaseMarketplaceV4.sol";

interface VmFactorySettled {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract FactoryRejectingPlatform {
    receive() external payable {
        revert("no AVAX");
    }
}

/// @notice The corrected factory on a local EVM (nothing here is a mainnet deployment): every release it
/// creates sells through a VoidPrimarySaleSettled, so the platform's 2.5% is paid during the purchase and
/// the artist's 97.5% stays a withdrawable balance. Also shows what it does NOT do: it does not touch the
/// production factory or its releases, and the production marketplace does not recognise its releases.
contract VoidReleaseFactorySettledTest {
    VmFactorySettled internal constant vm = VmFactorySettled(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant ARTIST = address(0xA7157);
    address internal constant BUYER = address(0xB0B);
    address internal constant BUYER2 = address(0xB0B2);
    bytes32 internal constant APP = keccak256("forgive-and-forget-replacement");
    bytes32 internal constant EDITION_ID = keccak256("forgive-and-forget");
    uint256 internal constant T0 = 1_800_000_000;

    VoidReleaseFactoryV2RoyaltySettled internal factory;
    VoidReleaseFactoryV2Royalty internal productionFactory;
    ReleaseMarketplaceV4 internal market;
    ReleaseMarketplaceV4 internal productionMarket;
    VoidRelease1155V4Royalty internal release;
    VoidPrimarySaleSettled internal sale;
    bytes32 internal releaseKey;
    uint256 internal tokenId;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(T0);
        factory = new VoidReleaseFactoryV2RoyaltySettled(NANO);
        productionFactory = new VoidReleaseFactoryV2Royalty(NANO);
        market = new ReleaseMarketplaceV4(NANO, 250, address(factory));
        productionMarket = new ReleaseMarketplaceV4(NANO, 250, address(productionFactory));
        (release, sale, releaseKey, tokenId) = _newRelease(factory, 0.4 ether);
    }

    function _newRelease(VoidReleaseFactoryV2RoyaltySettled f, uint256 price)
        internal
        returns (VoidRelease1155V4Royalty r, VoidPrimarySaleSettled s, bytes32 key, uint256 id)
    {
        key = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(f), APP, ARTIST));
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = f.createRelease(APP, key, "Forgive & Forget", "FNF", "ipfs://fnf");
        r = VoidRelease1155V4Royalty(releaseAddress);
        s = VoidPrimarySaleSettled(saleAddress);
        vm.prank(ARTIST);
        id = r.createEditionWithMintEnd(key, EDITION_ID, 0, "ipfs://fnf-edition", ARTIST, 250, uint64(T0 + 30 days));
        vm.prank(ARTIST);
        s.configureSale(id, price, 0, 0, 0, uint64(T0 + 30 days), false);
    }

    // ---- the corrected factory wires the settled sale

    function testFactoryRegistersTheSettledSaleAndTheReleaseAuthorizesIt() public view {
        require(factory.primarySaleOf(address(release)) == address(sale), "registry names the settled sale");
        require(address(sale.releases()) == address(release) && sale.platformRecipient() == NANO, "sale bound to this release and the platform wallet");
        require(sale.PLATFORM_FEE_BPS() == 250 && factory.PLATFORM_FEE_BPS() == 250, "fee 250 bps");
        require(release.hasRole(release.ISSUER_ROLE(), address(sale)), "the sale is the release's issuer");
        require(factory.isRelease(address(release)) && factory.artistOf(address(release)) == ARTIST, "release registered to the artist");
        (bool hasOwner,) = address(sale).staticcall(abi.encodeWithSignature("owner()"));
        require(!hasOwner, "no owner: the fee cannot be changed");
    }

    function testFactoryKeepsTheProductionReleaseRulesAndVersion() public view {
        require(factory.RELEASE_VERSION() == productionFactory.RELEASE_VERSION(), "same release version");
        require(factory.REQUIRED_ROYALTY_BPS() == productionFactory.REQUIRED_ROYALTY_BPS(), "same locked royalty");
        require(factory.platformRecipient() == productionFactory.platformRecipient(), "same platform recipient");
    }

    function testRoyaltyIsLockedAndCannotPointAtThePlatform() public {
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V4Royalty.RoyaltyPolicyViolation.selector, 500, 250));
        release.createEditionWithMintEnd(releaseKey, keccak256("e2"), 0, "ipfs://e2", ARTIST, 500, uint64(T0 + 30 days));
        vm.prank(ARTIST);
        vm.expectRevert(abi.encodeWithSelector(VoidRelease1155V4Royalty.UnauthorizedRoyaltyRecipient.selector, NANO));
        release.createEditionWithMintEnd(releaseKey, keccak256("e3"), 0, "ipfs://e3", NANO, 250, uint64(T0 + 30 days));
    }

    // ---- primary sale: 2.5% pushed during the purchase, 97.5% claimable

    function testPurchasePaysExactlyTwoAndAHalfPercentToThePlatformDuringThePurchase() public {
        uint256 platformBefore = NANO.balance;
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        sale.purchase{value: 0.8 ether}(tokenId, 2);
        require(NANO.balance - platformBefore == 0.02 ether, "platform wallet received exactly 2.5% of 0.8 AVAX");
        require(sale.balances(NANO) == 0, "the platform share is never an internal credit");
        require(sale.balances(ARTIST) == 0.78 ether, "artist credited exactly 97.5%");
        require(address(sale).balance == 0.78 ether, "the sale holds only the artist share");
        require(release.balanceOf(BUYER, tokenId) == 2, "buyer owns the token");
    }

    function testArtistClaimsTheirShareAndNobodyElseCan() public {
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        sale.purchase{value: 0.4 ether}(tokenId, 1);

        vm.prank(BUYER);
        vm.expectRevert(VoidPrimarySaleSettled.NothingToWithdraw.selector);
        sale.withdraw();
        vm.prank(NANO);
        vm.expectRevert(VoidPrimarySaleSettled.NothingToWithdraw.selector);
        sale.withdraw();

        uint256 before = ARTIST.balance;
        vm.prank(ARTIST);
        sale.withdraw();
        require(ARTIST.balance - before == 0.39 ether && address(sale).balance == 0, "artist claims exactly 97.5%");
    }

    function testRoundingNeverShortsThePlatformBeyondFlooringAndAlwaysSumsToThePayment() public {
        uint256[7] memory prices = [uint256(1), 39, 40, 41, 999_999_999_999_999_999, 1 ether + 1, 3 ether + 7];
        for (uint256 i = 0; i < prices.length; i++) {
            VoidReleaseFactoryV2RoyaltySettled f = new VoidReleaseFactoryV2RoyaltySettled(NANO);
            (VoidRelease1155V4Royalty r, VoidPrimarySaleSettled s,, uint256 id) = _newRelease(f, prices[i]);
            uint256 expectedPlatform = (prices[i] * 250) / 10_000;
            uint256 platformBefore = NANO.balance;
            vm.deal(BUYER, prices[i]);
            vm.prank(BUYER);
            s.purchase{value: prices[i]}(id, 1);
            require(NANO.balance - platformBefore == expectedPlatform, "platform receives floor(2.5%)");
            require(s.balances(ARTIST) == prices[i] - expectedPlatform, "artist receives the exact remainder");
            require(NANO.balance - platformBefore + s.balances(ARTIST) == prices[i], "the split sums to the payment");
            require(r.balanceOf(BUYER, id) == 1, "minted");
        }
    }

    function testPlatformTransferFailureRevertsThePurchaseWithNoPartialSettlement() public {
        FactoryRejectingPlatform bad = new FactoryRejectingPlatform();
        VoidReleaseFactoryV2RoyaltySettled f = new VoidReleaseFactoryV2RoyaltySettled(address(bad));
        (VoidRelease1155V4Royalty r, VoidPrimarySaleSettled s,, uint256 id) = _newRelease(f, 0.4 ether);
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        (bool ok,) = address(s).call{value: 0.4 ether}(abi.encodeCall(s.purchase, (id, 1)));
        require(!ok, "the purchase must not succeed");
        require(r.balanceOf(BUYER, id) == 0, "no token minted");
        require(s.balances(ARTIST) == 0 && s.balances(address(bad)) == 0, "no credit recorded");
        (,, uint256 sold,,,,,) = s.sales(id);
        require(sold == 0 && s.walletPurchased(id, BUYER) == 0, "no sale recorded");
        require(address(s).balance == 0 && BUYER.balance == 1 ether, "the buyer keeps the AVAX");
    }

    function testWrongPaymentRevertsWithoutSettlement() public {
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSelector(VoidPrimarySaleSettled.WrongPayment.selector, 0.4 ether, 0.3 ether));
        sale.purchase{value: 0.3 ether}(tokenId, 1);
        require(NANO.balance == 0 && address(sale).balance == 0, "nothing moved");
    }

    // ---- secondary sale on the matching marketplace

    function testResaleOnTheMarketplaceBuiltForThisFactorySplits95_2p5_2p5() public {
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        sale.purchase{value: 0.4 ether}(tokenId, 1);

        vm.prank(BUYER);
        release.setApprovalForAll(address(market), true);
        vm.prank(BUYER);
        uint256 listingId = market.createListing(address(release), BUYER, tokenId, 1, 1 ether, 0);

        vm.deal(BUYER2, 1 ether);
        uint256 platformBefore = NANO.balance;
        uint256 artistBefore = ARTIST.balance;
        uint256 sellerBefore = BUYER.balance;
        vm.prank(BUYER2);
        market.buy{value: 1 ether}(listingId, 1);
        require(NANO.balance - platformBefore == 0.025 ether, "platform 2.5%");
        require(ARTIST.balance - artistBefore == 0.025 ether, "artist royalty 2.5%");
        require(BUYER.balance - sellerBefore == 0.95 ether, "seller 95%");
        require(release.balanceOf(BUYER2, tokenId) == 1 && address(market).balance == 0, "ownership moved; market holds nothing");
    }

    function testTheProductionMarketplaceDoesNotRecogniseReleasesFromTheNewFactory() public {
        require(!productionFactory.isRelease(address(release)), "the production factory never registered it");
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        sale.purchase{value: 0.4 ether}(tokenId, 1);
        vm.prank(BUYER);
        release.setApprovalForAll(address(productionMarket), true);
        vm.prank(BUYER);
        vm.expectRevert(ReleaseMarketplaceV4.UnsupportedRelease.selector);
        productionMarket.createListing(address(release), BUYER, tokenId, 1, 1 ether, 0);
    }
}
