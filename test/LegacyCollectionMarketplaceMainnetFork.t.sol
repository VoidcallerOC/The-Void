// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegacyCollectionMarketplace} from "../contracts/LegacyCollectionMarketplace.sol";

interface VmLegacyFork {
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function prank(address) external;
    function deal(address, uint256) external;
    function skip(bool) external;
    function cool(address) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

interface IGenesis {
    function balanceOf(address, uint256) external view returns (uint256);
    function setApprovalForAll(address, bool) external;
    function safeTransferFrom(address, address, uint256, uint256, bytes calldata) external;
    function royaltyInfo(uint256, uint256) external view returns (address, uint256);
    function operatorFilterRegistry() external view returns (address);
    function setRoyaltyInfo(address receiver, uint96 feePercent) external;
    function owner() external view returns (address);
}

interface IOperatorFilterRegistry {
    function isOperatorAllowed(address registrant, address operator) external view returns (bool);
}

interface IV4 {
    function createListing(address tokenContract, address seller, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt) external returns (uint256);
}

/// Exercises LegacyCollectionMarketplace against the REAL Genesis proxy, its real operator filter and real
/// royaltyInfo on a local fork of Avalanche C-Chain. Nothing is broadcast. Skipped unless MAINNET_FORK_RPC is set.
contract LegacyCollectionMarketplaceMainnetForkTest {
    VmLegacyFork internal constant vm = VmLegacyFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    event log_named_uint(string key, uint256 val);
    IGenesis internal constant GENESIS = IGenesis(0xD1B4367dd9f235f9ee61878019d66E31511E98eE);
    address internal constant V4_MARKET = 0x0e77116142844478a55EEd2Ab79de9F93770F8f5;
    address internal constant PLATFORM = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant CREATOR = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant HOLDER = 0xAe78E365285dB9BfA0FB231038f75f8f3Cc11588; // real Genesis holder: 7/2/2/2 of tokens 0-3
    address internal constant BUYER = address(0xB0B);
    address internal constant WALLET = address(0xCAFE);
    address internal constant OWNER = address(0x0A11);
    uint256 internal constant PRICE = 1 ether;

    LegacyCollectionMarketplace internal market;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) { vm.skip(true); return; } // reported as skipped, never as a vacuous pass
        vm.createSelectFork(rpc);
        forked = true;
        require(block.chainid == 43114, "not C-Chain");
        market = new LegacyCollectionMarketplace(PLATFORM, 250, OWNER);
        vm.prank(OWNER);
        market.allowCollection(address(GENESIS), 500, 0, 3);
        vm.deal(BUYER, 10 ether);
    }

    function testRealGenesisFacts() public view {
        if (!forked) return;
        (address receiver, uint256 amount) = GENESIS.royaltyInfo(0, 10_000);
        require(receiver == CREATOR && amount == 500, "Genesis royalty is 500 bps to the creator");
        require(IOperatorFilterRegistry(GENESIS.operatorFilterRegistry()).isOperatorAllowed(address(GENESIS), address(market)), "filter allows this marketplace today");
        require(GENESIS.balanceOf(HOLDER, 0) >= 3, "holder balance");
    }

    function testExistingV4MarketplaceStillRefusesGenesis() public {
        if (!forked) return;
        vm.prank(HOLDER);
        (bool ok,) = V4_MARKET.call(abi.encodeCall(IV4.createListing, (address(GENESIS), HOLDER, 0, 1, PRICE, 0)));
        require(!ok, "V4 must keep refusing a non-factory collection");
    }

    function testRealGenesisHolderListsAndSecondAccountBuysWithExactSettlement() public {
        if (!forked) return;
        vm.prank(HOLDER);
        GENESIS.setApprovalForAll(address(market), true); // passes the real operator filter
        vm.prank(HOLDER);
        uint256 id = market.createListingWithMinProceeds(address(GENESIS), HOLDER, 0, 2, PRICE, 0, 1);

        uint256 holderBefore = GENESIS.balanceOf(HOLDER, 0);
        uint256 holderAvax = HOLDER.balance;
        uint256 feeAvax = PLATFORM.balance;
        uint256 creatorAvax = CREATOR.balance;
        vm.prank(BUYER);
        market.buy{value: PRICE}(id, 1);

        require(GENESIS.balanceOf(BUYER, 0) == 1 && GENESIS.balanceOf(HOLDER, 0) == holderBefore - 1, "token moved through the real operator filter");
        require(PLATFORM.balance - feeAvax == 0.025 ether, "2.5% platform fee");
        require(CREATOR.balance - creatorAvax == 0.05 ether, "5% Genesis royalty to the creator");
        require(HOLDER.balance - holderAvax == 0.925 ether, "92.5% to the seller");
        require(address(market).balance == 0, "marketplace holds no funds");

        // Ordinary wallet-to-wallet transfer is unaffected by the marketplace.
        vm.prank(BUYER);
        GENESIS.safeTransferFrom(BUYER, WALLET, 0, 1, "");
        require(GENESIS.balanceOf(WALLET, 0) == 1, "plain transfer");

        vm.prank(HOLDER);
        market.cancelListing(id);
        require(market.listingStatus(id) == LegacyCollectionMarketplace.Status.CANCELLED, "cancel");
    }

    function testAFilteredOperatorOrMissingApprovalDoesNotMoveFunds() public {
        if (!forked) return;
        // No approval from the holder yet: listing must be refused.
        vm.prank(HOLDER);
        (bool ok,) = address(market).call(abi.encodeCall(market.createListingWithMinProceeds, (address(GENESIS), HOLDER, 0, 1, PRICE, uint64(0), 1)));
        require(!ok, "unapproved listing refused");
    }

    /// The Genesis owner (a real, separate actor) raises the royalty after a protected listing exists: the purchase must revert
    /// atomically, and the seller keeps the token. Replayed on a fork only; nothing is broadcast.
    function testRealGenesisRoyaltyIncreaseCannotUndercutAProtectedSeller() public {
        if (!forked) return;
        vm.prank(HOLDER);
        GENESIS.setApprovalForAll(address(market), true);
        // Floor = exact real-valued share at today's 5% royalty and the 2.5% fee.
        uint256 floorPerUnit = (PRICE * (10_000 - 250 - 500)) / 10_000;
        vm.prank(HOLDER);
        uint256 id = market.createListingWithMinProceeds(address(GENESIS), HOLDER, 0, 2, PRICE, 0, floorPerUnit);

        vm.prank(GENESIS.owner());
        GENESIS.setRoyaltyInfo(CREATOR, 700); // Genesis allows up to 2,500 bps
        uint256 holderTokens = GENESIS.balanceOf(HOLDER, 0);
        uint256 holderAvax = HOLDER.balance;
        vm.prank(BUYER);
        (bool ok,) = address(market).call{value: PRICE}(abi.encodeCall(market.buy, (id, 1)));
        require(!ok, "purchase below the seller's floor must revert");
        require(GENESIS.balanceOf(HOLDER, 0) == holderTokens && GENESIS.balanceOf(BUYER, 0) == 0 && HOLDER.balance == holderAvax && address(market).balance == 0, "nothing moved");

        vm.prank(GENESIS.owner());
        GENESIS.setRoyaltyInfo(CREATOR, 500); // restored: sale settles at the policy
        vm.prank(BUYER);
        market.buy{value: PRICE}(id, 1);
        require(HOLDER.balance - holderAvax == floorPerUnit && GENESIS.balanceOf(BUYER, 0) == 1, "settles at 92.5% once the royalty is back");
    }

    /// The candidate policy against the real contract: every Genesis id 0-3 lists and sells at the real 5% royalty with the
    /// seller floor, and id 4 is refused by the marketplace itself.
    function testRealGenesisIds0To3SellAndOutOfScopeIdsAreRefused() public {
        if (!forked) return;
        vm.prank(HOLDER);
        GENESIS.setApprovalForAll(address(market), true);
        uint256 floorPerUnit = (PRICE * (10_000 - 250 - 500)) / 10_000;
        for (uint256 id = 0; id <= 3; id++) {
            uint256 creatorBefore = CREATOR.balance;
            uint256 holderBefore = HOLDER.balance;
            vm.prank(HOLDER);
            uint256 listingId = market.createListingWithMinProceeds(address(GENESIS), HOLDER, id, 1, PRICE, 0, floorPerUnit);
            vm.prank(BUYER);
            market.buy{value: PRICE}(listingId, 1);
            require(GENESIS.balanceOf(BUYER, id) == 1, "delivered");
            require(CREATOR.balance - creatorBefore == 0.05 ether && HOLDER.balance - holderBefore == 0.925 ether, "5% / 92.5%");
        }
        vm.prank(HOLDER);
        (bool ok,) = address(market).call(abi.encodeCall(market.createListingWithMinProceeds, (address(GENESIS), HOLDER, 4, 1, PRICE, uint64(0), 1)));
        require(!ok, "id 4 is outside the allowlisted scope");
    }

    /// M-1 triage on the REAL collection: Genesis's royaltyInfo does not depend on the transaction's gas. Every gas limit at which a real
    /// purchase completes pays the creator exactly 5%, and the seller exactly 92.5%; the lowest completing limit is reported.
    function testRealGenesisPaysTheSameRoyaltyAtEveryCompletingGasLimit() public {
        if (!forked) return;
        vm.prank(HOLDER);
        GENESIS.setApprovalForAll(address(market), true);
        uint256 floorPerUnit = (PRICE * (10_000 - 250 - 500)) / 10_000;
        vm.prank(HOLDER);
        uint256 id = market.createListingWithMinProceeds(address(GENESIS), HOLDER, 0, 2, PRICE, 0, floorPerUnit);
        uint256 minOk; uint256 completed;
        for (uint256 g = 40_000; g <= 400_000; g += 1_000) {
            uint256 snap = vm.snapshotState();
            // a real purchase starts with these cold; a forge test is one long transaction
            vm.cool(address(GENESIS)); vm.cool(CREATOR); vm.cool(HOLDER); vm.cool(PLATFORM); vm.cool(address(market));
            uint256 creatorBefore = CREATOR.balance;
            uint256 holderBefore = HOLDER.balance;
            vm.prank(BUYER);
            (bool ok,) = address(market).call{value: PRICE, gas: g}(abi.encodeCall(market.buy, (id, 1)));
            if (ok) {
                if (minOk == 0) minOk = g;
                completed++;
                require(CREATOR.balance - creatorBefore == 0.05 ether, "creator receives exactly 5% at every completing gas limit");
                require(HOLDER.balance - holderBefore == 0.925 ether, "seller receives exactly 92.5% at every completing gas limit");
            } else {
                require(CREATOR.balance == creatorBefore && HOLDER.balance == holderBefore && address(market).balance == 0, "a failed purchase moves nothing");
            }
            vm.revertToState(snap);
        }
        emit log_named_uint("lowest completing tx gas limit on real Genesis", minOk);
        emit log_named_uint("completing gas limits sampled", completed);
        require(completed > 0, "real purchases complete with enough gas");
        require(minOk > 40_000, "and too little gas fails (the sweep covers the failing region too)");
    }

    /// Economic-policy facts (2026-10-21): Genesis reports one deterministic 500 bps royalty for ids 0-3 at every price, floored per
    /// ERC-2981; the marketplace pays exactly that and never substitutes another rate.
    function testRealGenesisRoyaltyIsDeterministicAcrossIdsAndPrices() public view {
        if (!forked) return;
        uint256[4] memory prices = [uint256(1), 3_333, 1 ether, 123_456_789 ether];
        for (uint256 id = 0; id <= 3; id++) {
            for (uint256 i = 0; i < prices.length; i++) {
                (address receiver, uint256 amount) = GENESIS.royaltyInfo(id, prices[i]);
                require(receiver == CREATOR && amount == (prices[i] * 500) / 10_000, "500 bps to the creator, floored");
                (uint256 fee, address r, uint256 royalty, uint256 seller) = market.previewSettlement(address(GENESIS), id, prices[i]);
                require(r == CREATOR && royalty == amount && fee == (prices[i] * 250) / 10_000 && fee + royalty + seller == prices[i], "pays the reported royalty, conserves value");
            }
        }
    }

    /// The royalty is mutable, but only by the collection owner (an account outside this marketplace), and only up to 2,500 bps.
    /// Controlling the receiver wallet is not the authority; ownership of the collection is.
    function testRealGenesisRoyaltySetterIsOwnerOnlyAndCapped() public {
        if (!forked) return;
        require(GENESIS.owner() == CREATOR, "collection owner is the creator wallet today");
        vm.prank(HOLDER);
        (bool ok,) = address(GENESIS).call(abi.encodeCall(IGenesis.setRoyaltyInfo, (HOLDER, 250)));
        require(!ok, "a non-owner cannot change the royalty");
        vm.prank(address(market));
        (ok,) = address(GENESIS).call(abi.encodeCall(IGenesis.setRoyaltyInfo, (CREATOR, 250)));
        require(!ok, "the marketplace cannot change the royalty");
        vm.prank(CREATOR);
        (ok,) = address(GENESIS).call(abi.encodeCall(IGenesis.setRoyaltyInfo, (CREATOR, 2_501)));
        require(!ok, "Genesis caps its own royalty at 2,500 bps");
        (, uint256 amount) = GENESIS.royaltyInfo(0, 10_000);
        require(amount == 500, "unchanged");
    }

    /// What the 2.5/2.5/95 policy would require, replayed on a fork only (nothing is broadcast, no decision is implied): it is reached
    /// by the Genesis owner lowering the collection's own royalty to 250 bps, with no marketplace change. The factory-only V4
    /// marketplace still refuses Genesis at 250 bps, so the trust boundary does not move.
    function testIfTheGenesisOwnerSetTwoPointFivePercentTheUnchangedMarketplaceWouldSettle95() public {
        if (!forked) return;
        vm.prank(CREATOR);
        GENESIS.setRoyaltyInfo(CREATOR, 250);
        vm.prank(HOLDER);
        GENESIS.setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        uint256 id = market.createListingWithMinProceeds(address(GENESIS), HOLDER, 0, 1, PRICE, 0, 0.95 ether);
        uint256 holderAvax = HOLDER.balance;
        uint256 feeAvax = PLATFORM.balance;
        uint256 creatorAvax = CREATOR.balance;
        vm.prank(BUYER);
        market.buy{value: PRICE}(id, 1);
        require(PLATFORM.balance - feeAvax == 0.025 ether && CREATOR.balance - creatorAvax == 0.025 ether && HOLDER.balance - holderAvax == 0.95 ether, "2.5 / 2.5 / 95");
        vm.prank(HOLDER);
        (bool ok,) = V4_MARKET.call(abi.encodeCall(IV4.createListing, (address(GENESIS), HOLDER, 0, 1, PRICE, 0)));
        require(!ok, "V4 refuses Genesis even at 250 bps: it is not a factory release");
    }
}
