// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";

interface VmLegacyFork {
    function createSelectFork(string calldata) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function skip(bool) external;
    function prank(address) external;
    function deal(address, uint256) external;
    function expectRevert(bytes4) external;
}

interface IGenesisBalance {
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

/// @notice States, against the REAL deployed legacy sale on a local fork, exactly what the existing payment model does:
/// a purchase CREDITS 2.5% to the platform recipient and 97.5% to the edition payout inside the sale contract.
/// It does not transfer either share, so nothing reaches either wallet until that wallet calls `withdraw()` itself.
/// The Genesis collection is a separate contract and a purchase leaves its balances untouched.
/// Only cheatcodes are used: nothing is broadcast or signed, and nothing here happened on mainnet. Skipped unless
/// MAINNET_FORK_URL is set.
contract LegacySalePaymentModelForkTest {
    VmLegacyFork internal constant vm = VmLegacyFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    VoidPrimarySale internal constant SALE = VoidPrimarySale(payable(0x6ae84A51F100f10f0535A514555043ae9eDf9aA3));
    address internal constant ARTIST = 0x284C09a7CC187E096cbbdc88d99DEFE6df32180a;
    address internal constant PLATFORM = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    IGenesisBalance internal constant GENESIS = IGenesisBalance(0xD1B4367dd9f235f9ee61878019d66E31511E98eE);
    uint256 internal constant TOKEN = 25679935302133066722236771263728427871936411831072189551573738559199048803312;
    address internal constant BUYER = address(0xB0B);
    uint256 internal constant PRICE = 0.25 ether;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        // The live sale is sold out and ended. Re-opening it is an artist-only configureSale, simulated here only.
        vm.prank(ARTIST);
        SALE.configureSale(TOKEN, PRICE, 0, 0, 0, uint64(block.timestamp + 1 days), false);
        vm.deal(BUYER, 10 ether);
    }

    function testPurchaseCreditsTwoAndAHalfPercentAndNinetySevenAndAHalfPercentWithoutTransferringEither() public {
        uint256 platformCreditBefore = SALE.balances(PLATFORM);
        uint256 artistCreditBefore = SALE.balances(ARTIST);
        uint256 saleBalanceBefore = address(SALE).balance;
        uint256 platformWalletBefore = PLATFORM.balance;
        uint256 artistWalletBefore = ARTIST.balance;

        vm.prank(BUYER);
        SALE.purchase{value: 2 * PRICE}(TOKEN, 2);

        require(SALE.platformFeeBps() == 250 && SALE.platformFeeCapBps() == 250, "fee is 250 bps and capped at 250");
        require(SALE.balances(PLATFORM) - platformCreditBefore == 0.0125 ether, "platform credit is exactly 2.5%");
        require(SALE.balances(ARTIST) - artistCreditBefore == 0.4875 ether, "artist credit is exactly 97.5%");
        require(address(SALE).balance - saleBalanceBefore == 0.5 ether, "the sale holds the whole payment");
        // A credit is not a transfer: neither wallet received anything during the purchase.
        require(PLATFORM.balance == platformWalletBefore, "no AVAX was pushed to the platform wallet");
        require(ARTIST.balance == artistWalletBefore, "no AVAX was pushed to the artist wallet");
    }

    function testEachShareIsWithdrawableOnlyByItsOwnerAndNeverByTheOther() public {
        vm.prank(BUYER);
        SALE.purchase{value: PRICE}(TOKEN, 1);

        uint256 artistCredit = SALE.balances(ARTIST);
        uint256 platformCredit = SALE.balances(PLATFORM);
        require(artistCredit >= 0.24375 ether && platformCredit >= 0.00625 ether, "credits exist");

        // The artist claims only the artist credit. The platform credit is untouched.
        uint256 artistWalletBefore = ARTIST.balance;
        vm.prank(ARTIST);
        SALE.withdraw();
        require(ARTIST.balance - artistWalletBefore == artistCredit, "artist receives exactly the artist credit");
        require(SALE.balances(ARTIST) == 0 && SALE.balances(PLATFORM) == platformCredit, "platform credit untouched by the artist claim");

        // An unrelated account cannot collect either credit.
        vm.prank(address(0xBAD));
        vm.expectRevert(VoidPrimarySale.NothingToWithdraw.selector);
        SALE.withdraw();

        // Only the platform wallet itself, by calling withdraw(), receives the platform credit.
        uint256 platformWalletBefore = PLATFORM.balance;
        vm.prank(PLATFORM);
        SALE.withdraw();
        require(PLATFORM.balance - platformWalletBefore == platformCredit, "platform receives exactly the platform credit");
    }

    function testGenesisBalancesAreUnaffectedByAPrimarySale() public {
        address[4] memory holders = [BUYER, ARTIST, PLATFORM, address(SALE)];
        uint256[16] memory before_;
        for (uint256 h = 0; h < 4; h++) {
            for (uint256 id = 0; id < 4; id++) before_[h * 4 + id] = GENESIS.balanceOf(holders[h], id);
        }

        vm.prank(BUYER);
        SALE.purchase{value: PRICE}(TOKEN, 1);

        for (uint256 h = 0; h < 4; h++) {
            for (uint256 id = 0; id < 4; id++) {
                require(GENESIS.balanceOf(holders[h], id) == before_[h * 4 + id], "Genesis balance changed");
            }
        }
    }
}
