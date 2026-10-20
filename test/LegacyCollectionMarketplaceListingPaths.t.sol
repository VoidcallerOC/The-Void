// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegacyCollectionMarketplace} from "../contracts/LegacyCollectionMarketplace.sol";
import {MockGenesis, VmLegacy} from "./LegacyCollectionMarketplace.t.sol";

/// @notice There is exactly one way to create a listing, and it enforces every essential invariant: the collection allowlist, the
/// token-id scope, the royalty cap, seller authorization, balance, approval, sane price/amount/expiry, and a mandatory,
/// deliverable seller floor. The V4-shaped `createListing` (selector 0x5201ea65) does not exist on this marketplace.
/// @dev An ERC-1155 that reports success without delivering (mode 1) or delivers one unit short (mode 2): the failure the marketplace's
/// delivery check exists to catch. Passes the marketplace's ERC-165 allowlisting like a real collection.
contract FaultyToken {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    uint256 public mode;
    function mint(address to, uint256 id, uint256 v) external { balanceOf[to][id] += v; }
    function setMode(uint256 m) external { mode = m; }
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; }
    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x01ffc9a7 || id == 0xd9b67a26 || id == 0x2a55205a; }
    function royaltyInfo(uint256, uint256 price) external pure returns (address, uint256) { return (address(0xC4EA), (price * 500) / 10_000); }
    function safeTransferFrom(address from, address to, uint256 id, uint256 v, bytes calldata) external {
        if (mode == 1) return; // claims success, moves nothing
        uint256 moved = mode == 2 ? v - 1 : v;
        balanceOf[from][id] -= moved;
        balanceOf[to][id] += moved;
    }
}

