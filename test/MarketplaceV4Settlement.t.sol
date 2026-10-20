// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2Royalty} from "../contracts/VoidReleaseFactoryV2Royalty.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {ReleaseMarketplaceV4} from "../contracts/ReleaseMarketplaceV4.sol";

interface VmSettlement {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address) external;
    function deal(address, uint256) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// @dev A wallet or contract that refuses native AVAX, and can also act as a seller.
contract SettlementRejectingWallet {
    receive() external payable {
        revert("no AVAX");
    }

    function approveToken(address token, address operator) external {
        SettlementPolicyToken(token).setApprovalForAll(operator, true);
    }

    function list(address market, address token, uint256 id, uint256 amount, uint256 price) external returns (uint256) {
        return ReleaseMarketplaceV4(market).createListing(token, address(this), id, amount, price, 0);
    }
}

/// @dev A royalty receiver that tries to buy the same listing again while being paid.
contract SettlementReentrantReceiver {
    ReleaseMarketplaceV4 public market;
    uint256 public listingId;
    uint256 public price;
    bool public swallow;
    bool public attempted;
    bool public reentered;

    function arm(ReleaseMarketplaceV4 market_, uint256 listingId_, uint256 price_, bool swallow_) external {
        market = market_;
        listingId = listingId_;
        price = price_;
        swallow = swallow_;
    }

    receive() external payable {
        attempted = true;
        if (swallow) {
            try market.buy{value: price}(listingId, 1) {
                reentered = true;
            } catch {}
        } else {
            market.buy{value: price}(listingId, 1);
            reentered = true;
        }
    }
}

/// @dev A registry that vouches for any token, and a token with a controllable royalty policy: stand-ins
/// used only to drive settlement paths the real V4Royalty release refuses to create.
contract SettlementPermissiveRegistry {
    function isRelease(address) external pure returns (bool) {
        return true;
    }
}

contract SettlementPolicyToken {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    uint96 public bps = 250;
    address public payout;
    address public reportedReceiver;

    constructor(address payout_) {
        payout = payout_;
        reportedReceiver = payout_;
    }

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[to][id] += amount;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function setPolicy(uint96 bps_, address payout_) external {
        bps = bps_;
        payout = payout_;
        reportedReceiver = payout_;
    }

    function royaltyBpsOf(uint256) external view returns (uint96) {
        return bps;
    }

    function payoutOf(uint256) external view returns (address) {
        return payout;
    }

    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        return (reportedReceiver, (price * bps) / 10_000);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata) external {
        balanceOf[from][id] -= value;
        balanceOf[to][id] += value;
    }
}

