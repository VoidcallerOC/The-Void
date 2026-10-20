// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidReleaseFactoryV2Royalty} from "../contracts/VoidReleaseFactoryV2Royalty.sol";
import {VoidReleaseFactoryV2RoyaltySettled} from "../contracts/VoidReleaseFactoryV2RoyaltySettled.sol";
import {VoidRelease1155V4Royalty} from "../contracts/VoidRelease1155V4Royalty.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {ReleaseMarketplaceV4} from "../contracts/ReleaseMarketplaceV4.sol";

interface VmFactoryFork {
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function skip(bool) external;
    function prank(address) external;
    function deal(address, uint256) external;
    function expectRevert(bytes4) external;
}

interface IGenesisFactoryFork {
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

/// @notice The corrected factory against the REAL mainnet state, on a local fork. The factory deployed here exists only
/// inside the fork: nothing is broadcast or sent, and nothing here happened on mainnet. It shows the existing Forgive & Forget
/// release, its factory, sale, marketplace and Genesis are untouched, and that the production marketplace does not
/// recognise the new factory's releases. Skipped unless MAINNET_FORK_URL (or MAINNET_FORK_RPC) is set.
contract VoidReleaseFactorySettledForkTest {
    VmFactoryFork internal constant vm = VmFactoryFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant PROD_FACTORY = 0x262B774cf9a1949170B58E2d57F6189980FE757b;
    address internal constant PROD_MARKET = 0x0e77116142844478a55EEd2Ab79de9F93770F8f5;
    address internal constant RELEASE = 0x9Aa6165B493ac50d0f8CDee2FD48a3C5155FD103;
    address internal constant OLD_SALE = 0x6ae84A51F100f10f0535A514555043ae9eDf9aA3;
    address internal constant ARTIST = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant PLATFORM = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant HIST_BUYER = 0x6a86EfA012fEDA64b70112022487fEE22E67d2fb;
    IGenesisFactoryFork internal constant GENESIS = IGenesisFactoryFork(0xD1B4367dd9f235f9ee61878019d66E31511E98eE);
    uint256 internal constant TOKEN = 25679935302133066722236771263728427871936411831072189551573738559199048803312;
    address internal constant FAN = address(0xFA1);

    struct Snapshot {
        uint256[16] genesis;
        bytes32 uriHash;
        uint256 histBuyer;
        uint256 artistCredit;
        uint256 platformCredit;
        uint256 factoryReleases;
    }

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_URL", string(""));
        if (bytes(rpc).length == 0) rpc = vm.envOr("MAINNET_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    modifier onlyFork() {
        vm.skip(!forked);
        _;
    }

    function _holders() internal pure returns (address[4] memory) {
        return [FAN, ARTIST, PLATFORM, HIST_BUYER];
    }

    function _snapshot() internal view returns (Snapshot memory s) {
        address[4] memory holders = _holders();
        for (uint256 h = 0; h < 4; h++) {
            for (uint256 id = 0; id < 4; id++) s.genesis[h * 4 + id] = GENESIS.balanceOf(holders[h], id);
        }
        s.uriHash = keccak256(bytes(VoidRelease1155V4Royalty(RELEASE).uri(TOKEN)));
        s.histBuyer = VoidRelease1155V4Royalty(RELEASE).balanceOf(HIST_BUYER, TOKEN);
        s.artistCredit = VoidPrimarySale(payable(OLD_SALE)).balances(ARTIST);
        s.platformCredit = VoidPrimarySale(payable(OLD_SALE)).balances(PLATFORM);
        s.factoryReleases = VoidReleaseFactoryV2Royalty(PROD_FACTORY).releaseCount();
    }

    function _assertUnchanged(Snapshot memory before) internal view {
        Snapshot memory afterState = _snapshot();
        VoidRelease1155V4Royalty release = VoidRelease1155V4Royalty(RELEASE);
        require(release.artistOf(TOKEN) == ARTIST && release.payoutOf(TOKEN) == ARTIST && release.royaltyBpsOf(TOKEN) == 250, "the existing edition is unchanged");
        require(VoidReleaseFactoryV2Royalty(PROD_FACTORY).primarySaleOf(RELEASE) == OLD_SALE, "production registry still names the original sale");
        require(afterState.factoryReleases == before.factoryReleases, "production factory has no new release");
        require(afterState.artistCredit == before.artistCredit && afterState.platformCredit == before.platformCredit, "original sale credits unchanged");
        require(afterState.uriHash == before.uriHash && afterState.histBuyer == before.histBuyer, "metadata and ownership unchanged");
        for (uint256 i = 0; i < 16; i++) require(afterState.genesis[i] == before.genesis[i], "Genesis balance changed");
    }

    /// @dev Replacement release from a factory that exists only inside the fork.
    function _replacement() internal returns (VoidReleaseFactoryV2RoyaltySettled fresh, VoidRelease1155V4Royalty r, VoidPrimarySaleSettled s, uint256 newToken) {
        fresh = new VoidReleaseFactoryV2RoyaltySettled(PLATFORM);
        bytes32 key = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(fresh), keccak256("forgive-and-forget-replacement"), ARTIST));
        vm.prank(ARTIST);
        (address newRelease, address newSale,) = fresh.createRelease(keccak256("forgive-and-forget-replacement"), key, "Forgive & Forget", "FNF", "ipfs://replacement");
        r = VoidRelease1155V4Royalty(newRelease);
        s = VoidPrimarySaleSettled(newSale);
        vm.prank(ARTIST);
        newToken = r.createEditionWithMintEnd(key, keccak256("forgive-and-forget"), 0, "ipfs://replacement-edition", ARTIST, 250, uint64(block.timestamp + 30 days));
        vm.prank(ARTIST);
        s.configureSale(newToken, 0.25 ether, 0, 0, 0, uint64(block.timestamp + 30 days), false);
    }

    function testNewFactoryLeavesTheExistingReleaseItsSaleItsFactoryAndGenesisUntouched() public onlyFork {
        Snapshot memory before = _snapshot();
        (, , VoidPrimarySaleSettled s, uint256 newToken) = _replacement();

        // A purchase on the new release pays the real platform wallet inside the transaction.
        uint256 platformBalance = PLATFORM.balance;
        vm.deal(FAN, 1 ether);
        vm.prank(FAN);
        s.purchase{value: 0.25 ether}(newToken, 1);
        require(PLATFORM.balance - platformBalance == 0.00625 ether && s.balances(ARTIST) == 0.24375 ether, "2.5% pushed, 97.5% claimable");

        _assertUnchanged(before);
    }

    function testTheProductionMarketplaceRefusesAReleaseFromTheNewFactory() public onlyFork {
        (VoidReleaseFactoryV2RoyaltySettled fresh, VoidRelease1155V4Royalty r, VoidPrimarySaleSettled s, uint256 newToken) = _replacement();
        vm.deal(FAN, 1 ether);
        vm.prank(FAN);
        s.purchase{value: 0.25 ether}(newToken, 1);

        require(!VoidReleaseFactoryV2Royalty(PROD_FACTORY).isRelease(address(r)), "the production factory never registered it");
        vm.prank(FAN);
        r.setApprovalForAll(PROD_MARKET, true);
        vm.prank(FAN);
        vm.expectRevert(ReleaseMarketplaceV4.UnsupportedRelease.selector);
        ReleaseMarketplaceV4(PROD_MARKET).createListing(address(r), FAN, newToken, 1, 1 ether, 0);

        // A marketplace constructed for the new factory accepts it (the registry is an immutable constructor argument).
        ReleaseMarketplaceV4 matching = new ReleaseMarketplaceV4(PLATFORM, 250, address(fresh));
        vm.prank(FAN);
        r.setApprovalForAll(address(matching), true);
        vm.prank(FAN);
        matching.createListing(address(r), FAN, newToken, 1, 1 ether, 0);
    }
}
