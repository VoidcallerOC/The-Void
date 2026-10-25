// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactory} from "../contracts/VoidReleaseFactory.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidCollection1155} from "../contracts/VoidCollection1155.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";
import {installGenesisStandIn} from "./helpers/MockGenesisCollection.sol";

interface VmLate {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectPartialRevert(bytes4) external;
}

/// @notice Late deployment against an already-open sale. claimStart stays the schedule's
/// authoritative timestamp; the window is never extended. Deployment after claimEnd is
/// permitted, but the free-claim path is already expired.
contract GenesisHolderClaimLateDeploymentTest {
    VmLate internal constant vm = VmLate(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant START = T0 + 1 hours;
    uint256 internal constant CLAIM_WINDOW = 5 minutes;
    uint256 internal constant PUBLIC_WINDOW = 10 minutes;
    uint256 internal constant PRICE = 0.01 ether;

    VoidRelease1155V4 internal release;
    VoidPrimarySale internal sale;
    uint256 internal tokenId;
    address internal signer;

    function setUp() public {
        vm.chainId(43113);
        vm.warp(T0);
        signer = vm.addr(SIGNER_KEY);
        VoidReleaseFactory factory = new VoidReleaseFactory(address(0xFEE), 500, address(0x5AFE));
        (address releaseAddress, address saleAddress,) =
            factory.createRelease(ARTIST, keccak256("late-release"), "Late", "LATE", "ipfs://late");
        release = VoidRelease1155V4(releaseAddress);
        sale = VoidPrimarySale(payable(saleAddress));
        vm.prank(ARTIST);
        tokenId = release.createEdition(keccak256("late-release"), keccak256("late-edition"), 0, "ipfs://e", ARTIST, 0);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, uint64(START), uint64(START + PUBLIC_WINDOW - 1), false);
        installGenesisStandIn(true);
    }

    function _deploy() internal returns (GenesisHolderClaim claim) {
        claim = new GenesisHolderClaim(
            address(release), address(sale), tokenId, 0, 0, START, CLAIM_WINDOW, PUBLIC_WINDOW, PRICE, ADMIN, signer
        );
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claim));
    }

    function _signed(GenesisHolderClaim claim, uint256 nonce)
        internal
        returns (GenesisHolderClaim.ClaimVoucher memory voucher, bytes memory signature)
    {
        voucher = GenesisHolderClaim.ClaimVoucher({
            claimant: CLAIMANT,
            genesisContract: claim.GENESIS_CONTRACT(),
            genesisChainId: 43114,
            eligibilityRule: claim.ELIGIBILITY_RULE(),
            destinationChainId: block.chainid,
            releaseContract: address(release),
            tokenId: tokenId,
            quantity: 1,
            allocation: 0,
            nonce: nonce,
            deadline: block.timestamp + 60
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, claim.voucherDigest(voucher));
        signature = abi.encodePacked(r, s, v);
    }

    function testDeployBeforeSaleStart() public {
        vm.warp(START - 1);
        GenesisHolderClaim claim = _deploy();
        assertEq(claim.claimStart(), START);
        assertEq(claim.claimEnd(), START + CLAIM_WINDOW);
        assertEq(claim.publicSaleStart(), START);
        assertEq(claim.publicSaleEnd(), START + PUBLIC_WINDOW - 1);
    }

    function testDeployAfterSaleStartBeforeClaimEnd() public {
        vm.warp(START + 2 minutes);
        GenesisHolderClaim claim = _deploy();
        assertEq(claim.claimStart(), START);
        assertEq(claim.claimEnd(), START + CLAIM_WINDOW);
        (GenesisHolderClaim.ClaimVoucher memory voucher, bytes memory signature) = _signed(claim, 1);
        vm.prank(CLAIMANT);
        claim.claim(voucher, signature);
        assertEq(release.balanceOf(CLAIMANT, tokenId), 1);
        assertEq(claim.claimedSupply(), 1);
    }

    function testDeployAfterClaimEndLeavesPathExpired() public {
        vm.warp(START + CLAIM_WINDOW);
        GenesisHolderClaim claim = _deploy();
        assertEq(claim.claimStart(), START);
        assertEq(claim.claimEnd(), START + CLAIM_WINDOW);
        (GenesisHolderClaim.ClaimVoucher memory voucher, bytes memory signature) = _signed(claim, 1);
        vm.prank(CLAIMANT);
        vm.expectPartialRevert(GenesisHolderClaim.ClaimWindowClosed.selector);
        claim.claim(voucher, signature);
    }

    function testClaimBeforeWindowReverts() public {
        vm.warp(START - 1);
        GenesisHolderClaim claim = _deploy();
        (GenesisHolderClaim.ClaimVoucher memory voucher, bytes memory signature) = _signed(claim, 1);
        vm.prank(CLAIMANT);
        vm.expectPartialRevert(GenesisHolderClaim.ClaimNotOpen.selector);
        claim.claim(voucher, signature);
    }

    function testClaimAfterWindowReverts() public {
        vm.warp(START + 1 minutes);
        GenesisHolderClaim claim = _deploy();
        vm.warp(START + CLAIM_WINDOW);
        (GenesisHolderClaim.ClaimVoucher memory voucher, bytes memory signature) = _signed(claim, 1);
        vm.prank(CLAIMANT);
        vm.expectPartialRevert(GenesisHolderClaim.ClaimWindowClosed.selector);
        claim.claim(voucher, signature);
    }

    function testRejectsMismatchedSaleStart() public {
        vm.warp(START - 1);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, uint64(START + 1), uint64(START + PUBLIC_WINDOW), false);
        vm.expectPartialRevert(GenesisHolderClaim.PublicSaleSchedule.selector);
        new GenesisHolderClaim(
            address(release), address(sale), tokenId, 0, 0, START, CLAIM_WINDOW, PUBLIC_WINDOW, PRICE, ADMIN, signer
        );
    }

    function testRejectsMismatchedPrice() public {
        vm.warp(START - 1);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE + 1, 0, 0, uint64(START), uint64(START + PUBLIC_WINDOW - 1), false);
        vm.expectPartialRevert(GenesisHolderClaim.PublicPriceChanged.selector);
        new GenesisHolderClaim(
            address(release), address(sale), tokenId, 0, 0, START, CLAIM_WINDOW, PUBLIC_WINDOW, PRICE, ADMIN, signer
        );
    }

    function testSupplyAccountingAgainstOpenSale() public {
        vm.warp(START + 1 minutes);
        GenesisHolderClaim claim = _deploy();
        (,, uint256 soldBefore,,,,,) = sale.sales(tokenId);
        assertEq(release.edition(tokenId).mintedSupply, soldBefore + claim.claimedSupply());
        (GenesisHolderClaim.ClaimVoucher memory voucher, bytes memory signature) = _signed(claim, 1);
        vm.prank(CLAIMANT);
        claim.claim(voucher, signature);
        (,, uint256 soldAfter,,,,,) = sale.sales(tokenId);
        assertEq(release.edition(tokenId).mintedSupply, soldAfter + claim.claimedSupply());
    }


    function testRejectsWrongTokenId() public {
        vm.warp(START - 1);
        vm.expectPartialRevert(VoidCollection1155.EditionNotFound.selector);
        new GenesisHolderClaim(
            address(release), address(sale), tokenId + 1, 0, 0, START, CLAIM_WINDOW, PUBLIC_WINDOW, PRICE, ADMIN, signer
        );
    }

    function testRejectsMismatchedAllocation() public {
        vm.warp(START - 1);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 10, 0, uint64(START), uint64(START + PUBLIC_WINDOW - 1), false);
        vm.expectPartialRevert(GenesisHolderClaim.PublicAllocationChanged.selector);
        new GenesisHolderClaim(
            address(release), address(sale), tokenId, 0, 0, START, CLAIM_WINDOW, PUBLIC_WINDOW, PRICE, ADMIN, signer
        );
    }

    function testRejectsMismatchedSaleAddress() public {
        vm.warp(START - 1);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        new GenesisHolderClaim(
            address(release), address(release), tokenId, 0, 0, START, CLAIM_WINDOW, PUBLIC_WINDOW, PRICE, ADMIN, signer
        );
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq uint");
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq address");
    }
}
