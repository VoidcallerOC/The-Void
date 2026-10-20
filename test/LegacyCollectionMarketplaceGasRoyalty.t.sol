// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegacyCollectionMarketplace} from "../contracts/LegacyCollectionMarketplace.sol";

interface VmGas {
    function prank(address) external;
    function deal(address, uint256) external;
    function cool(address) external; // marks an account and its storage slots cold again (a forge test is one transaction)
}

/// @dev A hostile-but-ERC-165-valid ERC-1155/2981 collection whose `royaltyInfo` reads `gasleft()` (finding M-1).
///   mode 1 "proportional": bps = min(500, gasleft()/200)  -> the creator's payout is a direct readout of the gas the callee saw
///   mode 2 "threshold":    bps = gasleft() >= threshold ? 500 : 0 -> the attack: a low royalty when the buyer supplies less gas
///   mode 3 "warm probe":   like mode 1, but first SLOADs `probe` (cold 2100 gas, warm 100) to show access-list sensitivity
/// `ballast` is the number of fresh SSTOREs `safeTransferFrom` performs, to model how expensive a real collection's transfer is.
contract GasSensitiveCollection {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => uint256) private ballastSlots;
    uint256 public mode = 1;
    uint256 public threshold;
    uint256 public ballast;
    bool public cheapest; // deliver with ONE warm-ish SSTORE on the buyer's existing balance and never debit the seller
    uint256 public probe = 1;
    uint256 private nonce;
    address public receiver;

    constructor(address receiver_) { receiver = receiver_; }
    function mint(address to, uint256 id, uint256 v) external { balanceOf[to][id] += v; }
    function setMode(uint256 m, uint256 t) external { mode = m; threshold = t; }
    function setBallast(uint256 b) external { ballast = b; }
    function setCheapest(bool c) external { cheapest = c; }
    function touch() external view returns (uint256) { return probe; } // pre-warms `probe` for the rest of the transaction
    function setApprovalForAll(address op, bool ok) external { isApprovedForAll[msg.sender][op] = ok; }
    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x01ffc9a7 || id == 0xd9b67a26 || id == 0x2a55205a; }

    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        uint256 m = mode;
        uint256 t = threshold;
        uint256 p = probe; // a storage read whose cost (cold 2100 / warm 100) depends on the access list
        uint256 g = gasleft();
        if (p == 0xdead) g = 0; // keeps the read live; never true
        uint256 bps;
        if (m == 2) bps = g >= t ? 500 : 0;
        else { bps = g / 200; if (bps > 500) bps = 500; }
        return (receiver, (price * bps) / 10_000);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 v, bytes calldata) external {
        for (uint256 i = 0; i < ballast; i++) ballastSlots[uint256(keccak256(abi.encode(++nonce)))] = 1; // fresh slots: 22.1k gas each
        if (cheapest) { balanceOf[to][id] += v; return; }
        balanceOf[from][id] -= v;
        balanceOf[to][id] += v;
    }
}

/// @dev Pre-warms the collection's `probe` slot in the same transaction before buying: what an EIP-2930 access list does for free.
contract PrewarmBuyer {
    function buy(LegacyCollectionMarketplace market, GasSensitiveCollection token, uint256 listingId, uint256 q, bool prewarm) external payable {
        if (prewarm) token.touch();
        market.buy{value: msg.value}(listingId, q);
    }
    receive() external payable {}
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
}

