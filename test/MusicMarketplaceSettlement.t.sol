// SPDX-License-Identifier: MITpragma solidity ^0.8.24;

import {MusicMarketplace} from "../contracts/MusicMarketplace.sol";

interface Vm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

/// @dev ERC-1155 mock with optional ERC-2981 royaltyInfo and receiver-hook transfers,
///      used to prove exact MusicMarketplace settlement amounts.
contract MockRoyalty1155 {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    mapping(address => mapping(uint256 => uint256)) public balances;
    mapping(address => mapping(address => bool)) public approvedForAll;
    address public royaltyReceiver;
    uint256 public royaltyBps;
    bool public erc2981;
    bool public callReceiverHook = true;

    constructor(address receiver, uint256 bps, bool supportsErc2981) {
        royaltyReceiver = receiver;
        royaltyBps = bps;
        erc2981 = supportsErc2981;
    }

    function setBalance(address account, uint256 id, uint256 amount) external { balances[account][id] = amount; }
    function setApproval(address account, address operator, bool value) external { approvedForAll[account][operator] = value; }
    function transferAway(address from, address to, uint256 id, uint256 amount) external {
        require(balances[from][id] >= amount, "balance");
        balances[from][id] -= amount;
        balances[to][id] += amount;
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) { return balances[account][id]; }
    function isApprovedForAll(address account, address operator) external view returns (bool) { return approvedForAll[account][operator]; }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        require(erc2981, "ERC2981 unsupported");
        return (royaltyReceiver, (salePrice * royaltyBps) / BPS_DENOMINATOR);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata) external {
        require(balances[from][id] >= value, "balance");
        balances[from][id] -= value;
        balances[to][id] += value;
        if (callReceiverHook && to.code.length > 0) {
            (bool ok, bytes memory ret) = to.call(
                abi.encodeWithSignature("onERC1155Received(address,address,uint256,uint256,bytes)", from, address(0), id, value, bytes(""))
            );
            require(ok && ret.length >= 4 && bytes4(ret) == bytes4(0xf23a6e61), "receiver rejected");
        }
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }
}

/// @dev Buyer that reenters MusicMarketplace.buy with the correct payment while the
///      settlement transfer is in flight. The reentrancy guard must reject it.
contract ReentrantBuyer {
    MusicMarketplace public market;
    uint256 public listingId;
    uint256 public quantity;
    uint256 public reentryValue;
    uint256 public reentryAttempts;
    bool public armed;

    constructor(MusicMarketplace market_) { market = market_; }

    function arm(uint256 listingId_, uint256 quantity_, uint256 reentryValue_) external {
        listingId = listingId_;
        quantity = quantity_;
        reentryValue = reentryValue_;
        armed = true;
    }

    function buy(uint256 id, uint256 q) external payable { market.buy{value: msg.value}(id, q); }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false;
            reentryAttempts++;
            (bool ok,) = address(market).call{value: reentryValue}(
                abi.encodeWithSignature("buy(uint256,uint256)", listingId, quantity)
            );
            require(!ok, "reentrant buy succeeded");
        }
        return this.onERC1155Received.selector;
    }

    receive() external payable {}
}

/// @dev Buyer whose ERC-1155 receiver hook always reverts; the whole settlement must revert.
contract MaliciousReceiver {
    receive() external payable {}
    function buy(MusicMarketplace market, uint256 listingId, uint256 price) external {
        market.buy{value: price}(listingId, 1);
    }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure {
        revert("no tokens for you");
    }
}

contract MusicMarketplaceSettlementTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant SELLER = address(0xA11CE);
    address internal constant BUYER = address(0xB0B);
    address internal constant FEE = address(0xFEE);
    address internal constant ARTIST = address(0xA27);
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant FEE_BPS = 250;
    uint256 internal constant ROYALTY_BPS = 500;
    bytes32 internal constant LISTING_SOLD_TOPIC =
        keccak256("ListingSold(uint256,address,address,address,uint256,uint256,uint256,uint256,uint256)");

    MusicMarketplace internal marketplace;
    MockRoyalty1155 internal canonical;

    function setUp() public {
        canonical = new MockRoyalty1155(ARTIST, ROYALTY_BPS, true);
        marketplace = new MusicMarketplace(FEE, FEE_BPS, address(canonical));
        canonical.setBalance(SELLER, 1, 5);
        canonical.setApproval(SELLER, address(marketplace), true);
    }

    function _list(uint256 amount, uint256 price, uint64 expiresAt) internal returns (uint256 listingId) {
        vm.prank(SELLER);
        listingId = marketplace.createListing(address(canonical), SELLER, 1, amount, price, expiresAt);
    }

    // 1, 2, 3, 4, 17: full secondary sale splits the payment exactly
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
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.ACTIVE), "still active");
    }

    // 2: no ERC-2981 on the token => royalty is zero, platform fee still applies
    function testNoErc2981MeansNoRoyalty() public {
        MockRoyalty1155 plain = new MockRoyalty1155(ARTIST, ROYALTY_BPS, false);
        MusicMarketplace plainMarket = new MusicMarketplace(FEE, FEE_BPS, address(plain));
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
        require(ARTIST.balance =
= artistBefore, "no royalty without ERC-2981");
        uint256 sellerCut = PRICE - (PRICE * FEE_BPS) / 10_000;
        require(SELLER.balance - sellerBefore == sellerCut, "seller proceeds");
    }

    // 6, 7: partial purchase charges proportional amounts and keeps the listing active
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

        require(FEE.balance - feeBefore == (salePrice * FEE_BPS) / 10_000, "fee proportional");
        require(ARTIST.balance - artistBefore == (salePrice * ROYALTY_BPS) / 10_000, "royalty proportional");
        uint256 sellerCut = salePrice - (salePrice * FEE_BPS) / 10_000 - (salePrice * ROYALTY_BPS) / 10_000;
        require(SELLER.balance - sellerBefore == sellerCut, "seller proportional");
        require(canonical.balanceOf(BUYER, 1) == 2, "partial nft transfer");
        MusicMarketplace.Listing memory snapshot = marketplace.getListing(listingId);
        require(snapshot.amount == 1, "remaining amount");
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.ACTIVE), "active after partial");

        vm.deal(BUYER, unitPrice);
        vm.prank(BUYER);
        marketplace.buy{value: unitPrice}(listingId, 1);
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.SOLD), "sold terminal");
        require(canonical.balanceOf(BUYER, 1) == 3, "final nft transfer");
    }

    // 5: accounting conservation, including floor rounding credited to the seller
    function testConservationWithRounding() public {
        canonical.setBalance(SELLER, 1, 10);
        uint256 unitPrice = 1_000_003; // deliberately indivisible by BPS
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
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.SOLD), "sold");

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MusicMarketplace.ListingNotActive.selector);
        marketplace.buy{value: PRICE}(listingId, 1);
    }

    // 8: cancellation
    function testSellerCancellationBlocks() public {
        uint256 listingId = _list(2, PRICE, 0);
        vm.prank(address(0xBAD));
        vm.expectRevert(MusicMarketplace.NotSeller.selector);
        marketplace.cancelListing(listingId);

        vm.prank(SELLER);
        marketplace.cancelListing(listingId);
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.CANCELLED), "cancelled");

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MusicMarketplace.ListingNotActive.selector);
        marketplace.buy{value: PRICE}(listingId, 1);
    }

    // 9: expiration
    function testExpiredListingCannotBeBought() public {
        uint64 expiresAt = uint64(block.timestamp + 100);
        uint256 listingId = _list(2, PRICE, expiresAt);
        vm.warp(block.timestamp + 101);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MusicMarketplace.Expired.selector);
        marketplace.buy{value: PRICE}(listingId, 1);

        marketplace.expireListing(listingId);
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.EXPIRED), "expired");

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MusicMarketplace.ListingNotActive.selector);
        marketplace.buy{value: PRICE}(listingId, 1);

        vm.prank(SELLER);
        vm.expectRevert(MusicMarketplace.InvalidExpiry.selector);
        marketplace.createListing(address(canonical), SELLER, 1, 1, PRICE, uint64(block.timestamp - 1));
    }

    // 10: exact payment validation, no partial refunds, no state change
    function testWrongPaymentRevertsCleanly() public {
        uint256 listingId = _list(2, PRICE, 0);
        uint256 sellerBefore = SELLER.balance;
        vm.deal(BUYER, PRICE + 1 wei);

        vm.prank(BUYER);
        vm.expectRevert(MusicMarketplace.IncorrectPayment.selector);
        marketplace.buy{value: PRICE - 1 wei}(listingId, 1);

        vm.prank(BUYER);
        vm.expectRevert(MusicMarketplace.IncorrectPayment.selector);
        marketplace.buy{value: PRICE + 1 wei}(listingId, 1);

        require(BUYER.balance == PRICE + 1 wei, "buyer balance restored");
        require(SELLER.balance == sellerBefore, "seller unpaid");
        require(FEE.balance == 0 && ARTIST.balance == 0, "no fee or royalty leaked");
        require(canonical.balanceOf(BUYER, 1) == 0, "no nft moved");
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.
ACTIVE), "still active");
    }

    // 11: seller spent the tokens after listing
    function testInsufficientSellerBalance() public {
        uint256 listingId = _list(5, PRICE, 0);
        canonical.transferAway(SELLER, address(0xDEAD), 1, 5);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MusicMarketplace.InsufficientBalance.selector);
        marketplace.buy{value: PRICE}(listingId, 1);
    }

    // 12: stale approval
    function testStaleApprovalReverts() public {
        uint256 listingId = _list(5, PRICE, 0);
        canonical.setApproval(SELLER, address(marketplace), false);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MusicMarketplace.InsufficientApproval.selector);
        marketplace.buy{value: PRICE}(listingId, 1);
    }

    // 13: reentrancy with a funded, value-carrying reentry attempt
    function testReentrancyIsBlocked() public {
        uint256 listingId = _list(2, PRICE, 0);
        ReentrantBuyer attacker = new ReentrantBuyer(marketplace);
        vm.deal(address(attacker), PRICE * 2);
        attacker.arm(listingId, 1, PRICE);

        attacker.buy{value: PRICE}(listingId, 1);

        require(attacker.reentryAttempts() == 1, "reentry attempted once");
        require(canonical.balanceOf(address(attacker), 1) == 1, "single nft transfer");
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.ACTIVE), "single decrement");
        require(FEE.balance == (PRICE * FEE_BPS) / 10_000, "single fee");
        require(ARTIST.balance == (PRICE * ROYALTY_BPS) / 10_000, "single royalty");
        uint256 sellerCut = PRICE - (PRICE * FEE_BPS) / 10_000 - (PRICE * ROYALTY_BPS) / 10_000;
        require(SELLER.balance == sellerCut, "single seller payment");
        require(address(attacker).balance == PRICE, "attacker spent exactly once");
    }

    // 14: malicious ERC-1155 receiver makes the whole settlement revert atomically
    function testMaliciousReceiverReverts() public {
        uint256 listingId = _list(2, PRICE, 0);
        MaliciousReceiver victim = new MaliciousReceiver();
        vm.deal(address(victim), PRICE);
        uint256 sellerBefore = SELLER.balance;

        vm.expectRevert();
        victim.buy(marketplace, listingId, PRICE);

        require(address(victim).balance == PRICE, "buyer funds intact");
        require(SELLER.balance == sellerBefore, "seller unpaid");
        require(FEE.balance == 0 && ARTIST.balance == 0, "nothing leaked");
        require(canonical.balanceOf(SELLER, 1) == 5, "nft unchanged");
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.ACTIVE), "still active");
    }

    // 15, 16: royalty above the post-fee remainder is rejected; fee bounds enforced
    function testRoyaltyAndFeeBounds() public {
        MockRoyalty1155 greedy = new MockRoyalty1155(ARTIST, 9_800, true);
        MusicMarketplace greedyMarket = new MusicMarketplace(FEE, FEE_BPS, address(greedy));
        greedy.setBalance(SELLER, 1, 5);
        greedy.setApproval(SELLER, address(greedyMarket), true);
        vm.prank(SELLER);
        uint256 listingId = greedyMarket.createListing(address(greedy), SELLER, 1, 2, PRICE, 0);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(MusicMarketplace.RoyaltyTooHigh.selector);
        greedyMarket.buy{value: PRICE}(listingId, 1);

        vm.expectRevert(MusicMarketplace.FeeTooHigh.selector);
        new MusicMarketplace(FEE, 10_001, address(canonical));

        MusicMarketplace maxFee = new MusicMarketplace(FEE, 10_000, address(canonical));
        require(maxFee.platformFeeBps() == 10_000, "boundary fee allowed");

        MusicMarketplace zeroFee = new MusicMarketplace(FEE, 0, address(canonical));
        canonical.setApproval(SELLER, address(zeroFee), true);
        uint256 artistBefore = ARTIST.balance;
        uint256 sellerBefore = SELLER.balance;
        vm.prank(SELLER);
        uint256 zeroFeeListing = zeroFee.createListing(address(canonical), SELLER, 1, 1, PRICE, 0);
        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        zeroFee.buy{value: PRICE}(zeroFeeListing, 1);
        require(FEE.balance == 0, "no fee");
        require(ARTIST.balance - artistBefore == (PRICE * ROYALTY_BPS) / 10_000, "royalty without fee");
        uint256 sellerCut = PRICE - (PRICE * ROYALTY_BPS) / 10_000;
        require(SELLER.balance - sellerBefore == sellerCut, "seller without fee");
    }

    // 15: economics configuration is immutable and cannot be changed by anyone
    function testConfigIsImmutable() public {
        require(marketplace.feeRecipient() == FEE, "fee recipient immutable");
        require(marketplace.platformFeeBps() == FEE_BPS, "fee bps immutable");
        require(marketplace.canonicalToken() == address(canonical), "canonical token immutable");

        vm.prank(SELLER);
        vm.expectRevert(MusicMarketplace.InvalidAddress.selector);
        marketplace.createListing(address(canonical), BUYER, 1, 1, PRICE, 0);
    }

    // 17: the settlement event matches the actual economics word for word
    function testSettlementEventMatches() public {
        uint256 listingId = _list(2, PRICE, 0);
        vm.deal(BUYER, PRICE);
        vm.recordLogs();
        vm.prank(BUYER);
        marketplace.buy{value: PRICE}(listingId, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(marketplace) || logs[i].topics[0] != LISTING_SOLD_TOPIC) continue;
            found = true;
            require(logs[i].topics.length == 4, "indexed topics");
            require(uint256(logs[i].topics[1]) == listingId, "listingId topic");
            require(address(uint160(uint256(logs[i].topics[2]))) == BUYER, "buyer topic");
            require(address(uint160(uint256(logs[i].topics[3]))) == SELLER, "seller topic");
            (address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint256 platformFee, uint256 royalty) =
                abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256, uint256));
            require(tokenContract == address(canonical), "token contract data");
            require(tokenId == 1, "token id data");
            require(amount == 1, "amount data");
            require(price == PRICE, "price data");
            require(platformFee == (PRICE * FEE_BPS) / 10_000, "platform fee data");
            require(royalty == (PRICE * ROYALTY_BPS) / 10_000, "royalty data");
        }
        require(found, "ListingSold event emitted");
    }
}
