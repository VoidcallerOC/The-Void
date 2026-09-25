// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VoidRelease1155V2} from "../contracts/VoidRelease1155V2.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";

interface Vm {
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
}

contract ReenteringBuyer {
    VoidPrimarySale internal sale;
    uint256 internal tokenId;
    uint256 internal price;
    bool internal entered;

    constructor(VoidPrimarySale sale_, uint256 tokenId_, uint256 price_) {
        sale = sale_;
        tokenId = tokenId_;
        price = price_;
    }

    function buy() external payable {
        sale.purchase{value: price}(tokenId, 1);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (!entered) {
            entered = true;
            sale.purchase{value: price}(tokenId, 1);
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }
}

contract ReenteringPayee {
    VoidPrimarySale internal sale;
    bool public attack = true;
    uint256 public calls;

    function setSale(VoidPrimarySale sale_) external {
        sale = sale_;
    }

    function setAttack(bool next) external {
        attack = next;
    }

    function withdraw() external {
        sale.withdraw();
    }

    receive() external payable {
        calls += 1;
        if (attack) sale.withdraw();
    }
}

contract VoidPrimarySaleTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    VoidRelease1155V2 internal token;
    VoidPrimarySale internal sale;
    address internal admin = address(this);
    address internal artist = address(0xA11CE);
    address internal otherArtist = address(0xA77);
    address internal payout = address(0xB0B);
    address internal platform = address(0xFEE);
    address internal buyer = address(0xBEEF);
    address internal second = address(0xCAFE);
    uint256 internal id;
    uint256 internal constant PRICE = 1 ether;

    function setUp() public {
        token = new VoidRelease1155V2(admin);
        sale = new VoidPrimarySale(address(token), platform, 250);
        token.grantRole(token.ARTIST_ROLE(), artist);
        token.grantRole(token.ARTIST_ROLE(), otherArtist);
        token.grantRole(token.ISSUER_ROLE(), address(sale));
        vm.prank(artist);
        id = token.createEdition(bytes32("release"), bytes32("edition"), 10, "ipfs://metadata", payout, 500);
        vm.prank(artist);
        sale.configureSale(id, PRICE, 4, 2, 0, 0, false);
    }

    function _buy(address account, uint256 qty, uint256 value) internal {
        vm.deal(account, value);
        vm.prank(account);
        sale.purchase{value: value}(id, qty);
    }

    function testHappyPathMintsAndSplitsFee() public {
        _buy(buyer, 2, PRICE * 2);
        require(token.balanceOf(buyer, id) == 2, "owned");
        require(sale.balances(payout) == 1.95 ether, "artist cut");
        require(sale.balances(platform) == 0.05 ether, "platform cut");
        require(sale.walletPurchased(id, buyer) == 2, "wallet count");
        (,,,,,,, bool configured) = sale.sales(id);
        require(configured, "configured");
        uint256 sold;
        (,, sold,,,,,) = sale.sales(id);
        require(sold == 2, "sold");
        require(address(sale).balance == 2 ether, "escrow");
    }

    function testWrongPaymentReverts() public {
        vm.deal(buyer, PRICE + 1);
        vm.prank(buyer);
        try sale.purchase{value: PRICE + 1}(id, 1) {
            revert();
        } catch {}
        vm.prank(buyer);
        try sale.purchase{value: PRICE - 1}(id, 1) {
            revert();
        } catch {}
        require(token.balanceOf(buyer, id) == 0, "no mint");
        require(address(sale).balance == 0, "no escrow");
    }

    function testSoldOut() public {
        vm.prank(artist);
        sale.configureSale(id, PRICE, 1, 1, 0, 0, false);
        _buy(buyer, 1, PRICE);
        vm.deal(second, PRICE);
        vm.prank(second);
        try sale.purchase{value: PRICE}(id, 1) {
            revert();
        } catch {}
        require(token.balanceOf(second, id) == 0, "second blocked");
    }

    function testWalletLimit() public {
        _buy(buyer, 2, PRICE * 2);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        try sale.purchase{value: PRICE}(id, 1) {
            revert();
        } catch {}
        require(token.balanceOf(buyer, id) == 2, "capped");
        _buy(second, 1, PRICE);
        require(token.balanceOf(second, id) == 1, "other wallet");
    }

    function testTimeWindow() public {
        vm.prank(artist);
        sale.configureSale(id, PRICE, 4, 2, 1_000, 2_000, false);
        vm.warp(999);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        try sale.purchase{value: PRICE}(id, 1) {
            revert();
        } catch {}
        vm.warp(1_000);
        _buy(buyer, 1, PRICE);
        vm.warp(2_001);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        try sale.purchase{value: PRICE}(id, 1) {
            revert();
        } catch {}
        require(token.balanceOf(buyer, id) == 1, "only inside window");
    }

    function testPausedSale() public {
        vm.prank(artist);
        sale.configureSale(id, PRICE, 4, 2, 0, 0, true);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        try sale.purchase{value: PRICE}(id, 1) {
            revert();
        } catch {}
        vm.prank(artist);
        sale.configureSale(id, PRICE, 4, 2, 0, 0, false);
        _buy(buyer, 1, PRICE);
        require(token.balanceOf(buyer, id) == 1, "unpaused");
    }

    function testNonArtistCannotConfigureAnotherEdition() public {
        vm.prank(otherArtist);
        try sale.configureSale(id, PRICE, 1, 1, 0, 0, false) {
            revert();
        } catch {}
        vm.prank(buyer);
        try sale.configureSale(id, PRICE, 1, 1, 0, 0, false) {
            revert();
        } catch {}
        (uint256 price,,,,,,,) = sale.sales(id);
        require(price == PRICE, "unchanged");
    }

    function testFeeCanBeLoweredButNotRaisedAboveTheCap() public {
        require(sale.platformFeeCapBps() == 250, "cap");
        sale.setPlatformFeeBps(100);
        require(sale.platformFeeBps() == 100, "lowered");
        sale.setPlatformFeeBps(250);
        require(sale.platformFeeBps() == 250, "back to cap");
        try sale.setPlatformFeeBps(251) {
            revert();
        } catch {}
        vm.prank(buyer);
        try sale.setPlatformFeeBps(0) {
            revert();
        } catch {}
        sale.setPlatformFeeBps(100);
        _buy(buyer, 1, PRICE);
        require(sale.balances(platform) == 0.01 ether, "one percent");
        require(sale.balances(payout) == 0.99 ether, "artist remainder");
    }

    function testWithdrawAndReentrancy() public {
        _buy(buyer, 1, PRICE);
        vm.prank(payout);
        sale.withdraw();
        require(payout.balance == 0.975 ether, "artist paid");
        require(sale.balances(payout) == 0, "artist cleared");

        ReenteringPayee attacker = new ReenteringPayee();
        VoidPrimarySale reentrantSale = new VoidPrimarySale(address(token), address(attacker), 10_000);
        attacker.setSale(reentrantSale);
        token.grantRole(token.ISSUER_ROLE(), address(reentrantSale));
        vm.prank(artist);
        uint256 other = token.createEdition(bytes32("re"), bytes32("enter"), 2, "ipfs://re", address(attacker), 0);
        vm.prank(artist);
        reentrantSale.configureSale(other, PRICE, 2, 2, 0, 0, false);
        vm.deal(buyer, PRICE);
        vm.prank(buyer);
        reentrantSale.purchase{value: PRICE}(other, 1);
        attacker.setAttack(true);
        try attacker.withdraw() {
            revert();
        } catch {}
        require(reentrantSale.balances(address(attacker)) == PRICE, "still escrowed");
        require(address(reentrantSale).balance == PRICE, "contract still holds funds");
        attacker.setAttack(false);
        attacker.withdraw();
        require(reentrantSale.balances(address(attacker)) == 0, "withdrawn after guard");
        require(address(attacker).balance == PRICE, "payee received");

        ReenteringBuyer hostile = new ReenteringBuyer(sale, id, PRICE);
        vm.deal(address(hostile), PRICE * 2);
        try hostile.buy() {
            revert();
        } catch {}
        require(token.balanceOf(address(hostile), id) == 0, "reentrant mint rolled back");
        require(token.edition(id).mintedSupply == 1, "only the honest mint");
    }

    function testRoyaltyInfoIndependentOfPrimarySplit() public view {
        (address receiver, uint256 royalty) = token.royaltyInfo(id, 10_000);
        require(receiver == payout && royalty == 500, "resale royalty");
    }
}