contract LegacyCollectionMarketplaceGasRoyaltyTest {
    VmGas internal constant vm = VmGas(address(uint160(uint256(keccak256("hevm cheat code")))));
    event log_named_uint(string key, uint256 val);

    address internal constant FEE = address(0xFEE5);
    address internal constant OWNER = address(0x0A11);
    address internal constant CREATOR = address(0xC4EA);
    address internal constant SELLER = address(0x5E11);
    address internal constant BUYER = address(0xB0B);
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant FLOOR_AT_5PCT = 0.925 ether;

    LegacyCollectionMarketplace internal market;
    GasSensitiveCollection internal token;

    function setUp() public {
        market = new LegacyCollectionMarketplace(FEE, 250, OWNER);
        token = new GasSensitiveCollection(CREATOR);
        vm.prank(OWNER);
        market.allowCollection(address(token), 500, 0, 3);
        vm.deal(BUYER, 10_000 ether);
        token.mint(SELLER, 0, 100_000);
        vm.prank(SELLER);
        token.setApprovalForAll(address(market), true);
    }

    /// A real purchase starts with the collection, seller, creator and fee recipient cold; a forge test is one long transaction.
    function _cool() internal {
        vm.cool(address(token));
        vm.cool(CREATOR);
        vm.cool(SELLER);
        vm.cool(FEE);
    }

    struct Outcome { bool ok; uint256 royalty; uint256 seller; uint256 fee; uint256 residue; }

    /// One fresh listing + one purchase of 1 unit with an exact transaction-gas limit for the marketplace call.
    function buyWithGas(uint256 gasLimit) internal returns (Outcome memory o) {
        vm.prank(SELLER);
        uint256 id = market.createListingWithMinProceeds(address(token), SELLER, 0, 1, PRICE, 0, FLOOR_AT_5PCT);
        _cool();
        uint256 creatorBefore = CREATOR.balance;
        uint256 sellerBefore = SELLER.balance;
        uint256 feeBefore = FEE.balance;
        vm.prank(BUYER);
        (bool ok,) = address(market).call{value: PRICE, gas: gasLimit}(abi.encodeCall(market.buy, (id, 1)));
        o = Outcome(ok, CREATOR.balance - creatorBefore, SELLER.balance - sellerBefore, FEE.balance - feeBefore, address(market).balance);
    }

    struct Sweep {
        uint256 okCount; uint256 minOk; uint256 firstRoyalty; bool varies;
        uint256 zeroCount; uint256 fullCount; uint256 windowLo; uint256 windowHi;
        uint256 maxRoyalty; bool floorHeld; bool conserved; bool failedMovedNothing;
    }

    /// Fresh listing + purchase for every gas limit in [from, to] (step `step`); the marketplace call gets exactly that gas.
    function sweep(uint256 from, uint256 to, uint256 step) internal returns (Sweep memory s) {
        s.floorHeld = true; s.conserved = true; s.failedMovedNothing = true;
        for (uint256 g = from; g <= to; g += step) {
            Outcome memory o = buyWithGas(g);
            if (!o.ok) {
                if (o.royalty != 0 || o.seller != 0 || o.fee != 0 || o.residue != 0) s.failedMovedNothing = false;
                continue;
            }
            if (s.okCount == 0) { s.minOk = g; s.firstRoyalty = o.royalty; }
            else if (o.royalty != s.firstRoyalty) s.varies = true;
            s.okCount++;
            if (o.royalty > s.maxRoyalty) s.maxRoyalty = o.royalty;
            if (o.royalty == 0) { s.zeroCount++; if (s.windowLo == 0) s.windowLo = g; s.windowHi = g; }
            if (o.royalty == PRICE * 500 / 10_000) s.fullCount++;
            if (o.seller < FLOOR_AT_5PCT) s.floorHeld = false;
            if (o.seller + o.royalty + o.fee != PRICE || o.residue != 0) s.conserved = false;
        }
    }

    function _assertInvariants(Sweep memory s) internal pure {
        require(s.okCount > 0, "some gas limits complete the sale");
        require(s.maxRoyalty <= PRICE * 500 / 10_000, "the 500 bps cap holds at every gas limit");
        require(s.floorHeld, "the seller floor holds at every gas limit");
        require(s.conserved, "fee + royalty + seller == price with no residue, at every gas limit");
        require(s.failedMovedNothing, "a purchase that fails for lack of gas moves nothing");
    }

    // ---------------------------------------------------------------- 1. a collection with ordinary costs: no buyer-chosen royalty

    /// A gas-READING collection with a realistic delivery cost (a real ERC-1155 writes fresh balance slots, and hooks add more):
    /// every transaction that completes the sale has necessarily been given enough gas for the full 100k to reach royaltyInfo, so the royalty
    /// is identical at every completing gas limit. The lever does not exist.
    function testAGasReadingCollectionWithRealisticCostsPaysTheSameRoyaltyAtEveryCompletingGasLimit() public {
        token.setMode(1, 0);
        Sweep memory s = sweep(100_000, 260_000, 100);
        emit log_named_uint("lowest completing tx gas limit", s.minOk);
        emit log_named_uint("completing gas limits sampled", s.okCount);
        _assertInvariants(s);
        require(!s.varies, "the royalty never depends on the buyer's gas limit once the sale completes");
    }

    /// Even delivering with a single SSTORE on the buyer's existing balance (no seller debit) leaves the proportional collection unable to
    /// vary: the cheapest completing transaction already forwards the full 100k.
    function testCheapestDeliveryAloneDoesNotCreateAWindow() public {
        token.setMode(1, 0);
        token.setCheapest(true);
        token.mint(BUYER, 0, 1_000_000);
        Sweep memory s = sweep(100_000, 200_000, 100);
        emit log_named_uint("lowest completing tx gas limit (cheapest delivery)", s.minOk);
        _assertInvariants(s);
        require(!s.varies, "no variation: the first completing gas limit already saturates the royalty");
    }

    // ---------------------------------------------------------------- 2. M-1 as described: reproduced only by a deliberately hostile design

    /// Threshold collection + cheapest possible delivery. When the callee sees less than T it returns 0, which also skips the creator payout
    /// and makes the transaction cheaper, so the sale can complete at a gas limit that forwards less than 100k. The buyer who picks such a limit
    /// makes the creator receive nothing. Everything else holds: cap, seller floor, conservation, fee.
    function testAHostileCollectionLetsTheBuyerPickAZeroRoyaltyButNothingElseMoves() public {
        token.setMode(2, 92_500); // a full 100k forward leaves the callee ~93.2k -> 5%; less -> 0%
        token.setCheapest(true);
        token.mint(BUYER, 0, 1_000_000);
        Sweep memory s = sweep(115_000, 140_000, 50);
        emit log_named_uint("lowest completing gas limit", s.minOk);
        emit log_named_uint("window: first gas limit paying a ZERO royalty", s.windowLo);
        emit log_named_uint("window: last gas limit paying a ZERO royalty", s.windowHi);
        emit log_named_uint("gas limits paying the full 5%", s.fullCount);
        _assertInvariants(s);
        require(s.zeroCount > 0 && s.fullCount > 0, "M-1 reproduced: the buyer's gas limit selects between 0% and 5%");
        require(s.windowHi > s.windowLo, "the zero-royalty regime is a band of gas limits, not a single value");
        require(s.windowHi < 150_000, "and it sits entirely below the gas needed to forward the full cap with the creator payout");
    }

    function testTheSellerReceivesExactlyTheRoyaltyTheCreatorDidNotAndTheFeeIsUnchanged() public {
        token.setMode(2, 92_500);
        token.setCheapest(true);
        token.mint(BUYER, 0, 1_000_000);
        uint256 lowGas; uint256 highGas;
        for (uint256 g = 115_000; g <= 140_000 && (lowGas == 0 || highGas == 0); g += 50) {
            Outcome memory o = buyWithGas(g);
            if (o.ok && o.royalty == 0 && lowGas == 0) lowGas = g;
            if (o.ok && o.royalty == PRICE * 500 / 10_000 && highGas == 0) highGas = g;
        }
        require(lowGas != 0 && highGas != 0, "both regimes found");
        Outcome memory lo = buyWithGas(lowGas);
        Outcome memory hi = buyWithGas(highGas);
        require(lo.royalty == 0 && hi.royalty == 0.05 ether, "creator: 0 vs 5%");
        require(lo.seller == hi.seller + 0.05 ether, "the seller (never the buyer) receives exactly the royalty the creator did not");
        require(lo.fee == hi.fee, "the platform fee is unchanged");
        require(lo.seller >= FLOOR_AT_5PCT, "and the seller is never below the floor");
    }

    // ---------------------------------------------------------------- 3. relevance: ordinary delivery costs close the window

    function testARealisticTransferCostClosesTheHostileWindow() public {
        token.setMode(2, 92_500);
        token.setBallast(4); // four fresh SSTOREs, as a real ERC-1155 plus hooks costs
        Sweep memory s = sweep(100_000, 300_000, 200);
        emit log_named_uint("completing gas limits sampled (ballast 4)", s.okCount);
        _assertInvariants(s);
        require(s.zeroCount == 0, "no completing gas limit lets even a threshold collection see less than the full cap");
    }

    // ---------------------------------------------------------------- 4. the access list lever survives any 'forward the full 100k' gate

    /// Even with ample gas (so the full 100k is forwarded), what the callee sees shifts by ~2,000 gas depending on whether storage it
    /// reads is warm, and a buyer controls that through an EIP-2930 access list (modelled here by touching the slot first).
    function testPrewarmingShiftsWhatTheCalleeSeesEvenWhenTheFullCapIsForwarded() public {
        token.setMode(3, 0);
        PrewarmBuyer buyer = new PrewarmBuyer();
        vm.deal(address(buyer), 100 ether);
        vm.prank(SELLER);
        uint256 coldId = market.createListingWithMinProceeds(address(token), SELLER, 0, 1, PRICE, 0, FLOOR_AT_5PCT);
        vm.prank(SELLER);
        uint256 warmId = market.createListingWithMinProceeds(address(token), SELLER, 0, 1, PRICE, 0, FLOOR_AT_5PCT);
        _cool();
        uint256 before = CREATOR.balance;
        buyer.buy{value: PRICE, gas: 3_000_000}(market, token, coldId, 1, false);
        uint256 cold = CREATOR.balance - before;
        _cool();
        before = CREATOR.balance;
        buyer.buy{value: PRICE, gas: 3_000_000}(market, token, warmId, 1, true);
        uint256 warm = CREATOR.balance - before;
        emit log_named_uint("royalty with a cold slot (wei)", cold);
        emit log_named_uint("royalty with the slot pre-warmed (wei)", warm);
        require(cold <= 0.05 ether && warm <= 0.05 ether, "cap holds");
        require(warm > cold, "with ample gas (full 100k forwarded) pre-warming still changes what the callee observes");
    }

    // ---------------------------------------------------------------- 5. the proposed two-call consistency check

    /// Two back-to-back reads under the same transaction gas agree for a gas-sensitive collection, so 'call twice and compare'
    /// passes while the (attacker-chosen) value is exactly the one that would be paid.
    function testTwoMatchingResponsesDoNotEstablishThePolicyOrFutureResponses() public {
        token.setMode(2, 95_000);
        TwoCallProbe probe = new TwoCallProbe();
        uint256 agreeLow; uint256 agreeFull; uint256 disagree;
        for (uint256 g = 90_000; g <= 140_000; g += 250) {
            (uint256 a, uint256 b) = probe.read{gas: g}(address(token), PRICE);
            if (a == b && a == 0) agreeLow++;
            else if (a == b && a == 0.05 ether) agreeFull++;
            else disagree++;
        }
        emit log_named_uint("frame gas levels where both reads agree on the LOW (attack) value", agreeLow);
        emit log_named_uint("frame gas levels where both reads agree on the full value", agreeFull);
        emit log_named_uint("frame gas levels where the two reads disagree", disagree);
        require(agreeLow > 0, "a 'call twice and compare' check ACCEPTS the attack value: both reads return the low royalty");
        require(agreeFull > 0, "and accepts the honest value");
        require(disagree * 250 <= 5_000, "the two reads disagree only inside a narrow band (~2k gas) between the regimes, which an attacker avoids");
        // Matching reads in one frame say nothing about any other transaction: the same collection answers differently at listing time.
        token.setMode(1, 0);
        (uint256 later,) = probe.read{gas: 3_000_000}(address(token), PRICE);
        require(later != 0, "after the collection changed its policy the answer is no longer the low value the earlier agreeing reads showed");
    }


}

contract TwoCallProbe {
    /// Calls royaltyInfo twice the way the marketplace does (staticcall, 100k cap) and returns both amounts.
    function read(address token, uint256 price) external view returns (uint256 a, uint256 b) {
        (, a) = _one(token, price);
        (, b) = _one(token, price);
    }
    function _one(address token, uint256 price) private view returns (address r, uint256 amt) {
        (bool ok, bytes memory data) = token.staticcall{gas: 100_000}(abi.encodeWithSignature("royaltyInfo(uint256,uint256)", uint256(0), price));
        if (ok && data.length == 64) (r, amt) = abi.decode(data, (address, uint256));
    }
}
