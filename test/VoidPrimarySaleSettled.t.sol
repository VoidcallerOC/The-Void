// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155V2} from "../contracts/VoidRelease1155V2.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";

interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
}

/// Platform recipient that refuses native AVAX.
contract RejectingPlatform {
    receive() external payable {
        revert("no AVAX");
    }
}

/// Platform recipient that tries to buy again from inside the settlement transfer.
contract ReenteringPlatform {
    VoidPrimarySaleSettled public sale;
    uint256 public tokenId;
    uint256 public price;
    bool public reenterAttempted;
    bool public reenterSucceeded;

    function arm(VoidPrimarySaleSettled sale_, uint256 tokenId_, uint256 price_) external {
        sale = sale_;
        tokenId = tokenId_;
        price = price_;
    }

    receive() external payable {
        reenterAttempted = true;
        try sale.purchase{value: price}(tokenId, 1) {
            reenterSucceeded = true;
        } catch {}
    }
}

contract VoidPrimarySaleSettledTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VoidRelease1155V2 internal token;
    VoidPrimarySaleSettled internal sale;
    address internal admin = address(this);
    address internal artist = address(0xA11CE);
    address internal payout = address(0xB0B);
    address internal platform = address(0xFEE);
    address internal buyer = address(0xBEEF);
    address internal second = address(0xCAFE);
    uint256 internal id;
    uint256 internal constant PRICE = 1 ether;

    function setUp() public {
        token = new VoidRelease1155V2(admin);
        sale = new VoidPrimarySaleSettled(address(token), platform);
        token.grantRole(token.ARTIST_ROLE(), artist);
        token.grantRole(token.ISSUER_ROLE(), address(sale));
        vm.prank(artist);
        id = token.createEdition(bytes32("release"), bytes32("edition"), 10, "ipfs://metadata", payout, 500);
        vm.prank(artist);
        sale.configureSale(id, PRICE, 6, 3, 0, 0, false);
    }

    function _buy(address account, uint256 qty, uint256 value) internal {
        vm.deal(account, value);
        vm.prank(account);
        sale.purchase{value: value}(id, qty);
    }

    // ---- automatic platform payment + artist-specific routing ----

    function testPlatformShareIsPaidInsideThePurchase() public {
        uint256 before = platform.balance;
        _buy(buyer, 2, PRICE * 2);
        require(platform.balance == before + 0.05 ether, "platform paid in the same tx");
        require(sale.balances(platform) == 0, "platform never credited as a balance");
        require(sale.balances(payout) == 1.95 ether, "artist credited to payout");
        require(token.balanceOf(buyer, id) == 2, "minted");
        require(address(sale).balance == 1.95 ether, "contract holds only the artist share");
    }

    function testArtistShareNeverGoesToPlatformOrOthers() public {
        _buy(buyer, 1, PRICE);
        require(sale.balances(platform) == 0, "platform");
        require(sale.balances(artist) == 0, "edition artist address is not the payout");
        require(sale.balances(buyer) == 0, "buyer");
        require(sale.balances(payout) == 0.975 ether, "payout");
        vm.prank(platform);
        try sale.withdraw() {
            revert("platform must not withdraw artist funds");
        } catch {}
        require(address(sale).balance == 0.975 ether, "artist funds untouched");
    }

    function testArtistWithdrawsOnlyTheArtistShare() public {
        _buy(buyer, 1, PRICE);
        vm.prank(payout);
        sale.withdraw();
        require(payout.balance == 0.975 ether, "artist received 97.5%");
        require(sale.balances(payout) == 0, "cleared");
        require(address(sale).balance == 0, "nothing stranded");
        vm.prank(payout);
        try sale.withdraw() {
            revert("second withdraw must revert");
        } catch {}
    }

    function testPayoutEqualToPlatformRecipientKeepsBothShares() public {
        // The platform recipient is also the edition payout: it is paid its fee
        // automatically and must still pull the artist share through withdraw().
        VoidPrimarySaleSettled same = new VoidPrimarySaleSettled(address(token), payout);
        token.grantRole(token.ISSUER_ROLE(), address(same));
        vm.prank(artist);
        uint256 other = token.createEdition(bytes32("r2"), bytes32("e2"), 5, "ipfs://two", payout, 0);
        vm.prank(artist);
        same.configureSale(other, PRICE, 5, 5, 0, 0, false);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        same.purchase{value: PRICE}(other, 1);
        require(payout.balance == 0.025 ether, "fee pushed");
        require(same.balances(payout) == 0.975 ether, "artist share escrowed");
        vm.prank(payout);
        same.withdraw();
        require(payout.balance == 1 ether, "whole price reaches the one wallet, once");
    }

    // ---- accounting consistency ----

    function testAccountingInvariantAcrossPurchasesAndWithdrawals() public {
        uint256 platformBefore = platform.balance;
        _buy(buyer, 3, PRICE * 3);
        _buy(second, 2, PRICE * 2);
        uint256 total = 5 ether;
        require(
            address(sale).balance + (platform.balance - platformBefore) == total,
            "escrow + platform payments == gross"
        );
        require(address(sale).balance == sale.balances(payout), "escrow == artist balance");
        vm.prank(payout);
        sale.withdraw();
        require(address(sale).balance == 0, "empty after withdraw");
        require(payout.balance + (platform.balance - platformBefore) == total, "nothing lost or created");
    }

    function testFeeIsFixedAndHasNoSetterOrOwner() public {
        require(sale.PLATFORM_FEE_BPS() == 250, "fee constant");
        (bool setter,) = address(sale).call(abi.encodeWithSignature("setPlatformFeeBps(uint256)", 0));
        (bool transfer,) = address(sale).call(abi.encodeWithSignature("transferOwnership(address)", address(this)));
        (bool owned,) = address(sale).staticcall(abi.encodeWithSignature("owner()"));
        require(!setter && !transfer && !owned, "no fee setter, no owner");
        uint256 before = platform.balance;
        _buy(buyer, 1, PRICE);
        require(platform.balance == before + 0.025 ether, "always 2.5%");
    }

    function testConstructorRejectsZeroAddresses() public {
        try new VoidPrimarySaleSettled(address(0), platform) { revert("zero release"); } catch {}
        try new VoidPrimarySaleSettled(address(token), address(0)) { revert("zero recipient"); } catch {}
    }

    function testRoundingFavoursTheArtistAndSumsExactly() public {
        VoidPrimarySaleSettled odd = new VoidPrimarySaleSettled(address(token), platform);
        token.grantRole(token.ISSUER_ROLE(), address(odd));
        vm.prank(artist);
        uint256 other = token.createEdition(bytes32("r3"), bytes32("e3"), 5, "ipfs://three", payout, 0);
        vm.prank(artist);
        odd.configureSale(other, 101 wei, 5, 5, 0, 0, false);
        vm.deal(buyer, 101 wei);
        uint256 before = platform.balance;
        vm.prank(buyer);
        odd.purchase{value: 101 wei}(other, 1);
        uint256 platformPaid = platform.balance - before;
        require(platformPaid == 2, "floor(101 * 250 / 10000)");
        require(odd.balances(payout) == 99, "remainder to the artist");
        require(platformPaid + odd.balances(payout) == 101, "sums exactly");
    }

    // ---- failure behaviour: atomic revert ----

    function testRejectingPlatformRevertsTheWholePurchase() public {
        RejectingPlatform bad = new RejectingPlatform();
        VoidPrimarySaleSettled s = new VoidPrimarySaleSettled(address(token), address(bad));
        token.grantRole(token.ISSUER_ROLE(), address(s));
        vm.prank(artist);
        uint256 other = token.createEdition(bytes32("r4"), bytes32("e4"), 5, "ipfs://four", payout, 0);
        vm.prank(artist);
        s.configureSale(other, PRICE, 5, 5, 0, 0, false);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        try s.purchase{value: PRICE}(other, 1) {
            revert("purchase must not succeed");
        } catch {}
        require(token.balanceOf(buyer, other) == 0, "no mint");
        require(s.balances(payout) == 0, "no artist credit");
        (,, uint256 sold,,,,,) = s.sales(other);
        require(sold == 0, "sold unchanged");
        require(s.walletPurchased(other, buyer) == 0, "wallet count unchanged");
        require(address(s).balance == 0, "no escrow");
        require(buyer.balance == PRICE, "buyer keeps the AVAX");
    }

    // ---- reentrancy ----

    function testReenteringPlatformIsBlockedAndOuterPurchaseCompletesOnce() public {
        ReenteringPlatform hostile = new ReenteringPlatform();
        VoidPrimarySaleSettled s = new VoidPrimarySaleSettled(address(token), address(hostile));
        token.grantRole(token.ISSUER_ROLE(), address(s));
        vm.prank(artist);
        uint256 other = token.createEdition(bytes32("r5"), bytes32("e5"), 5, "ipfs://five", payout, 0);
        vm.prank(artist);
        s.configureSale(other, PRICE, 5, 5, 0, 0, false);
        hostile.arm(s, other, PRICE);
        vm.deal(address(hostile), PRICE);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        // The reentrant purchase is rejected by the guard, the receive() swallows that
        // revert, and the outer transfer then succeeds. The outer purchase completes once.
        s.purchase{value: PRICE}(other, 1);
        require(hostile.reenterAttempted(), "platform did try to re-enter");
        require(!hostile.reenterSucceeded(), "guard blocked the nested purchase");
        (,, uint256 sold,,,,,) = s.sales(other);
        require(sold == 1, "exactly one sale recorded");
        require(token.balanceOf(buyer, other) == 1, "buyer got one token");
        require(token.balanceOf(address(hostile), other) == 0, "attacker got nothing");
        require(s.balances(payout) == 0.975 ether, "artist credited once");
    }

    // ---- previously credited balances and the legacy contract ----

    function testExistingBalancesSurviveLaterPurchases() public {
        _buy(buyer, 1, PRICE);
        require(sale.balances(payout) == 0.975 ether, "first credit");
        _buy(second, 1, PRICE);
        require(sale.balances(payout) == 1.95 ether, "first credit preserved, second added");
        vm.prank(payout);
        sale.withdraw();
        require(payout.balance == 1.95 ether, "full credited amount withdrawable");
    }

    function testLegacySaleStillCreditsBothSharesAsBalances() public {
        // Documents the deployed behaviour at 0x6ae84a51...: both shares are pull balances
        // and no AVAX is sent at purchase time. This contract is not changed.
        VoidPrimarySale legacy = new VoidPrimarySale(address(token), platform, 250);
        token.grantRole(token.ISSUER_ROLE(), address(legacy));
        vm.prank(artist);
        uint256 other = token.createEdition(bytes32("r6"), bytes32("e6"), 5, "ipfs://six", payout, 0);
        vm.prank(artist);
        legacy.configureSale(other, PRICE, 5, 5, 0, 0, false);
        vm.deal(buyer, PRICE);
        uint256 before = platform.balance;
        vm.prank(buyer);
        legacy.purchase{value: PRICE}(other, 1);
        require(platform.balance == before, "legacy pushes nothing");
        require(legacy.balances(platform) == 0.025 ether, "legacy platform pull balance");
        require(legacy.balances(payout) == 0.975 ether, "legacy artist pull balance");
        require(address(legacy).balance == PRICE, "legacy holds the whole price");
        vm.prank(platform);
        legacy.withdraw();
        require(platform.balance == before + 0.025 ether, "platform can still pull its share");
    }

    // ---- unchanged validation ----

    function testWrongPaymentStillReverts() public {
        vm.deal(buyer, PRICE + 1);
        vm.prank(buyer);
        try sale.purchase{value: PRICE + 1}(id, 1) {
            revert();
        } catch {}
        require(token.balanceOf(buyer, id) == 0, "no mint");
        require(address(sale).balance == 0, "no escrow");
        require(platform.balance == 0, "no platform payment");
    }
}