/// @notice Secondary-sale settlement on the real marketplace path: VoidReleaseFactoryV2Royalty clones,
/// ReleaseMarketplaceV4 and the 2.5% fee / 2.5% edition-payout royalty / 95% seller split. Every assertion
/// checks real balances. Local EVM fixtures only: nothing here touches a live network.
contract MarketplaceV4SettlementTest {
    VmSettlement internal constant vm = VmSettlement(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant PLATFORM = address(0xFEE5);
    address internal constant ARTIST = address(0xA11CE);
    address internal constant PAYOUT = address(0xA11CE2); // an artist wallet of the release, not the edition artist
    address internal constant SELLER = address(0xC011);
    address internal constant BUYER = address(0xB0B);
    bytes32 internal constant LISTING_SOLD = keccak256("ListingSold(uint256,address,address,address,uint256,uint256,uint256,uint256,uint256)");

    VoidReleaseFactoryV2Royalty internal factory;
    ReleaseMarketplaceV4 internal market;

    function setUp() public {
        factory = new VoidReleaseFactoryV2Royalty(PLATFORM);
        market = new ReleaseMarketplaceV4(PLATFORM, 250, address(factory));
    }

    // ------------------------------------------------------------------ helpers

    function _release(VoidReleaseFactoryV2Royalty f, address artist, address payout, bytes32 appId)
        internal
        returns (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId)
    {
        bytes32 key = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(f), appId, artist));
        vm.prank(artist);
        (address releaseContract, address primarySale,) = f.createRelease(appId, key, "Release", "REL", "ipfs://release");
        clone = VoidRelease1155V4(releaseContract);
        sale = VoidPrimarySale(primarySale);
        if (payout != artist) {
            bytes32 role = clone.ARTIST_ROLE();
            vm.prank(artist);
            clone.grantRole(role, payout);
        }
        vm.prank(artist);
        tokenId = clone.createEdition(key, bytes32("edition"), 100, "ipfs://edition", payout, 250);
        vm.prank(artist);
        sale.configureSale(tokenId, 1 ether, 100, 100, 0, 0, false);
    }

    function _primaryBuy(VoidPrimarySale sale, uint256 tokenId, address to, uint256 qty) internal {
        vm.deal(to, qty * 1 ether);
        vm.prank(to);
        sale.purchase{value: qty * 1 ether}(tokenId, qty);
    }

    function _list(VoidRelease1155V4 clone, uint256 tokenId, address seller, uint256 amount, uint256 price) internal returns (uint256) {
        vm.prank(seller);
        clone.setApprovalForAll(address(market), true);
        vm.prank(seller);
        return market.createListing(address(clone), seller, tokenId, amount, price, 0);
    }

    function _try(address target, uint256 value, bytes memory data) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call{value: value}(data);
    }

    function _selector(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            sel := mload(add(ret, 0x20))
        }
    }

    function _buyCall(ReleaseMarketplaceV4 m, uint256 listingId, uint256 qty) internal pure returns (bytes memory) {
        return abi.encodeCall(m.buy, (listingId, qty));
    }

    // ------------------------------------------------------------------ exact split

    struct Snap {
        uint256 platform;
        uint256 payout;
        uint256 artist;
        uint256 seller;
        uint256 buyer;
        uint256 owned;
    }

    function _snap(VoidRelease1155V4 clone, uint256 tokenId) internal view returns (Snap memory x) {
        x = Snap(PLATFORM.balance, PAYOUT.balance, ARTIST.balance, SELLER.balance, BUYER.balance, clone.balanceOf(BUYER, tokenId));
    }

    function _fillAndAssert(VoidRelease1155V4 clone, uint256 tokenId, uint256 price, uint256 qty) internal {
        uint256 salePrice = price * qty;
        uint256 fee = (salePrice * 250) / 10_000;
        uint256 listingId = _list(clone, tokenId, SELLER, qty, price);
        vm.deal(BUYER, salePrice);
        Snap memory before = _snap(clone, tokenId);
        vm.prank(BUYER);
        market.buy{value: salePrice}(listingId, qty);
        require(PLATFORM.balance - before.platform == fee, "fee is floor(2.5% of the sale price)");
        require(PAYOUT.balance - before.payout == fee, "royalty is floor(2.5%) to the edition payout");
        require(SELLER.balance - before.seller == salePrice - fee - fee, "seller receives the exact remainder");
        require(ARTIST.balance == before.artist, "the edition artist wallet is not paid when the payout differs");
        require(before.buyer - BUYER.balance == salePrice, "buyer pays exactly the sale price");
        require(address(market).balance == 0, "the marketplace never keeps funds");
        require(clone.balanceOf(BUYER, tokenId) == before.owned + qty, "buyer receives the quantity");
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV4.Status.SOLD), "listing sold");
    }

    function testExactSplitAcrossPricesAndQuantitiesIncludingRounding() public {
        (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) = _release(factory, ARTIST, PAYOUT, "app-split");
        _primaryBuy(sale, tokenId, SELLER, 30);
        uint256[6] memory prices = [uint256(1 ether), 0.333333333333333333 ether, 1_234_567 wei, 101 wei, 40 wei, 3 ether];
        uint256[6] memory qtys = [uint256(1), 3, 2, 5, 4, 2];
        for (uint256 i; i < prices.length; ++i) {
            _fillAndAssert(clone, tokenId, prices[i], qtys[i]);
        }
    }

    function testPartialFillsSettleEachFillOnItsOwnPrice() public {
        (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) = _release(factory, ARTIST, PAYOUT, "app-partial");
        _primaryBuy(sale, tokenId, SELLER, 5);
        uint256 listingId = _list(clone, tokenId, SELLER, 5, 2 ether);
        vm.deal(BUYER, 10 ether);
        uint256 platformBefore = PLATFORM.balance;
        uint256 payoutBefore = PAYOUT.balance;
        uint256 sellerBefore = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: 4 ether}(listingId, 2);
        require(PLATFORM.balance - platformBefore == 0.1 ether && PAYOUT.balance - payoutBefore == 0.1 ether && SELLER.balance - sellerBefore == 3.8 ether, "first fill 2.5/2.5/95");
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV4.Status.ACTIVE) && market.getListing(listingId).amount == 3, "listing stays active with 3 left");
        vm.prank(BUYER);
        market.buy{value: 6 ether}(listingId, 3);
        require(PLATFORM.balance - platformBefore == 0.25 ether && PAYOUT.balance - payoutBefore == 0.25 ether && SELLER.balance - sellerBefore == 9.5 ether, "totals after both fills");
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV4.Status.SOLD), "sold after the last unit");
    }

    function testRoyaltyGoesToTheEditionPayoutNeverToTheEditionArtistOrThePlatform() public {
        (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) = _release(factory, ARTIST, PAYOUT, "app-payout");
        (address receiver, uint256 amount) = clone.royaltyInfo(tokenId, 1 ether);
        require(receiver == PAYOUT && receiver != ARTIST && receiver != PLATFORM && amount == 0.025 ether, "ERC-2981 names the edition payout");
        _primaryBuy(sale, tokenId, SELLER, 1);
        uint256 listingId = _list(clone, tokenId, SELLER, 1, 1 ether);
        uint256 artistBefore = ARTIST.balance;
        uint256 payoutBefore = PAYOUT.balance;
        uint256 platformBefore = PLATFORM.balance;
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(listingId, 1);
        require(PAYOUT.balance - payoutBefore == 0.025 ether, "payout received the royalty");
        require(ARTIST.balance == artistBefore, "the edition artist wallet received nothing");
        require(PLATFORM.balance - platformBefore == 0.025 ether, "platform received only its own 2.5%, not the royalty");
    }

    // ------------------------------------------------------------------ royalty policy

    function testPolicyViolationsAreRefusedAtListingAndAtSettlementMovingNothing() public {
        SettlementPermissiveRegistry registry = new SettlementPermissiveRegistry();
        ReleaseMarketplaceV4 open = new ReleaseMarketplaceV4(PLATFORM, 250, address(registry));
        SettlementPolicyToken token = new SettlementPolicyToken(ARTIST);
        token.mint(SELLER, 1, 2);
        vm.prank(SELLER);
        token.setApprovalForAll(address(open), true);
        vm.deal(BUYER, 10 ether);

        // Refused at listing: wrong rate, platform payout, zero payout. No listing id is consumed.
        uint96[3] memory badBps = [uint96(500), 250, 250];
        address[3] memory badPayout = [ARTIST, PLATFORM, address(0)];
        for (uint256 i; i < 3; ++i) {
            token.setPolicy(badBps[i], badPayout[i]);
            vm.prank(SELLER);
            (bool ok, bytes memory ret) = _try(address(open), 0, abi.encodeCall(open.createListing, (address(token), SELLER, 1, 1, 1 ether, 0)));
            require(!ok && _selector(ret) == ReleaseMarketplaceV4.RoyaltyPolicyViolation.selector, "listing refused with RoyaltyPolicyViolation");
        }
        require(open.nextListingId() == 1, "no listing was created");

        // Compliant at listing, then the policy changes: settlement refuses and moves nothing.
        token.setPolicy(250, ARTIST);
        vm.prank(SELLER);
        uint256 listingId = open.createListing(address(token), SELLER, 1, 2, 1 ether, 0);
        for (uint256 i; i < 3; ++i) {
            token.setPolicy(badBps[i], badPayout[i]);
            uint256 buyerBefore = BUYER.balance;
            uint256 sellerBefore = SELLER.balance;
            uint256 platformBefore = PLATFORM.balance;
            uint256 artistBefore = ARTIST.balance;
            vm.prank(BUYER);
            (bool ok, bytes memory ret) = _try(address(open), 1 ether, _buyCall(open, listingId, 1));
            require(!ok && _selector(ret) == ReleaseMarketplaceV4.RoyaltyPolicyViolation.selector, "settlement refused with RoyaltyPolicyViolation");
            require(BUYER.balance == buyerBefore && SELLER.balance == sellerBefore && PLATFORM.balance == platformBefore && ARTIST.balance == artistBefore && address(open).balance == 0, "no funds moved");
            require(token.balanceOf(SELLER, 1) == 2 && token.balanceOf(BUYER, 1) == 0, "no tokens moved");
            require(uint8(open.listingStatus(listingId)) == uint8(ReleaseMarketplaceV4.Status.ACTIVE) && open.getListing(listingId).amount == 2, "listing still active and intact");
        }
    }

    // ------------------------------------------------------------------ atomic failure of every recipient

    // which: 0 = fee recipient rejects, 1 = royalty receiver rejects, 2 = seller rejects
    function _rejection(uint8 which) internal {
        SettlementRejectingWallet rejecter = new SettlementRejectingWallet();
        SettlementPermissiveRegistry registry = new SettlementPermissiveRegistry();
        address feeRecipient = which == 0 ? address(rejecter) : PLATFORM;
        address payout = which == 1 ? address(rejecter) : ARTIST;
        address seller = which == 2 ? address(rejecter) : SELLER;
        ReleaseMarketplaceV4 m = new ReleaseMarketplaceV4(feeRecipient, 250, address(registry));
        SettlementPolicyToken token = new SettlementPolicyToken(payout);
        token.mint(seller, 1, 3);
        uint256 listingId;
        if (which == 2) {
            rejecter.approveToken(address(token), address(m));
            listingId = rejecter.list(address(m), address(token), 1, 3, 1 ether);
        } else {
            vm.prank(seller);
            token.setApprovalForAll(address(m), true);
            vm.prank(seller);
            listingId = m.createListing(address(token), seller, 1, 3, 1 ether, 0);
        }
        vm.deal(BUYER, 5 ether);
        uint256 buyerBefore = BUYER.balance;
        uint256 feeBefore = feeRecipient.balance;
        uint256 payoutBefore = payout.balance;
        uint256 sellerBefore = seller.balance;
        vm.prank(BUYER);
        (bool ok, bytes memory ret) = _try(address(m), 2 ether, _buyCall(m, listingId, 2));
        require(!ok && _selector(ret) == ReleaseMarketplaceV4.TransferFailed.selector, "a rejected share reverts the whole buy with TransferFailed");
        require(BUYER.balance == buyerBefore && address(m).balance == 0, "buyer keeps the AVAX and the marketplace holds none");
        require(feeRecipient.balance == feeBefore && payout.balance == payoutBefore && seller.balance == sellerBefore, "no recipient was partially paid");
        require(token.balanceOf(seller, 1) == 3 && token.balanceOf(BUYER, 1) == 0, "tokens did not move");
        require(uint8(m.listingStatus(listingId)) == uint8(ReleaseMarketplaceV4.Status.ACTIVE) && m.getListing(listingId).amount == 3, "listing still ACTIVE with its full amount");
    }

    function testFeeRecipientRejectingRevertsTheWholeBuy() public {
        _rejection(0);
    }

    function testRoyaltyReceiverRejectingRevertsTheWholeBuy() public {
        _rejection(1);
    }

    function testSellerRejectingRevertsTheWholeBuy() public {
        _rejection(2);
    }

    function testRoyaltyReceiverRejectingOnTheRealReleasePathRevertsTheWholeBuy() public {
        SettlementRejectingWallet rejecter = new SettlementRejectingWallet();
        (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) = _release(factory, ARTIST, address(rejecter), "app-reject");
        _primaryBuy(sale, tokenId, SELLER, 2);
        uint256 listingId = _list(clone, tokenId, SELLER, 2, 1 ether);
        vm.deal(BUYER, 1 ether);
        uint256 platformBefore = PLATFORM.balance;
        uint256 sellerBefore = SELLER.balance;
        vm.prank(BUYER);
        (bool ok, bytes memory ret) = _try(address(market), 1 ether, _buyCall(market, listingId, 1));
        require(!ok && _selector(ret) == ReleaseMarketplaceV4.TransferFailed.selector, "reverts with TransferFailed");
        require(PLATFORM.balance == platformBefore && SELLER.balance == sellerBefore && BUYER.balance == 1 ether, "nobody paid, buyer refunded");
        require(clone.balanceOf(SELLER, tokenId) == 2 && clone.balanceOf(BUYER, tokenId) == 0, "tokens did not move");
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV4.Status.ACTIVE), "listing still active");
    }

    // ------------------------------------------------------------------ registry

    function testReleaseFromAnotherFactoryIsRefusedAndUnknownListingsCannotBeBought() public {
        VoidReleaseFactoryV2Royalty other = new VoidReleaseFactoryV2Royalty(PLATFORM);
        (VoidRelease1155V4 foreign, VoidPrimarySale foreignSale, uint256 tokenId) = _release(other, ARTIST, PAYOUT, "app-foreign");
        _primaryBuy(foreignSale, tokenId, SELLER, 1);
        vm.prank(SELLER);
        foreign.setApprovalForAll(address(market), true);
        require(!factory.isRelease(address(foreign)) && other.isRelease(address(foreign)), "registry knows only its own releases");
        vm.prank(SELLER);
        (bool ok, bytes memory ret) = _try(address(market), 0, abi.encodeCall(market.createListing, (address(foreign), SELLER, tokenId, 1, 1 ether, 0)));
        require(!ok && _selector(ret) == ReleaseMarketplaceV4.UnsupportedRelease.selector, "foreign release refused with UnsupportedRelease");
        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        (ok, ret) = _try(address(market), 1 ether, _buyCall(market, 999, 1));
        require(!ok && _selector(ret) == ReleaseMarketplaceV4.UnsupportedRelease.selector, "a listing that does not exist cannot be bought");
        require(BUYER.balance == 1 ether, "nothing moved");
    }

    // ------------------------------------------------------------------ reentrancy

    function _reentrancyFixture(bool swallow)
        internal
        returns (ReleaseMarketplaceV4 open, SettlementPolicyToken token, SettlementReentrantReceiver hostile, uint256 listingId)
    {
        SettlementPermissiveRegistry registry = new SettlementPermissiveRegistry();
        open = new ReleaseMarketplaceV4(PLATFORM, 250, address(registry));
        hostile = new SettlementReentrantReceiver();
        token = new SettlementPolicyToken(address(hostile));
        token.mint(SELLER, 1, 5);
        vm.prank(SELLER);
        token.setApprovalForAll(address(open), true);
        vm.prank(SELLER);
        listingId = open.createListing(address(token), SELLER, 1, 5, 1 ether, 0);
        hostile.arm(open, listingId, 1 ether, swallow);
        vm.deal(address(hostile), 10 ether);
        vm.deal(BUYER, 10 ether);
    }

    function testReenteringRoyaltyReceiverCannotDoubleSettleWhenItSwallowsTheRevert() public {
        (ReleaseMarketplaceV4 open, SettlementPolicyToken token, SettlementReentrantReceiver hostile, uint256 listingId) = _reentrancyFixture(true);
        uint256 hostileBefore = address(hostile).balance;
        uint256 sellerBefore = SELLER.balance;
        uint256 platformBefore = PLATFORM.balance;
        vm.prank(BUYER);
        open.buy{value: 1 ether}(listingId, 1);
        require(hostile.attempted() && !hostile.reentered(), "the receiver tried and the guard refused the nested buy");
        require(open.getListing(listingId).amount == 4, "exactly one unit was sold");
        require(token.balanceOf(BUYER, 1) == 1 && token.balanceOf(SELLER, 1) == 4 && token.balanceOf(address(hostile), 1) == 0, "tokens moved once");
        require(address(hostile).balance == hostileBefore + 0.025 ether, "the receiver got its royalty once and kept its own funds");
        require(SELLER.balance - sellerBefore == 0.95 ether && PLATFORM.balance - platformBefore == 0.025 ether && address(open).balance == 0, "other shares paid once");
    }

    function testReenteringRoyaltyReceiverThatPropagatesTheRevertFailsTheWholeBuy() public {
        (ReleaseMarketplaceV4 open, SettlementPolicyToken token, SettlementReentrantReceiver hostile, uint256 listingId) = _reentrancyFixture(false);
        uint256 buyerBefore = BUYER.balance;
        uint256 platformBefore = PLATFORM.balance;
        vm.prank(BUYER);
        (bool ok, bytes memory ret) = _try(address(open), 1 ether, _buyCall(open, listingId, 1));
        require(!ok && _selector(ret) == ReleaseMarketplaceV4.TransferFailed.selector, "outer buy reverts with TransferFailed");
        require(BUYER.balance == buyerBefore && PLATFORM.balance == platformBefore && address(open).balance == 0, "nothing was paid");
        require(token.balanceOf(SELLER, 1) == 5 && open.getListing(listingId).amount == 5, "tokens and listing untouched");
        require(!hostile.reentered(), "the nested buy never succeeded");
    }

    // ------------------------------------------------------------------ approval and balance

    function testMissingApprovalAndInsufficientBalanceRefuseWithTheRightErrorAndMoveNothing() public {
        (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) = _release(factory, ARTIST, PAYOUT, "app-approval");
        _primaryBuy(sale, tokenId, SELLER, 3);
        uint256 listingId = _list(clone, tokenId, SELLER, 3, 1 ether);
        vm.deal(BUYER, 3 ether);
        uint256 platformBefore = PLATFORM.balance;

        vm.prank(SELLER);
        clone.setApprovalForAll(address(market), false);
        vm.prank(BUYER);
        (bool ok, bytes memory ret) = _try(address(market), 1 ether, _buyCall(market, listingId, 1));
        require(!ok && _selector(ret) == ReleaseMarketplaceV4.InsufficientApproval.selector, "revoked approval refused");
        vm.prank(SELLER);
        clone.setApprovalForAll(address(market), true);

        vm.prank(SELLER);
        clone.safeTransferFrom(SELLER, address(0x5757), tokenId, 1, "");
        vm.prank(BUYER);
        (ok, ret) = _try(address(market), 3 ether, _buyCall(market, listingId, 3));
        require(!ok && _selector(ret) == ReleaseMarketplaceV4.InsufficientBalance.selector, "seller balance below the quantity refused");

        vm.prank(BUYER);
        (ok, ret) = _try(address(market), 1 ether, _buyCall(market, listingId, 4));
        require(!ok && _selector(ret) == ReleaseMarketplaceV4.InsufficientQuantity.selector, "more than the listing holds refused");
        vm.prank(BUYER);
        (ok, ret) = _try(address(market), 0.5 ether, _buyCall(market, listingId, 1));
        require(!ok && _selector(ret) == ReleaseMarketplaceV4.IncorrectPayment.selector, "wrong payment refused");

        require(BUYER.balance == 3 ether && PLATFORM.balance == platformBefore && address(market).balance == 0, "no funds moved");
        require(clone.balanceOf(BUYER, tokenId) == 0 && clone.balanceOf(SELLER, tokenId) == 2, "no tokens moved");
        require(uint8(market.listingStatus(listingId)) == uint8(ReleaseMarketplaceV4.Status.ACTIVE), "listing still active");
    }

    // ------------------------------------------------------------------ dust rounding

    function testDustPricesFloorTheFeeAndRoyaltyToZeroButTotalsStillSumToThePrice() public {
        (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) = _release(factory, ARTIST, PAYOUT, "app-dust");
        _primaryBuy(sale, tokenId, SELLER, 25);
        // 39 wei: floor(39 * 250 / 10000) = 0. Documented behaviour: below 40 wei per sale no fee or royalty is owed.
        uint256 listingId = _list(clone, tokenId, SELLER, 1, 39 wei);
        vm.deal(BUYER, 1 ether);
        uint256 platformBefore = PLATFORM.balance;
        uint256 payoutBefore = PAYOUT.balance;
        uint256 sellerBefore = SELLER.balance;
        uint256 buyerBefore = BUYER.balance;
        vm.prank(BUYER);
        market.buy{value: 39 wei}(listingId, 1);
        require(PLATFORM.balance == platformBefore && PAYOUT.balance == payoutBefore, "fee and royalty floor to zero at 39 wei");
        require(SELLER.balance - sellerBefore == 39 && buyerBefore - BUYER.balance == 39 && address(market).balance == 0, "the whole price reaches the seller");

        // 40 wei is the first price that owes 1 wei each.
        listingId = _list(clone, tokenId, SELLER, 1, 40 wei);
        sellerBefore = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: 40 wei}(listingId, 1);
        require(PLATFORM.balance - platformBefore == 1 && PAYOUT.balance - payoutBefore == 1 && SELLER.balance - sellerBefore == 38, "40 wei: 1 / 1 / 38");

        // The fee is computed on the whole fill: ten units at 39 wei in one buy owe floor(390 * 2.5%) = 9 each.
        platformBefore = PLATFORM.balance;
        payoutBefore = PAYOUT.balance;
        sellerBefore = SELLER.balance;
        listingId = _list(clone, tokenId, SELLER, 10, 39 wei);
        vm.prank(BUYER);
        market.buy{value: 390 wei}(listingId, 10);
        require(PLATFORM.balance - platformBefore == 9 && PAYOUT.balance - payoutBefore == 9 && SELLER.balance - sellerBefore == 372, "bundled fill: 9 / 9 / 372, sums to 390");
        // Splitting the same units into single-unit fills avoids the fee entirely: documented, economically negligible (< 40 wei).
        platformBefore = PLATFORM.balance;
        for (uint256 i; i < 10; ++i) {
            listingId = _list(clone, tokenId, SELLER, 1, 39 wei);
            vm.prank(BUYER);
            market.buy{value: 39 wei}(listingId, 1);
        }
        require(PLATFORM.balance == platformBefore, "single-unit dust fills pay no fee");
    }

    // ------------------------------------------------------------------ event vs real transfers

    struct SoldEvent {
        bool found;
        uint256 listingId;
        address buyer;
        address seller;
        address tokenContract;
        uint256 tokenId;
        uint256 amount;
        uint256 price;
        uint256 platformFee;
        uint256 royalty;
    }

    function _soldEvent(VmSettlement.Log[] memory logs) internal view returns (SoldEvent memory e) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(market) || logs[i].topics[0] != LISTING_SOLD) continue;
            e.found = true;
            e.listingId = uint256(logs[i].topics[1]);
            e.buyer = address(uint160(uint256(logs[i].topics[2])));
            e.seller = address(uint160(uint256(logs[i].topics[3])));
            (e.tokenContract, e.tokenId, e.amount, e.price, e.platformFee, e.royalty) =
                abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256, uint256));
        }
    }

    function testListingSoldEventFieldsEqualTheActualTransfers() public {
        (VoidRelease1155V4 clone, VoidPrimarySale sale, uint256 tokenId) = _release(factory, ARTIST, PAYOUT, "app-event");
        _primaryBuy(sale, tokenId, SELLER, 3);
        uint256 listingId = _list(clone, tokenId, SELLER, 3, 0.7 ether);
        vm.deal(BUYER, 2.1 ether);
        Snap memory before = _snap(clone, tokenId);
        vm.recordLogs();
        vm.prank(BUYER);
        market.buy{value: 2.1 ether}(listingId, 3);
        SoldEvent memory e = _soldEvent(vm.getRecordedLogs());
        require(e.found, "ListingSold was emitted by the marketplace");
        require(e.listingId == listingId && e.buyer == BUYER && e.seller == SELLER, "event ids and parties");
        require(e.tokenContract == address(clone) && e.tokenId == tokenId && e.amount == 3 && e.price == 2.1 ether, "event token, quantity and price");
        require(e.platformFee == PLATFORM.balance - before.platform, "event platformFee equals the AVAX the platform received");
        require(e.royalty == PAYOUT.balance - before.payout, "event royalty equals the AVAX the payout received");
        require(e.price - e.platformFee - e.royalty == SELLER.balance - before.seller, "seller proceeds equal the remainder");
    }
}