contract LegacyCollectionMarketplaceListingPathsTest {
    VmLegacy internal constant vm = VmLegacy(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant FEE = address(0xFEE5);
    address internal constant OWNER = address(0x0A11);
    address internal constant CREATOR = address(0xC4EA);
    address internal constant SELLER = address(0x5E11);
    address internal constant BUYER = address(0xB0B);
    address internal constant STRANGER = address(0x5757);
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant EXACT_FLOOR = 0.925 ether;

    LegacyCollectionMarketplace internal market;
    MockGenesis internal genesis;

    function setUp() public {
        market = new LegacyCollectionMarketplace(FEE, 250, OWNER);
        genesis = new MockGenesis(CREATOR);
        vm.prank(OWNER);
        market.allowCollection(address(genesis), 500, 0, 3);
        genesis.mint(SELLER, 0, 10);
        genesis.mint(SELLER, 4, 10); // exists on the token, outside the allowlisted range
        vm.deal(BUYER, 100 ether);
        vm.prank(SELLER);
        genesis.setApprovalForAll(address(market), true);
    }

    function selector(bytes memory ret) internal pure returns (bytes4 s) { assembly { s := mload(add(ret, 32)) } }

    /// Calls the single creation function as `from` and returns the revert selector (0 if it succeeded).
    function tryCreate(address from, address collection, address sellerArg, uint256 id, uint256 amount, uint256 price, uint64 expiry, uint256 floor) internal returns (bytes4) {
        vm.prank(from);
        (bool ok, bytes memory ret) = address(market).call(abi.encodeCall(market.createListingWithMinProceeds, (collection, sellerArg, id, amount, price, expiry, floor)));
        return ok ? bytes4(0) : selector(ret);
    }

    // ---------------------------------------------------------------- the old entry point is gone

    function testTheV4ShapedCreateListingSelectorDoesNotExistAndCreatesNothing() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x5201ea65), address(genesis), SELLER, uint256(0), uint256(1), PRICE, uint64(0));
        vm.prank(SELLER);
        (bool ok,) = address(market).call(data);
        require(!ok, "no function (and no fallback) answers the V4 creation selector");
        require(market.nextListingId() == 1, "no listing id consumed");
        require(market.getListing(1).seller == address(0), "no listing created");
        // and it cannot be reached by sending bare value or empty calldata either
        vm.prank(SELLER);
        (bool bare,) = address(market).call("");
        require(!bare, "no fallback");
    }

    // ---------------------------------------------------------------- one path, every invariant

    function testTheSingleCreationPathEnforcesEveryEssentialInvariant() public {
        // authorization: msg.sender must be the seller; zero addresses refused
        require(tryCreate(STRANGER, address(genesis), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.InvalidAddress.selector, "listing on behalf of another");
        require(tryCreate(SELLER, address(genesis), address(0), 0, 1, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.InvalidAddress.selector, "zero seller");
        require(tryCreate(SELLER, address(0), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.InvalidAddress.selector, "zero collection");
        // allowlist and scope
        require(tryCreate(SELLER, address(new MockGenesis(CREATOR)), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.UnsupportedCollection.selector, "non-allowlisted collection");
        require(tryCreate(SELLER, address(genesis), SELLER, 4, 1, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.UnsupportedToken.selector, "token id 4 outside 0-3");
        // amounts, price, expiry
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 0, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.InvalidAmount.selector, "zero amount");
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, 0, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.InvalidPrice.selector, "zero price");
        vm.warp(1000);
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 999, EXACT_FLOOR) == LegacyCollectionMarketplace.InvalidExpiry.selector, "expiry in the past");
        // balance and approval
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 11, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.InsufficientBalance.selector, "more than owned");
        vm.prank(SELLER);
        genesis.setApprovalForAll(address(market), false);
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.InsufficientApproval.selector, "missing approval");
        vm.prank(SELLER);
        genesis.setApprovalForAll(address(market), true);
        // royalty cap and readability at listing time
        genesis.setRoyalty(CREATOR, 501);
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.RoyaltyAboveCap.selector, "501 bps");
        genesis.setRoyalty(CREATOR, 500);
        genesis.setRoyaltyMode(1);
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.RoyaltyReadFailed.selector, "royaltyInfo reverts");
        genesis.setRoyaltyMode(0);
        // pause
        vm.prank(OWNER);
        market.setPaused(true);
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR) == LegacyCollectionMarketplace.PausedMarket.selector, "paused");
        vm.prank(OWNER);
        market.setPaused(false);
        require(market.nextListingId() == 1, "none of the refusals consumed a listing id");
        // and the one valid shape works
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR) == bytes4(0), "valid listing");
        require(market.nextListingId() == 2 && market.minSellerProceedsPerUnit(1) == EXACT_FLOOR, "listed with its floor");
    }

    // ---------------------------------------------------------------- the floor is mandatory, deliverable, and can never be cleared

    function testTheFloorIsMandatoryDeliverableAndNeverClearable() public {
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 0, 0) == LegacyCollectionMarketplace.MinProceedsRequired.selector, "zero floor refused at creation");
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 0, PRICE + 1) == LegacyCollectionMarketplace.MinProceedsTooHigh.selector, "floor above the price");
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR + 1) == LegacyCollectionMarketplace.MinProceedsTooHigh.selector, "floor above what the live royalty delivers");
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR) == bytes4(0), "exact-rate floor accepted");

        // the floor cannot be cleared or made undeliverable afterwards
        vm.prank(SELLER);
        (bool ok, bytes memory ret) = address(market).call(abi.encodeCall(market.setMinSellerProceeds, (1, 0)));
        require(!ok && selector(ret) == LegacyCollectionMarketplace.MinProceedsRequired.selector, "cannot clear the floor");
        vm.prank(SELLER);
        (ok, ret) = address(market).call(abi.encodeCall(market.setMinSellerProceeds, (1, PRICE)));
        require(!ok && selector(ret) == LegacyCollectionMarketplace.MinProceedsTooHigh.selector, "cannot raise it past what is deliverable");
        require(market.minSellerProceedsPerUnit(1) == EXACT_FLOOR, "floor unchanged by the refused updates");
        // a stranger still gets NotSeller before anything else
        vm.prank(STRANGER);
        (ok, ret) = address(market).call(abi.encodeCall(market.setMinSellerProceeds, (1, 1)));
        require(!ok && selector(ret) == LegacyCollectionMarketplace.NotSeller.selector, "authorization first");
    }

    // ---------------------------------------------------------------- tiny prices: where no protective floor can exist

    function testAOneWeiPriceHasNoProtectiveFloorAndIsRefusedSafely() public {
        // exact-rate share of 1 wei at 92.5% is 0 wei: the app cannot express a floor, and the contract refuses a zero one.
        require((uint256(1) * (10_000 - 250 - 500)) / 10_000 == 0, "the exact-rate share rounds to zero");
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 1, 1, 0, 0) == LegacyCollectionMarketplace.MinProceedsRequired.selector, "zero floor at 1 wei");
        genesis.mint(SELLER, 0, 100);
        // A 1 wei floor at 1 wei per unit is deliverable only while rounding leaves every unit's wei with the seller: the 5% royalty
        // first rounds up to 1 wei at 20 units (floor(20*500/10000) = 1), so 19 units pass and 20 are refused as undeliverable.
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 19, 1, 0, 1) == bytes4(0), "19 units at 1 wei with a 1 wei floor");
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 10, 1, 0, 1) == bytes4(0), "10 units");
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 20, 1, 0, 1) == LegacyCollectionMarketplace.MinProceedsTooHigh.selector, "20 units: the royalty takes 1 wei, so the floor is undeliverable");
    }

    // ---------------------------------------------------------------- a listing that can never settle safely is never created

    function testNoListingCanBeCreatedThatCannotBePurchasedSafely() public {
        uint256 id;
        // every accepted listing is buyable in full at the live royalty, with the floor honored
        require(tryCreate(SELLER, address(genesis), SELLER, 0, 5, PRICE, 0, EXACT_FLOOR) == bytes4(0), "listed");
        id = 1;
        uint256 sellerBefore = SELLER.balance;
        vm.prank(BUYER);
        market.buy{value: 5 * PRICE}(id, 5);
        require(SELLER.balance - sellerBefore >= EXACT_FLOOR * 5 && genesis.balanceOf(BUYER, 0) == 5, "settled and delivered");
        require(address(market).balance == 0, "no funds stranded");
    }

    // ---------------------------------------------------------------- independent-review findings, closed in code

    function _faulty(uint256 mode) internal returns (FaultyToken token, uint256 id) {
        token = new FaultyToken();
        vm.prank(OWNER);
        market.allowCollection(address(token), 500, 0, 3);
        token.mint(SELLER, 0, 10);
        token.setMode(mode);
        vm.prank(SELLER);
        token.setApprovalForAll(address(market), true);
        vm.prank(SELLER);
        id = market.createListingWithMinProceeds(address(token), SELLER, 0, 4, PRICE, 0, EXACT_FLOOR);
    }

    function testATokenThatReportsSuccessWithoutDeliveringCannotTakeTheBuyersMoney() public {
        (FaultyToken token, uint256 id) = _faulty(1);
        uint256 buyerBefore = BUYER.balance;
        vm.prank(BUYER);
        (bool ok, bytes memory ret) = address(market).call{value: PRICE}(abi.encodeCall(market.buy, (id, 1)));
        require(!ok && selector(ret) == LegacyCollectionMarketplace.TokensNotDelivered.selector, "TokensNotDelivered");
        require(BUYER.balance == buyerBefore && FEE.balance == 0 && CREATOR.balance == 0 && address(market).balance == 0, "no payment kept or paid");
        require(token.balanceOf(BUYER, 0) == 0 && market.getListing(id).amount == 4, "listing intact");
    }

    function testATokenThatDeliversOneUnitShortIsRefused() public {
        (, uint256 id) = _faulty(2);
        vm.prank(BUYER);
        (bool ok, bytes memory ret) = address(market).call{value: 3 * PRICE}(abi.encodeCall(market.buy, (id, 3)));
        require(!ok && selector(ret) == LegacyCollectionMarketplace.TokensNotDelivered.selector, "short delivery refused");
        require(market.getListing(id).amount == 4 && BUYER.balance == 100 ether, "nothing moved");
    }

    function testAHonestTokenStillSettlesThroughTheDeliveryCheck() public {
        (FaultyToken token, uint256 id) = _faulty(0);
        vm.prank(BUYER);
        market.buy{value: 4 * PRICE}(id, 4);
        require(token.balanceOf(BUYER, 0) == 4 && address(market).balance == 0, "delivered and settled");
    }

    function testSelfPurchaseIsRefusedAndAnotherWalletCanStillBuy() public {
        vm.prank(SELLER);
        uint256 id = market.createListingWithMinProceeds(address(genesis), SELLER, 0, 2, PRICE, 0, EXACT_FLOOR);
        vm.deal(SELLER, 5 ether);
        vm.prank(SELLER);
        (bool ok, bytes memory ret) = address(market).call{value: PRICE}(abi.encodeCall(market.buy, (id, 1)));
        require(!ok && selector(ret) == LegacyCollectionMarketplace.SelfPurchase.selector, "SelfPurchase");
        require(SELLER.balance == 5 ether && genesis.balanceOf(SELLER, 0) == 10, "nothing moved");
        vm.prank(BUYER);
        market.buy{value: PRICE}(id, 1);
        require(genesis.balanceOf(BUYER, 0) == 1, "a different wallet buys normally");
    }

    function testListingStatusOfAnUnknownIdRevertsInsteadOfReadingActive() public {
        vm.prank(SELLER);
        (bool ok, bytes memory ret) = address(market).call(abi.encodeCall(market.listingStatus, (12345)));
        require(!ok && selector(ret) == LegacyCollectionMarketplace.UnknownListing.selector, "UnknownListing");
        vm.prank(SELLER);
        (ok, ret) = address(market).call(abi.encodeCall(market.listingStatus, (0)));
        require(!ok && selector(ret) == LegacyCollectionMarketplace.UnknownListing.selector, "id 0 too");
        // getListing keeps the V4 shape: an unknown id is an all-zero struct
        require(market.getListing(12345).seller == address(0) && market.getListing(12345).amount == 0, "zero struct");
        vm.prank(SELLER);
        uint256 id = market.createListingWithMinProceeds(address(genesis), SELLER, 0, 1, PRICE, 0, EXACT_FLOOR);
        require(market.listingStatus(id) == LegacyCollectionMarketplace.Status.ACTIVE, "a real listing reports its status");
        vm.prank(SELLER);
        market.cancelListing(id);
        require(market.listingStatus(id) == LegacyCollectionMarketplace.Status.CANCELLED, "and keeps reporting it");
    }
}
