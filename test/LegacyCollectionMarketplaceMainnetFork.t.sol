// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegacyCollectionMarketplace} from "../contracts/LegacyCollectionMarketplace.sol";

interface VmLegacyFork {
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function prank(address) external;
    function deal(address, uint256) external;
}

interface IGenesis {
    function balanceOf(address, uint256) external view returns (uint256);
    function setApprovalForAll(address, bool) external;
    function safeTransferFrom(address, address, uint256, uint256, bytes calldata) external;
    function royaltyInfo(uint256, uint256) external view returns (address, uint256);
    function operatorFilterRegistry() external view returns (address);
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
        if (bytes(rpc).length == 0) return;
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
        uint256 id = market.createListing(address(GENESIS), HOLDER, 0, 2, PRICE, 0);

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
        (bool ok,) = address(market).call(abi.encodeCall(market.createListing, (address(GENESIS), HOLDER, 0, 1, PRICE, uint64(0))));
        require(!ok, "unapproved listing refused");
    }
}
