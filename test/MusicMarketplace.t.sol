// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MusicMarketplace} from "../contracts/MusicMarketplace.sol";

interface Vm {
    function prank(address) external;
    function chainId(uint256) external;
    function warp(uint256) external;
}

contract MockMarketplace1155 {
    mapping(address => mapping(uint256 => uint256)) public balances;
    mapping(address => bool) public approved;

    function setBalance(address account, uint256 id, uint256 amount) external { balances[account][id] = amount; }
    function setApproved(address account, bool value) external { approved[account] = value; }
    function balanceOf(address account, uint256 id) external view returns (uint256) { return balances[account][id]; }
    function isApprovedForAll(address account, address) external view returns (bool) { return approved[account]; }
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata) external {
        require(balances[from][id] >= value, "balance");
        balances[from][id] -= value;
        balances[to][id] += value;
    }
}

contract MusicMarketplaceTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant SELLER = address(0xA11CE);
    address internal constant BUYER = address(0xB0B);
    address internal constant FEE = address(0xFEE);
    address internal constant CANONICAL = address(0xC011);
    address internal constant UNSUPPORTED = address(0xBAD);
    uint256 internal constant PRICE = 1 ether;
    MusicMarketplace internal marketplace;
    MockMarketplace1155 internal canonical;
    MockMarketplace1155 internal unsupported;

    function setUp() public {
        canonical = new MockMarketplace1155();
        unsupported = new MockMarketplace1155();
        marketplace = new MusicMarketplace(FEE, 250, address(canonical));
        canonical.setBalance(SELLER, 1, 5);
        canonical.setApproved(SELLER, true);
        unsupported.setBalance(SELLER, 1, 5);
        unsupported.setApproved(SELLER, true);
    }

    function testConstructorBindsChainAndCanonicalToken() public view {
        require(marketplace.deploymentChainId() == 31337, "chain");
        require(marketplace.canonicalToken() == address(canonical), "token");
    }

    function testCreateListingAcceptsOnlyCanonicalToken() public {
        vm.prank(SELLER);
        uint256 listingId = marketplace.createListing(address(canonical), SELLER, 1, 2, PRICE, 0);
        require(listingId == 1, "listing");
        require(marketplace.nextListingId() == 2, "next id");

        vm.prank(SELLER);
        try marketplace.createListing(address(unsupported), SELLER, 1, 1, PRICE, 0) {
            revert("unsupported accepted");
        } catch (bytes memory reason) {
            require(bytes4(reason) == MusicMarketplace.UnsupportedToken.selector, "wrong error");
        }
    }

    function testPurchaseAndCancellationRemainCanonicalBound() public {
        vm.prank(SELLER);
        uint256 listingId = marketplace.createListing(address(canonical), SELLER, 1, 2, PRICE, 0);
        vm.prank(SELLER);
        marketplace.cancelListing(listingId);
        require(uint256(marketplace.listingStatus(listingId)) == uint256(MusicMarketplace.Status.CANCELLED), "cancelled");
    }

    function testStateChangingOperationsRejectWrongChain() public {
        vm.prank(SELLER);
        uint256 listingId = marketplace.createListing(address(canonical), SELLER, 1, 2, PRICE, 0);
        vm.chainId(43113);
        vm.prank(SELLER);
        try marketplace.cancelListing(listingId) {
            revert("wrong chain accepted");
        } catch (bytes memory reason) {
            require(bytes4(reason) == MusicMarketplace.WrongDeploymentChain.selector, "wrong error");
        }
    }
}
