// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MusicMarketplace as MM} from "../contracts/MusicMarketplace.sol";

interface VmMkt {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

/// @dev ERC-1155 mock with optional ERC-2981 royalties and a
///      receiver hook, used to prove exact settlement amounts.
contract MockRoyalty1155 {
    uint256 public constant BPS_DENOM = 10_000;
    mapping(address => mapping(uint256 => uint256)) public balances;
    mapping(address => mapping(address => bool)) public approvedForAll;
    address public royaltyReceiver;
    uint256 public royaltyBps;
    bool public erc2981;

    constructor(address receiver, uint256 bps, bool flag) {
        royaltyReceiver = receiver;
        royaltyBps = bps;
        erc2981 = flag;
    }

    function setBalance(address who, uint256 id, uint256 qty) external {
        balances[who][id] = qty;
    }

    function setApproval(address who, address operator, bool value) external {
        approvedForAll[who][operator] = value;
    }

    function transferAway(address from, address to, uint256 id, uint256 qty) external {
        require(balances[from][id] >= qty, "balance");
        balances[from][id] -= qty;
        balances[to][id] += qty;
    }

    function balanceOf(address who, uint256 id) external view returns (uint256) {
        return balances[who][id];
    }

    function isApprovedForAll(address who, address operator) external view returns (bool) {
        return approvedForAll[who][operator];
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        require(erc2981, "no ERC2981");
        return (royaltyReceiver, (salePrice * royaltyBps) / BPS_DENOM);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata) external {
        require(balances[from][id] >= value, "balance");
        balances[from][id] -= value;
        balances[to][id] += value;
        if (to.code.length > 0) {
            (bool ok, bytes memory ret) = to.call(
                abi.encodeWithSelector(
                    bytes4(0xf23a6e61), from, address(0), id, value, bytes("")
                )
            );
            require(ok, "receiver rejected");
            require(ret.length == 4, "bad hook return");
            bytes32 head;
            assembly {
                head := mload(add(ret, 32))
            }
            require(bytes4(head) == bytes4(0xf23a6e61), "bad magic");
        }
    }
}

/// @dev Buyer that reenters buy while a settlement is in flight.
contract ReentrantBuyer {
    MM public market;
    uint256 public listingId;
    uint256 public quantity;
    uint256 public reentryValue;
    uint256 public reentryAttempts;
    bool public armed;

    constructor(MM market_) { market = market_; }

    function arm(uint256 a, uint256 b, uint256 c) external {
        listingId = a;
        quantity = b;
        reentryValue = c;
        armed = true;
    }

    function buy(uint256 id, uint256 q) external {
        market.buy{value: reentryValue}(id, q);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false;
            reentryAttempts++;
            (bool ok,) = address(market).call{value: reentryValue}(
                abi.encodeWithSignature(
                    string.concat("buy(uint256", ",uint256)"),
                    listingId,
                    quantity
                )
            );
            require(!ok, "reentrant buy won");
        }
        return this.onERC1155Received.selector;
    }

    receive() external payable {}
}

