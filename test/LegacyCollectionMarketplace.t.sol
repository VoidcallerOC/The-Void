// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegacyCollectionMarketplace} from "../contracts/LegacyCollectionMarketplace.sol";

interface VmLegacy {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert(bytes4) external;
}

/// @dev Behaves like Genesis (Launchpeg ERC1155SingleBundle): ERC-165 for 1155 and 2981, a contract-wide mutable
/// royalty, and an operator filter on `setApprovalForAll` and on `safeTransferFrom` by a non-owner operator.
contract MockGenesis {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(address => bool) public filtered;
    address public royaltyReceiver;
    uint256 public royaltyBps = 500;
    bool public supports1155 = true;
    bool public supports2981 = true;
    // 0 normal, 1 revert, 2 short returndata, 3 dirty address word, 4 absurd amount
    uint256 public royaltyMode;

    constructor(address receiver) { royaltyReceiver = receiver; }
    function mint(address to, uint256 id, uint256 value) external { balanceOf[to][id] += value; }
    function setFiltered(address operator, bool value) external { filtered[operator] = value; }
    function setRoyalty(address receiver, uint256 bps) external { royaltyReceiver = receiver; royaltyBps = bps; }
    function setRoyaltyMode(uint256 mode) external { royaltyMode = mode; }
    function setSupport(bool a, bool b) external { supports1155 = a; supports2981 = b; }
    function supportsInterface(bytes4 id) external view returns (bool) {
        return id == 0x01ffc9a7 || (id == 0xd9b67a26 && supports1155) || (id == 0x2a55205a && supports2981);
    }
    function setApprovalForAll(address operator, bool approved) external {
        require(!filtered[operator], "OperatorNotAllowed");
        isApprovedForAll[msg.sender][operator] = approved;
    }
    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        if (royaltyMode == 1) revert("royalty broken");
        if (royaltyMode == 2) assembly { mstore(0, 1) return(0, 32) }
        if (royaltyMode == 3) assembly { mstore(0, not(0)) mstore(32, 1) return(0, 64) }
        if (royaltyMode == 4) return (royaltyReceiver, price * 2);
        if (royaltyMode == 5) return (royaltyReceiver, price > 1 ether ? price : 0); // non-linear: fine per unit, absurd in bulk
        if (royaltyMode == 6) { while (true) {} } // burns all gas
        return (royaltyReceiver, (price * royaltyBps) / 10_000);
    }
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external {
        if (from != msg.sender) {
            require(!filtered[msg.sender], "OperatorNotAllowed");
            require(isApprovedForAll[from][msg.sender], "not approved");
        }
        balanceOf[from][id] -= value;
        balanceOf[to][id] += value;
        if (to.code.length > 0) {
            bytes4 ret = ERC1155HookReceiver(to).onERC1155Received(msg.sender, from, id, value, data);
            require(ret == 0xf23a6e61, "receiver rejected");
        }
    }
}

interface ERC1155HookReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4);
}

/// @dev A wallet contract that accepts tokens and AVAX.
contract GoodHolder {
    receive() external payable {}
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
}

/// @dev Rejects AVAX: a royalty receiver / seller that makes settlement fail.
contract RejectsAvax {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
}

contract WrongSelectorReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xdeadbeef; }
}

/// @dev Royalty receiver that tries to re-enter the marketplace when paid.
contract ReentrantReceiver {
    LegacyCollectionMarketplace public market;
    uint256 public listingId;
    bool public reentered;
    bool public reentrySucceeded;
    constructor(LegacyCollectionMarketplace m) { market = m; }
    function arm(uint256 id) external { listingId = id; }
    receive() external payable {
        if (reentered) return;
        reentered = true;
        try market.buy{value: 0}(listingId, 1) { reentrySucceeded = true; } catch {}
    }
}

/// @dev Buyer whose ERC-1155 receive hook tries to buy again before the first sale finishes.
contract ReentrantBuyer {
    LegacyCollectionMarketplace public market;
    uint256 public listingId;
    uint256 public price;
    bool public attempted;
    bool public reentrySucceeded;
    constructor(LegacyCollectionMarketplace m) { market = m; }
    receive() external payable {}
    function buyTwice(uint256 id, uint256 p) external payable {
        listingId = id; price = p;
        market.buy{value: p}(id, 1);
    }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (!attempted) {
            attempted = true;
            try market.buy{value: price}(listingId, 1) { reentrySucceeded = true; } catch {}
        }
        return 0xf23a6e61;
    }
}

