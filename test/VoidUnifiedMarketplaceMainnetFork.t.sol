// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2RoyaltySettled} from "../contracts/VoidReleaseFactoryV2RoyaltySettled.sol";
import {VoidRelease1155V4Royalty} from "../contracts/VoidRelease1155V4Royalty.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {VoidUnifiedMarketplace} from "../contracts/VoidUnifiedMarketplace.sol";

interface VmUnifiedFork {
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function prank(address) external;
    function deal(address, uint256) external;
    function skip(bool) external;
    function warp(uint256) external;
}

interface IGenesisFork {
    function balanceOf(address, uint256) external view returns (uint256);
    function setApprovalForAll(address, bool) external;
    function royaltyInfo(uint256, uint256) external view returns (address, uint256);
    function owner() external view returns (address);
    function setRoyaltyInfo(address receiver, uint96 feePercent) external;
}

interface IProductionFactoryFork {
    function createRelease(bytes32, bytes32, string calldata, string calldata, string calldata) external returns (address, address, address);
}

/// @notice Local fork of Avalanche C-Chain; nothing is broadcast. Uses the REAL Genesis proxy (operator filter, royaltyInfo)
/// and the REAL production factory 0x262B…757b. Skipped unless MAINNET_FORK_RPC is set. A fork pass proves bytecode
/// compatibility at the fork block only; it is not evidence of any live transaction.
contract VoidUnifiedMarketplaceMainnetForkTest {
    VmUnifiedFork internal constant vm = VmUnifiedFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    IGenesisFork internal constant GENESIS = IGenesisFork(0xD1B4367dd9f235f9ee61878019d66E31511E98eE);
    address internal constant PRODUCTION_FACTORY = 0x262B774cf9a1949170B58E2d57F6189980FE757b;
    address internal constant PLATFORM = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant CREATOR = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant HOLDER = 0xAe78E365285dB9BfA0FB231038f75f8f3Cc11588; // real Genesis holder
    address internal constant BUYER = address(0xB0B);
    address internal constant ARTIST = address(0xA7157);

    VoidReleaseFactoryV2RoyaltySettled internal settledFactory;
    VoidUnifiedMarketplace internal market;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpc);
        forked = true;
        require(block.chainid == 43114, "not C-Chain");
        settledFactory = new VoidReleaseFactoryV2RoyaltySettled(PLATFORM);
        market = new VoidUnifiedMarketplace(PLATFORM, address(settledFactory), PRODUCTION_FACTORY, address(GENESIS), 3, CREATOR);
        vm.deal(BUYER, 100 ether);
    }

    function testRealGenesisResaleSettlesZeroFiveNinetyFive() public {
        if (!forked) return;
        (address r0, uint256 a0) = GENESIS.royaltyInfo(0, 1 ether);
        vm.prank(HOLDER);
        GENESIS.setApprovalForAll(address(market), true); // through the real operator filter
        vm.prank(HOLDER);
        uint256 id = market.createListing(address(GENESIS), HOLDER, 0, 1, 1 ether, 0);
        uint256 p = PLATFORM.balance; uint256 c = CREATOR.balance; uint256 s = HOLDER.balance; uint256 t = GENESIS.balanceOf(HOLDER, 0);
        vm.prank(BUYER);
        market.buy{value: 1 ether}(id, 1);
        require(PLATFORM.balance == p, "0% platform");
        require(CREATOR.balance - c == 0.05 ether, "5% royalty");
        require(HOLDER.balance - s == 0.95 ether, "95% seller");
        require(GENESIS.balanceOf(BUYER, 0) == 1 && GENESIS.balanceOf(HOLDER, 0) == t - 1, "delivered");
        (address r1, uint256 a1) = GENESIS.royaltyInfo(0, 1 ether);
        require(r0 == r1 && a0 == a1 && r1 == CREATOR && a1 == 0.05 ether, "Genesis royalty unchanged");
    }

    function testGenesisRoyaltyChangeByItsOwnerRefusesTheSale() public {
        if (!forked) return;
        vm.prank(HOLDER);
        GENESIS.setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        uint256 id = market.createListing(address(GENESIS), HOLDER, 1, 1, 1 ether, 0);
        vm.prank(GENESIS.owner());
        GENESIS.setRoyaltyInfo(CREATOR, 700); // fork-only simulation
        vm.prank(BUYER);
        (bool ok,) = address(market).call{value: 1 ether}(abi.encodeCall(market.buy, (id, 1)));
        require(!ok && GENESIS.balanceOf(BUYER, 1) == 0, "refused, nothing moved");
    }

    function testRealProductionFactoryReleaseAndCorrectedFactoryReleaseBothTrade() public {
        if (!forked) return;
        _resale(PRODUCTION_FACTORY, false);
        _resale(address(settledFactory), true);
    }

    function _resale(address factory, bool settled) internal {
        bytes32 app = keccak256(abi.encode("fork-unified", factory));
        bytes32 key = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, factory, app, ARTIST));
        vm.prank(ARTIST);
        (address r, address s,) = IProductionFactoryFork(factory).createRelease(app, key, "Fork", "FORK", "ipfs://fork");
        VoidRelease1155V4Royalty release = VoidRelease1155V4Royalty(r);
        vm.prank(ARTIST);
        uint256 tokenId = release.createEditionWithMintEnd(key, keccak256("e"), 0, "ipfs://e", ARTIST, 250, uint64(block.timestamp + 1 days));
        vm.prank(ARTIST);
        VoidPrimarySale(s).configureSale(tokenId, 1 ether, 0, 0, 0, uint64(block.timestamp + 1 days), false);
        uint256 p0 = PLATFORM.balance;
        vm.deal(HOLDER, HOLDER.balance + 1 ether);
        vm.prank(HOLDER);
        VoidPrimarySale(s).purchase{value: 1 ether}(tokenId, 1);
        if (settled) require(PLATFORM.balance - p0 == 0.025 ether && VoidPrimarySaleSettled(s).balances(ARTIST) == 0.975 ether, "primary pushed");
        else require(PLATFORM.balance == p0 && VoidPrimarySale(s).balances(PLATFORM) == 0.025 ether, "production sale credits (historical behaviour)");
        vm.prank(HOLDER);
        release.setApprovalForAll(address(market), true);
        vm.prank(HOLDER);
        uint256 id = market.createListing(r, HOLDER, tokenId, 1, 2 ether, 0);
        uint256 p = PLATFORM.balance; uint256 a = ARTIST.balance; uint256 h = HOLDER.balance;
        vm.prank(BUYER);
        market.buy{value: 2 ether}(id, 1);
        require(PLATFORM.balance - p == 0.05 ether && ARTIST.balance - a == 0.05 ether && HOLDER.balance - h == 1.9 ether, "2.5/2.5/95");
    }
}