/// @dev Buyer whose receiver hook always reverts.
contract MaliciousReceiver {
    receive() external payable {}

    function buy(MM market, uint256 listingId, uint256 price) external {
        market.buy{value: price}(listingId, 1);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure {
        revert("no tokens");
    }
}

/// @dev Deploys the marketplace on behalf of callers so that a
///      constructor revert bubbles up through an external call.
contract DeployHelper {
    function deploy(uint256 bps, address token) external {
        MM m = new MM(msg.sender, bps, token);
        require(address(m) != address(0), "deploy failed");
    }
}

contract MusicMarketplaceSettlementTest {
    VmMkt internal constant vm = VmMkt(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant SELLER = address(0xA11CE);
    address internal constant BUYER = address(0xB0B);
    address internal constant FEE = address(0xFEE);
    address internal constant ARTIST = address(0xA27);
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant FEE_BPS = 250;
    uint256 internal constant ROYALTY_BPS = 500;

    MM internal marketplace;
    MockRoyalty1155 internal canonical;

    function setUp() public {
        canonical = new MockRoyalty1155(ARTIST, ROYALTY_BPS, true);
        marketplace = new MM(FEE, FEE_BPS, address(canonical));
        canonical.setBalance(SELLER, 1, 5);
        canonical.setApproval(SELLER, address(marketplace), true);
    }

    function _list(uint256 amount, uint256 price, uint64 expiresAt) internal returns (uint256 listingId) {
        vm.prank(SELLER);
        listingId = marketplace.createListing(address(canonical), SELLER, 1, amount, price, expiresAt);
    }

    // 1, 2, 3, 4, 17: full secondary sale splits payment exactly
    function testFullSaleSplitsPayment() public {
        uint256 listingId = _list(2, PRICE, 0);
        uint256 feeBefore = FEE.balance;
        uint256 artistBefore = ARTIST.balance;
        uint256 sellerBefore = SELLER.balance;
        vm.deal(BUYER, PRICE);

        vm.prank(BUYER);
        marketplace.buy{value: PRICE}(listingId, 1);

        uint256 expectedFee = (PRICE * FEE_BPS) / 10_000;
        uint256 expectedRoyalty = (PRICE * ROYALTY_BPS) / 10_000;
        uint256 expectedSeller = PRICE - expectedFee - expectedRoyalty;
        require(FEE.balance - feeBefore == expectedFee, "fee amount");
        require(ARTIST.balance - artistBefore == expectedRoyalty, "royalty amount");
        require(SELLER.balance - sellerBefore == expectedSeller, "seller proceeds");
        require(BUYER.balance == 0, "buyer overpaid residue");
        require(canonical.balanceOf(BUYER, 1) == 1, "nft to buyer");
        require(canonical.balanceOf(SELLER, 1) == 4, "nft left seller");
        MM.Status st = marketplace.listingStatus(listingId);
        require(st == MM.Status.ACTIVE, "still active");
    }

    // 2: no ERC-2981 on the token means zero royalty, fee still applies
    function testNoErc2981MeansNoRoyalty() public {
        MockRoyalty1155 plain = new MockRoyalty1155(ARTIST, ROYALTY_BPS, false);
        MM plainMarket = new MM(FEE, FEE_BPS, address(plain));
        plain.setBalance(SELLER, 1, 5);
        plain.setApproval(SELLER, address(plainMarket), true);
        vm.prank(SELLER);
        uint256 listingId = plainMarket.createListing(address(plain), SELLER, 1, 2, PRICE, 0);

        uint256 feeBefore = FEE.balance;
        uint256 artistBefore = ARTIST.balance;
        uint256 sellerBefore = SELLER.balance;
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        plainMarket.buy{value: PRICE}(listingId, 1);

        require(FEE.balance - feeBefore == (PRICE * FEE_BPS) / 10_000, "fee amount");
        require(ARTIST.balance == artistBefore, "no royalty");
        uint256 sellerCut = PRICE - (PRICE * FEE_BPS) / 10_000;
        require(SELLER.balance - sellerBefore == sellerCut, "seller proceeds");
    }

    // 6, 7: partial purchase charges proportional amounts
    function testPartialPurchaseProportional() public {
        uint256 unitPrice = 0.01 ether;
        uint256 listingId = _list(3, unitPrice, 0);
        uint256 feeBefore = FEE.balance;
        uint256 artistBefore = ARTIST.balance;
        uint256 sellerBefore = SELLER.balance;
        uint256 salePrice = unitPrice * 2;
        vm.deal(BUYER, salePrice);

        vm.prank(BUYER);
        marketplace.buy{value: salePrice}(listingId, 2);

        require(FEE.balance - feeBefore == (salePrice * FEE_BPS) / 10_000, "fee prop");
        require(ARTIST.balance - artistBefore == (salePrice * ROYALTY_BPS) / 10_000, "royalty prop");
        uint256 sellerCut = salePrice - (salePrice * FEE_BPS) / 10_000;
        sellerCut = sellerCut - (salePrice * ROYALTY_BPS) / 10_000;
        require(SELLER.balance - sellerBefore == sellerCut, "seller prop");
        require(canonical.balanceOf(BUYER, 1) == 2, "partial transfer");
        MM.Listing memory snapshot = marketplace.getListing(listingId);
        require(snapshot.amount == 1, "remaining amount");
        MM.Status st = marketplace.listingStatus(listingId);
        require(st == MM.Status.ACTIVE, "active after partial");

        vm.deal(BUYER, unitPrice);
        vm.prank(BUYER);
        marketplace.buy{value: unitPrice}(listingId, 1);
        MM.Status st2 = marketplace.listingStatus(listingId);
        require(st2 == MM.Status.SOLD, "sold terminal");
        require(canonical.balanceOf(BUYER, 1) == 3, "final transfer");
    }

    // 5: conservation including floor rounding credited to the seller
    function testConservationWithRounding() public {
        canonical.setBalance(SELLER, 1, 10);
        uint256 unitPrice = 1_000_003;
        uint256 quantity = 7;
        uint256 listingId = _list(10, unitPrice, 0);
        uint256 salePrice = unitPrice * quantity;
        uint256 feeBefore = FEE.balance;
        uint256 artistBefore = ARTIST.balance;
        uint256 sellerBefore = SELLER.balance;
        vm.deal(BUYER, salePrice);

        vm.prank(BUYER);
        marketplace.buy{value: salePrice}(listingId, quantity);

        uint256 fee = FEE.balance - feeBefore;
        uint256 royalty = ARTIST.balance - artistBefore;
        uint256 seller = SELLER.balance - sellerBefore;
        require(fee == (salePrice * FEE_BPS) / 10_000, "fee floor");
        require(royalty == (salePrice * ROYALTY_BPS) / 10_000, "royalty floor");
        require(fee + royalty + seller == salePrice, "conservation");
        require(seller == salePrice - fee - royalty, "rounding to seller");
    }

    // 7: terminal listing cannot be purchased again
    function testFullPurchaseIsTerminal() public {
        uint256 listingId = _list(1, PRICE, 0);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        marketplace.buy{value: PRICE}(listingId, 1);
        MM.Status st = marketplace.listingStatus(listingId);
        require(st == MM.Status.SOLD, "sold");

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MM.ListingNotActive.selector);
        marketplace.buy{value: PRICE}(listingId, 1);
    }

    // 8: cancellation blocks a later purchase
    function testSellerCancellationBlocks() public {
        uint256 listingId = _list(2, PRICE, 0);
        vm.prank(address(0xBAD));
        vm.expectRevert(MM.NotSeller.selector);
        marketplace.cancelListing(listingId);

        vm.prank(SELLER);
        marketplace.cancelListing(listingId);
        MM.Status st = marketplace.listingStatus(listingId);
        require(st == MM.Status.CANCELLED, "cancelled");

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MM.ListingNotActive.selector);
        marketplace.buy{value: PRICE}(listingId, 1);
    }

    // 9: expiration blocks purchase and bad expiry is rejected
    function testExpiredListingCannotBeBought() public {
        uint64 expiresAt = uint64(block.timestamp + 100);
        uint256 listingId = _list(2, PRICE, expiresAt);
        vm.warp(block.timestamp + 101);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MM.Expired.selector);
        marketplace.buy{value: PRICE}(listingId, 1);

        marketplace.expireListing(listingId);
        MM.Status st = marketplace.listingStatus(listingId);
        require(st == MM.Status.EXPIRED, "expired");

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MM.ListingNotActive.selector);
        marketplace.buy{value: PRICE}(listingId, 1);

        vm.prank(SELLER);
        vm.expectRevert(MM.InvalidExpiry.selector);
        marketplace.createListing(
            address(canonical), SELLER, 1, 1, PRICE, uint64(block.timestamp - 1)
        );
    }

    // 10: exact payment validation, no partial refunds, no state change
    function testWrongPaymentRevertsCleanly() public {
        uint256 listingId = _list(2, PRICE, 0);
        uint256 sellerBefore = SELLER.balance;
        vm.deal(BUYER, PRICE + 1 wei);

        vm.prank(BUYER);
        vm.expectRevert(MM.IncorrectPayment.selector);
        marketplace.buy{value: PRICE - 1 wei}(listingId, 1);

        vm.prank(BUYER);
        vm.expectRevert(MM.IncorrectPayment.selector);
        marketplace.buy{value: PRICE + 1 wei}(listingId, 1);

        require(BUYER.balance == PRICE + 1 wei, "buyer restored");
        require(SELLER.balance == sellerBefore, "seller unpaid");
        require(FEE.balance == 0 && ARTIST.balance == 0, "no leak");
        require(canonical.balanceOf(BUYER, 1) == 0, "no nft moved");
        MM.Status st = marketplace.listingStatus(listingId);
        require(st == MM.Status.ACTIVE, "still active");
    }

    // 11: seller spent the tokens after listing
    function testInsufficientSellerBalance() public {
        uint256 listingId = _list(5, PRICE, 0);
        canonical.transferAway(SELLER, address(0xDEAD), 1, 5);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MM.InsufficientBalance.selector);
        marketplace.buy{value: PRICE}(listingId, 1);
    }

    // 12: stale approval reverts
    function testStaleApprovalReverts() public {
        uint256 listingId = _list(5, PRICE, 0);
        canonical.setApproval(SELLER, address(marketplace), false);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MM.InsufficientApproval.selector);
        marketplace.buy{value: PRICE}(listingId, 1);
    }

    // 13: funded reentrancy attempt on buy is rejected once
    function testReentrancyIsBlocked() public {
        uint256 listingId = _list(2, PRICE, 0);
        ReentrantBuyer attacker = new ReentrantBuyer(marketplace);
        vm.deal(address(attacker), PRICE * 2);
        attacker.arm(listingId, 1, PRICE);

        attacker.buy(listingId, 1);

        require(attacker.reentryAttempts() == 1, "reentry tried once");
        require(canonical.balanceOf(address(attacker), 1) == 1, "one transfer");
        require(address(attacker).balance == PRICE, "spent exactly once");
        require(FEE.balance == (PRICE * FEE_BPS) / 10_000, "single fee");
        require(ARTIST.balance == (PRICE * ROYALTY_BPS) / 10_000, "single royalty");
        uint256 sellerCut = PRICE - (PRICE * FEE_BPS) / 10_000;
        sellerCut = sellerCut - (PRICE * ROYALTY_BPS) / 10_000;
        require(SELLER.balance == sellerCut, "single seller pay");
        MM.Status st = marketplace.listingStatus(listingId);
        require(st == MM.Status.ACTIVE, "single decrement");
    }

    // 14: malicious receiver hook reverts the whole settlement
    function testMaliciousReceiverReverts() public {
        uint256 listingId = _list(2, PRICE, 0);
        MaliciousReceiver victim = new MaliciousReceiver();
        vm.deal(address(victim), PRICE);
        uint256 sellerBefore = SELLER.balance;

        vm.expectRevert();
        victim.buy(marketplace, listingId, PRICE);

        require(victim.balance == PRICE, "buyer funds intact");
        require(SELLER.balance == sellerBefore, "seller unpaid");
        require(FEE.balance == 0 && ARTIST.balance == 0, "nothing leaked");
        require(canonical.balanceOf(SELLER, 1) == 5, "nft unchanged");
        MM.Status st = marketplace.listingStatus(listingId);
        require(st == MM.Status.ACTIVE, "still active");
    }

    // 15, 16: royalty above post-fee remainder and fee bounds
    function testRoyaltyAndFeeBounds() public {
        MockRoyalty1155 greedy = new MockRoyalty1155(ARTIST, 9_800, true);
        MM greedyMarket = new MM(FEE, FEE_BPS, address(greedy));
        greedy.setBalance(SELLER, 1, 5);
        greedy.setApproval(SELLER, address(greedyMarket), true);
        vm.prank(SELLER);
        uint256 listingId = greedyMarket.createListing(address(greedy), SELLER, 1, 2, PRICE, 0);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MM.RoyaltyTooHigh.selector);
        greedyMarket.buy{value: PRICE}(listingId, 1);

        DeployHelper helper = new DeployHelper();
        vm.expectRevert(MM.FeeTooHigh.selector);
        helper.deploy(10_001, address(canonical));

        MM maxFee = new MM(FEE, 10_000, address(canonical));
        require(maxFee.platformFeeBps() == 10_000, "boundary fee ok");

        MM zeroFee = new MM(FEE, 0, address(canonical));
        canonical.setApproval(SELLER, address(zeroFee), true);
        uint256 artistBefore = ARTIST.balance;
        uint256 sellerBefore = SELLER.balance;
        vm.prank(SELLER);
        uint256 zeroFeeListing = zeroFee.createListing(
            address(canonical), SELLER, 1, 1, PRICE, 0
        );
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        zeroFee.buy{value: PRICE}(zeroFeeListing, 1);
        require(FEE.balance == 0, "no fee");
        uint256 expectedRoyalty = (PRICE * ROYALTY_BPS) / 10_000;
        require(ARTIST.balance - artistBefore == expectedRoyalty, "royalty no fee");
        uint256 sellerCut = PRICE - expectedRoyalty;
        require(SELLER.balance - sellerBefore == sellerCut, "seller no fee");
    }

    // 15: economics configuration is immutable
    function testConfigIsImmutable() public {
        require(marketplace.feeRecipient() == FEE, "fee recipient");
        require(marketplace.platformFeeBps() == FEE_BPS, "fee bps");
        require(marketplace.canonicalToken() == address(canonical), "canonical");

        vm.prank(SELLER);
        vm.expectRevert(MM.InvalidAddress.selector);
        marketplace.createListing(address(canonical), BUYER, 1, 1, PRICE, 0);
    }

    // 17: settlement event matches the actual economics
    function testSettlementEventMatches() public {
        bytes32 topic = keccak256(
            string.concat(
                "ListingSold(uint256,address,",
                "address,address,uint256,uint256,",
                "uint256,uint256,uint256)"
            )
        );
        uint256 listingId = _list(2, PRICE, 0);
        vm.deal(BUYER, PRICE);
        vm.recordLogs();
        vm.prank(BUYER);
        marketplace.buy{value: PRICE}(listingId, 1);
        VmMkt.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(marketplace)) continue;
            if (logs[i].topics[0] != topic) continue;
            found = true;
            require(logs[i].topics.length == 4, "indexed topics");
            require(uint256(logs[i].topics[1]) == listingId, "listingId topic");
            address buyerTopic = address(uint160(uint256(logs[i].topics[2])));
            require(buyerTopic == BUYER, "buyer topic");
            address sellerTopic = address(uint160(uint256(logs[i].topics[3])));
            require(sellerTopic == SELLER, "seller topic");
            (address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint256 platformFee, uint256 royalty) =
                abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256, uint256));
            require(tokenContract == address(canonical), "token data");
            require(tokenId == 1, "token id data");
            require(amount == 1, "amount data");
            require(price == PRICE, "price data");
            require(platformFee == (PRICE * FEE_BPS) / 10_000, "fee data");
            require(royalty == (PRICE * ROYALTY_BPS) / 10_000, "royalty data");
        }
        require(found, "ListingSold emitted");
    }
}