contract LegacyCollectionMarketplaceTest {
    VmLegacy internal constant vm = VmLegacy(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant FEE = address(0xFEE5);
    address internal constant OWNER = address(0x0A11);
    address internal constant CREATOR = address(0xC4EA);
    address internal constant SELLER = address(0x5E11);
    address internal constant BUYER = address(0xB0B);
    address internal constant STRANGER = address(0x5757);
    uint256 internal constant PRICE = 1 ether;

    LegacyCollectionMarketplace internal market;
    MockGenesis internal genesis;

    function setUp() public {
        market = new LegacyCollectionMarketplace(FEE, 250, OWNER);
        genesis = new MockGenesis(CREATOR);
        vm.prank(OWNER);
        market.allowCollection(address(genesis), 500, 0, 3);
        genesis.mint(SELLER, 0, 5);
        genesis.mint(SELLER, 3, 1);
        vm.deal(BUYER, 100 ether);
        vm.deal(SELLER, 1 ether);
        vm.prank(SELLER);
        genesis.setApprovalForAll(address(market), true);
    }

    function list(uint256 id, uint256 amount, uint256 price) internal returns (uint256) {
        vm.prank(SELLER);
        return market.createListing(address(genesis), SELLER, id, amount, price, 0);
    }

    function expectFail(bytes memory call, address from, uint256 value) internal returns (bytes memory err) {
        vm.deal(from, from.balance + value);
        vm.prank(from);
        (bool ok, bytes memory ret) = address(market).call{value: value}(call);
        require(!ok, "call should revert");
        return ret;
    }

    function selector(bytes memory ret) internal pure returns (bytes4 s) { assembly { s := mload(add(ret, 32)) } }

    // 1. Authorized Genesis collection can be listed.
    function testAuthorizedGenesisCanBeListed() public {
        uint256 id = list(0, 2, PRICE);
        LegacyCollectionMarketplace.Listing memory l = market.getListing(id);
        require(l.seller == SELLER && l.tokenContract == address(genesis) && l.amount == 2 && l.price == PRICE, "listing stored");
        require(l.status == LegacyCollectionMarketplace.Status.ACTIVE, "active");
        require(market.isSupported(address(genesis), 3) && !market.isSupported(address(genesis), 4), "scope 0..3");
    }

    // 2. Non-allowlisted collections / token ids are rejected, and allowlisting is not automatic.
    function testNonAllowlistedCollectionAndTokenIdRejected() public {
        MockGenesis other = new MockGenesis(CREATOR);
        other.mint(SELLER, 0, 1);
        vm.prank(SELLER);
        other.setApprovalForAll(address(market), true);
        vm.prank(SELLER);
        try market.createListing(address(other), SELLER, 0, 1, PRICE, 0) { revert("other collection listed"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.UnsupportedCollection.selector, "UnsupportedCollection");
        }
        genesis.mint(SELLER, 4, 1);
        vm.prank(SELLER);
        try market.createListing(address(genesis), SELLER, 4, 1, PRICE, 0) { revert("token 4 listed"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.UnsupportedToken.selector, "UnsupportedToken");
        }
    }

    function testOnlyOwnerAdministersAndAllowlistingNeedsERC1155AndERC2981() public {
        MockGenesis noRoyalty = new MockGenesis(CREATOR);
        noRoyalty.setSupport(true, false);
        MockGenesis no1155 = new MockGenesis(CREATOR);
        no1155.setSupport(false, true);
        vm.prank(OWNER);
        try market.allowCollection(address(noRoyalty), 500, 0, 3) { revert("no ERC-2981"); } catch {}
        vm.prank(OWNER);
        try market.allowCollection(address(no1155), 500, 0, 3) { revert("no ERC-1155"); } catch {}
        vm.prank(OWNER);
        try market.allowCollection(address(0xBEEF), 500, 0, 3) { revert("EOA"); } catch {}
        vm.prank(OWNER);
        try market.allowCollection(address(genesis), 1001, 0, 3) { revert("royalty cap above ceiling"); } catch {}
        vm.prank(OWNER);
        try market.allowCollection(address(genesis), 500, 4, 3) { revert("inverted range"); } catch {}
        vm.prank(STRANGER);
        try market.allowCollection(address(genesis), 500, 0, 3) { revert("stranger allowlists"); } catch {}
        vm.prank(STRANGER);
        try market.setPaused(true) { revert("stranger pauses"); } catch {}
        vm.prank(STRANGER);
        try market.disableCollection(address(genesis)) { revert("stranger disables"); } catch {}
    }

    // 3. Seller cannot list tokens they do not own (or more than they own).
    function testCannotListUnownedOrExcessQuantity() public {
        vm.prank(STRANGER);
        try market.createListing(address(genesis), STRANGER, 0, 1, PRICE, 0) { revert("unowned"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.InsufficientBalance.selector, "InsufficientBalance");
        }
        vm.prank(SELLER);
        try market.createListing(address(genesis), SELLER, 0, 6, PRICE, 0) { revert("more than owned"); } catch {}
        vm.prank(STRANGER);
        try market.createListing(address(genesis), SELLER, 0, 1, PRICE, 0) { revert("listing on behalf of another"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.InvalidAddress.selector, "InvalidAddress");
        }
    }

    // 4. Missing approval prevents listing and purchase.
    function testMissingApprovalPreventsListingAndPurchase() public {
        vm.prank(SELLER);
        genesis.setApprovalForAll(address(market), false);
        vm.prank(SELLER);
        try market.createListing(address(genesis), SELLER, 0, 1, PRICE, 0) { revert("listed without approval"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.InsufficientApproval.selector, "InsufficientApproval");
        }
        vm.prank(SELLER);
        genesis.setApprovalForAll(address(market), true);
        uint256 id = list(0, 1, PRICE);
        vm.prank(SELLER);
        genesis.setApprovalForAll(address(market), false);
        bytes memory err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.InsufficientApproval.selector, "purchase blocked without approval");
        require(genesis.balanceOf(BUYER, 0) == 0 && genesis.balanceOf(SELLER, 0) == 5, "no token moved");
    }

    // 5. Unauthorized cancellation is rejected; seller can cancel, even when paused or the collection is disabled.
    function testCancellationPermissions() public {
        uint256 id = list(0, 1, PRICE);
        bytes memory err = expectFail(abi.encodeCall(market.cancelListing, (id)), STRANGER, 0);
        require(selector(err) == LegacyCollectionMarketplace.NotSeller.selector, "NotSeller");
        err = expectFail(abi.encodeCall(market.cancelListing, (id)), OWNER, 0);
        require(selector(err) == LegacyCollectionMarketplace.NotSeller.selector, "owner cannot cancel others' listings");
        vm.prank(OWNER);
        market.setPaused(true);
        vm.prank(OWNER);
        market.disableCollection(address(genesis));
        vm.prank(SELLER);
        market.cancelListing(id);
        require(market.listingStatus(id) == LegacyCollectionMarketplace.Status.CANCELLED, "cancelled");
        err = expectFail(abi.encodeCall(market.cancelListing, (id)), SELLER, 0);
        require(selector(err) == LegacyCollectionMarketplace.ListingNotActive.selector, "double cancel");
        err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.PausedMarket.selector, "paused blocks buy");
    }

    // 6-9. Purchase: ownership moves, seller proceeds, marketplace fee, and ERC-2981 royalty settle exactly.
    function testPurchaseSettlesFeeRoyaltyAndSellerExactly() public {
        uint256 id = list(0, 2, PRICE);
        uint256 sellerBefore = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: PRICE}(id, 1);
        require(genesis.balanceOf(BUYER, 0) == 1 && genesis.balanceOf(SELLER, 0) == 4, "ownership moved");
        require(FEE.balance == 0.025 ether, "2.5% platform fee");
        require(CREATOR.balance == 0.05 ether, "5% Genesis royalty (royaltyInfo)");
        require(SELLER.balance - sellerBefore == 0.925 ether, "92.5% to the seller");
        require(address(market).balance == 0, "marketplace holds no funds");
        LegacyCollectionMarketplace.Listing memory l = market.getListing(id);
        require(l.amount == 1 && l.status == LegacyCollectionMarketplace.Status.ACTIVE, "partial fill leaves 1");
        vm.prank(BUYER);
        market.buy{value: PRICE}(id, 1);
        require(market.listingStatus(id) == LegacyCollectionMarketplace.Status.SOLD, "sold out");
        require(FEE.balance == 0.05 ether && CREATOR.balance == 0.1 ether, "second sale settled");
    }

    // 10. Rounding and zero royalty.
    function testRoundingAndZeroRoyalty() public {
        uint256 odd = 333; // fee floor(333*250/10000)=8, royalty floor(333*500/10000)=16, seller 309
        uint256 id = list(0, 1, odd);
        uint256 sellerBefore = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: odd}(id, 1);
        require(FEE.balance == 8 && CREATOR.balance == 16 && SELLER.balance - sellerBefore == 309, "floor rounding, seller takes dust");
        require(FEE.balance + CREATOR.balance + (SELLER.balance - sellerBefore) == odd, "nothing lost or created");

        genesis.setRoyalty(CREATOR, 0);
        uint256 id2 = list(0, 1, PRICE);
        uint256 feeBefore = FEE.balance;
        uint256 creatorBefore = CREATOR.balance;
        uint256 sellerBefore2 = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: PRICE}(id2, 1);
        require(FEE.balance - feeBefore == 0.025 ether && CREATOR.balance == creatorBefore && SELLER.balance - sellerBefore2 == 0.975 ether, "zero royalty pays nobody extra");

        // 1 wei: every share floors to zero except the seller's.
        uint256 id3 = list(0, 1, 1);
        uint256 s3 = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: 1}(id3, 1);
        require(SELLER.balance - s3 == 1, "dust sale pays seller");
    }

    // 11. Invalid royalty responses and failing receivers can never produce an unpaid successful sale.
    function testBadRoyaltyResponsesRefuseTheSaleAndMoveNothing() public {
        uint256 id = list(0, 1, PRICE);
        for (uint256 mode = 1; mode <= 4; mode++) {
            genesis.setRoyaltyMode(mode);
            expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
            require(genesis.balanceOf(BUYER, 0) == 0 && genesis.balanceOf(SELLER, 0) == 5, "no transfer on bad royalty");
            vm.prank(SELLER);
            try market.createListing(address(genesis), SELLER, 0, 1, PRICE, 0) { revert("listing with unreadable royalty"); } catch {}
        }
        genesis.setRoyaltyMode(0);
        // Royalty raised above the cap by the collection owner after listing.
        genesis.setRoyalty(CREATOR, 900);
        bytes memory err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.RoyaltyAboveCap.selector, "royalty above cap refused");
        // Royalty to the zero address, or to the marketplace itself, while non-zero.
        genesis.setRoyalty(address(0), 500);
        err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.InvalidRoyaltyReceiver.selector, "zero receiver");
        genesis.setRoyalty(address(market), 500);
        err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.InvalidRoyaltyReceiver.selector, "self receiver");
        // Receiver that rejects AVAX: the whole sale reverts, buyer keeps nothing, nobody is paid.
        RejectsAvax bad = new RejectsAvax();
        genesis.setRoyalty(address(bad), 500);
        err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.TransferFailed.selector, "royalty payout failure reverts");
        require(genesis.balanceOf(BUYER, 0) == 0 && FEE.balance == 0 && address(market).balance == 0, "fully rolled back");
        require(market.getListing(id).amount == 1, "listing intact");
        // Seller that rejects AVAX (a contract holding Genesis).
        genesis.setRoyalty(CREATOR, 500);
        RejectsAvax contractSeller = new RejectsAvax();
        genesis.mint(address(contractSeller), 1, 1);
        vm.prank(address(contractSeller));
        genesis.setApprovalForAll(address(market), true);
        vm.prank(address(contractSeller));
        uint256 id2 = market.createListing(address(genesis), address(contractSeller), 1, 1, PRICE, 0);
        err = expectFail(abi.encodeCall(market.buy, (id2, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.TransferFailed.selector, "seller payout failure reverts");
        require(genesis.balanceOf(address(contractSeller), 1) == 1, "token stays with seller");
    }

    // Review finding: validate at the full quantity, and bound the royaltyInfo read.
    function testListingValidatedAtFullQuantityAndGasGriefingRoyaltyIsBounded() public {
        genesis.setRoyaltyMode(5);
        vm.prank(SELLER);
        try market.createListing(address(genesis), SELLER, 0, 2, PRICE, 0) { revert("bulk royalty above cap listed"); } catch (bytes memory e) {
            require(selector(e) == LegacyCollectionMarketplace.RoyaltyAboveCap.selector, "RoyaltyAboveCap at full quantity");
        }
        vm.prank(SELLER);
        market.createListing(address(genesis), SELLER, 0, 1, PRICE, 0); // one unit is fine
        genesis.setRoyaltyMode(6);
        vm.prank(SELLER);
        (bool ok,) = address(market).call{gas: 3_000_000}(abi.encodeCall(market.createListing, (address(genesis), SELLER, 0, 1, PRICE, uint64(0))));
        require(!ok, "gas-burning royaltyInfo refused, not run to exhaustion");
    }

    // 12. Reentrancy and malicious receivers.
    function testReentrantRoyaltyReceiverCannotBuyDuringSettlement() public {
        ReentrantReceiver attacker = new ReentrantReceiver(market);
        genesis.setRoyalty(address(attacker), 500);
        uint256 id = list(0, 3, PRICE);
        attacker.arm(id);
        vm.prank(BUYER);
        market.buy{value: PRICE}(id, 1);
        require(attacker.reentered() && !attacker.reentrySucceeded(), "re-entry attempted and blocked");
        require(market.getListing(id).amount == 2 && genesis.balanceOf(BUYER, 0) == 1, "exactly one unit sold");
    }

    function testReentrantBuyerHookCannotDoubleBuy() public {
        ReentrantBuyer attacker = new ReentrantBuyer(market);
        vm.deal(address(attacker), 10 ether);
        uint256 id = list(0, 3, PRICE);
        attacker.buyTwice{value: PRICE}(id, PRICE);
        require(attacker.attempted() && !attacker.reentrySucceeded(), "hook re-entry blocked");
        require(market.getListing(id).amount == 2 && genesis.balanceOf(address(attacker), 0) == 1, "exactly one unit sold");
    }

    function testReceiverThatRejectsTokenRollsBackTheSale() public {
        WrongSelectorReceiver bad = new WrongSelectorReceiver();
        vm.deal(address(bad), 2 ether);
        uint256 id = list(0, 1, PRICE);
        vm.prank(address(bad));
        (bool ok,) = address(market).call{value: PRICE}(abi.encodeCall(market.buy, (id, 1)));
        require(!ok, "sale to a rejecting receiver reverts");
        require(market.getListing(id).amount == 1 && SELLER.balance == 1 ether && FEE.balance == 0, "nothing moved or paid");
    }

    // 13. Invalid quantities, prices, stale and duplicate purchases.
    function testInvalidInputsStaleAndDuplicatePurchases() public {
        vm.prank(SELLER);
        try market.createListing(address(genesis), SELLER, 0, 0, PRICE, 0) { revert("zero amount"); } catch (bytes memory e) { require(selector(e) == LegacyCollectionMarketplace.InvalidAmount.selector, "InvalidAmount"); }
        vm.prank(SELLER);
        try market.createListing(address(genesis), SELLER, 0, 1, 0, 0) { revert("zero price"); } catch (bytes memory e) { require(selector(e) == LegacyCollectionMarketplace.InvalidPrice.selector, "InvalidPrice"); }
        vm.warp(1000);
        vm.prank(SELLER);
        try market.createListing(address(genesis), SELLER, 0, 1, PRICE, 999) { revert("expiry in the past"); } catch (bytes memory e) { require(selector(e) == LegacyCollectionMarketplace.InvalidExpiry.selector, "InvalidExpiry"); }

        uint256 id = list(0, 1, PRICE);
        bytes memory err = expectFail(abi.encodeCall(market.buy, (id, 0)), BUYER, 0);
        require(selector(err) == LegacyCollectionMarketplace.InsufficientQuantity.selector, "zero quantity");
        err = expectFail(abi.encodeCall(market.buy, (id, 2)), BUYER, 2 * PRICE);
        require(selector(err) == LegacyCollectionMarketplace.InsufficientQuantity.selector, "more than listed");
        err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE - 1);
        require(selector(err) == LegacyCollectionMarketplace.IncorrectPayment.selector, "underpayment");
        err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE + 1);
        require(selector(err) == LegacyCollectionMarketplace.IncorrectPayment.selector, "overpayment");
        err = expectFail(abi.encodeCall(market.buy, (999, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.ListingNotActive.selector, "unknown listing");

        vm.prank(BUYER);
        market.buy{value: PRICE}(id, 1);
        err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.ListingNotActive.selector, "duplicate purchase");

        // Stale: seller moved the token away after listing.
        uint256 id2 = list(0, 4, PRICE);
        vm.prank(SELLER);
        (bool moved,) = address(genesis).call(abi.encodeWithSignature("safeTransferFrom(address,address,uint256,uint256,bytes)", SELLER, STRANGER, uint256(0), uint256(4), ""));
        require(moved, "ordinary transfer");
        err = expectFail(abi.encodeCall(market.buy, (id2, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.InsufficientBalance.selector, "stale listing");

        // Expiry.
        genesis.mint(SELLER, 0, 1);
        vm.prank(SELLER);
        uint256 id3 = market.createListing(address(genesis), SELLER, 0, 1, PRICE, 2000);
        vm.warp(2001);
        err = expectFail(abi.encodeCall(market.buy, (id3, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.Expired.selector, "expired");
        vm.prank(STRANGER);
        market.expireListing(id3);
        require(market.listingStatus(id3) == LegacyCollectionMarketplace.Status.EXPIRED, "expired state");

        // A price whose arithmetic overflows can never be listed, so price * quantity can never underpay.
        genesis.mint(SELLER, 0, 2);
        vm.prank(SELLER);
        try market.createListing(address(genesis), SELLER, 0, 2, type(uint256).max / 2 + 1, 0) { revert("overflowing price listed"); } catch {}
        // A large but safe price still cannot be bought with a wrapped-around payment.
        vm.prank(SELLER);
        uint256 id4 = market.createListing(address(genesis), SELLER, 0, 2, type(uint256).max / 20_000, 0);
        err = expectFail(abi.encodeCall(market.buy, (id4, 2)), BUYER, 1);
        require(selector(err) == LegacyCollectionMarketplace.IncorrectPayment.selector, "wrong payment refused");
    }

    // 14. Ordinary transferability is untouched: the marketplace is never a custodian or a required hop.
    function testGenesisStaysTransferableBetweenOrdinaryWalletsAndMarketplaceHoldsNothing() public {
        uint256 id = list(0, 2, PRICE);
        vm.prank(SELLER);
        genesis.safeTransferFrom(SELLER, STRANGER, 0, 3, "");
        require(genesis.balanceOf(STRANGER, 0) == 3 && genesis.balanceOf(address(market), 0) == 0, "plain transfer works; no custody");
        vm.prank(STRANGER);
        genesis.safeTransferFrom(STRANGER, BUYER, 0, 1, "");
        require(genesis.balanceOf(BUYER, 0) == 1, "wallet to wallet");
        require(market.getListing(id).status == LegacyCollectionMarketplace.Status.ACTIVE, "listing unaffected until stale");
    }

    function testOperatorFilteredMarketplaceFailsSafely() public {
        uint256 id = list(0, 1, PRICE);
        genesis.setFiltered(address(market), true);
        bytes memory err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
        require(err.length > 0, "operator filter blocks the sale");
        require(genesis.balanceOf(BUYER, 0) == 0 && FEE.balance == 0 && CREATOR.balance == 0 && address(market).balance == 0, "reverted cleanly");
        vm.prank(SELLER);
        market.cancelListing(id);
    }

    function testGenesisAndMarketplaceAdministration() public {
        require(market.feeRecipient() == FEE && market.platformFeeBps() == 250 && market.owner() == OWNER, "wiring");
        try new LegacyCollectionMarketplace(FEE, 500, OWNER) { revert("fee other than 250"); } catch {}
        try new LegacyCollectionMarketplace(address(0), 250, OWNER) { revert("zero fee recipient"); } catch {}
        try new LegacyCollectionMarketplace(FEE, 250, address(0)) { revert("zero owner"); } catch {}
        vm.prank(OWNER);
        market.transferOwnership(STRANGER);
        require(market.owner() == OWNER, "two-step");
        vm.prank(BUYER);
        try market.acceptOwnership() { revert("only pending owner"); } catch {}
        vm.prank(STRANGER);
        market.acceptOwnership();
        require(market.owner() == STRANGER, "transferred");
        // No function exists to withdraw funds or move listings: a stray AVAX transfer is rejected outright.
        (bool ok,) = address(market).call{value: 1 wei}("");
        require(!ok, "no receive/fallback");
    }

    function testWrongChainRefusesEveryMutation() public {
        uint256 id = list(0, 1, PRICE);
        vm.chainId(1);
        bytes memory err = expectFail(abi.encodeCall(market.buy, (id, 1)), BUYER, PRICE);
        require(selector(err) == LegacyCollectionMarketplace.WrongDeploymentChain.selector, "wrong chain buy");
        err = expectFail(abi.encodeCall(market.cancelListing, (id)), SELLER, 0);
        require(selector(err) == LegacyCollectionMarketplace.WrongDeploymentChain.selector, "wrong chain cancel");
    }

    function testPreviewSettlementMatchesGenesisPolicy() public view {
        (uint256 fee, address receiver, uint256 royalty, uint256 proceeds) = market.previewSettlement(address(genesis), 0, 10 ether);
        require(fee == 0.25 ether && receiver == CREATOR && royalty == 0.5 ether && proceeds == 9.25 ether, "preview");
    }
}
