// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactory} from "../contracts/VoidReleaseFactory.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";

interface VmClaimOpen {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectPartialRevert(bytes4) external;
}

contract GenesisHolderClaimOpenEditionTest {
    VmClaimOpen internal constant vm = VmClaimOpen(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant CLAIMANT = address(0xCA11);
    address internal constant CLAIMANT_TWO = address(0xCA12);
    address internal constant PLATFORM = address(0xFEE);
    address internal constant SAFE = address(0x5AFE);
    bytes32 internal constant RELEASE_KEY = keccak256("open-claim-release");
    bytes32 internal constant EDITION_ID = keccak256("open-claim-edition");
    uint256 internal constant ALLOCATION = 2;

    VoidRelease1155V4 internal release;
    VoidPrimarySale internal sale;
    GenesisHolderClaim internal claimContract;
    uint256 internal tokenId;
    address internal signer;

    function setUp() public {
        vm.chainId(43113);
        vm.warp(1_800_000_000);
        signer = vm.addr(SIGNER_KEY);
        VoidReleaseFactory factory = new VoidReleaseFactory(PLATFORM, 500, SAFE);
        (address releaseAddress, address saleAddress,) = factory.createRelease(
            ARTIST, RELEASE_KEY, "Open claim release", "OCR", "ipfs://open-claim"
        );
        release = VoidRelease1155V4(releaseAddress);
        sale = VoidPrimarySale(payable(saleAddress));
        vm.prank(ARTIST);
        tokenId = release.createEdition(RELEASE_KEY, EDITION_ID, 0, "ipfs://open-edition", ARTIST, 0);
        uint64 saleStart = uint64(block.timestamp + 1 days);
        vm.prank(ARTIST);
        sale.configureSale(tokenId, 1, 0, 0, saleStart, saleStart + 1 days, false);
        claimContract = new GenesisHolderClaim(
            address(release), address(sale), tokenId, ALLOCATION, 0, ADMIN, signer
        );
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
    }

    function testOpenClaimAcceptsFiniteAllocationAndMints() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 1, 1);
        bytes memory signature = _sign(voucher);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
        require(claimContract.claimedSupply() == 1, "claim allocation not tracked");
        require(release.balanceOf(CLAIMANT, tokenId) == 1, "claim mint missing");
        require(release.edition(tokenId).mintedSupply == 1, "minted supply mismatch");
    }

    function testOpenClaimAllocationCannotBeExceeded() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 2, ALLOCATION + 1);
        bytes memory signature = _sign(voucher);
        vm.expectPartialRevert(GenesisHolderClaim.AllocationExhausted.selector);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
    }

    function testOpenClaimWalletAndNonceProtectionsRemain() public {
        GenesisHolderClaim.ClaimVoucher memory first = _voucher(CLAIMANT, 3, 1);
        bytes memory firstSignature = _sign(first);
        vm.prank(CLAIMANT);
        claimContract.claim(first, firstSignature);
        GenesisHolderClaim.ClaimVoucher memory sameWallet = _voucher(CLAIMANT, 4, 1);
        bytes memory sameWalletSignature = _sign(sameWallet);
        vm.expectPartialRevert(GenesisHolderClaim.AlreadyClaimed.selector);
        vm.prank(CLAIMANT);
        claimContract.claim(sameWallet, sameWalletSignature);
        GenesisHolderClaim.ClaimVoucher memory replay = _voucher(CLAIMANT_TWO, 3, 1);
        bytes memory replaySignature = _sign(replay);
        vm.expectPartialRevert(GenesisHolderClaim.Replay.selector);
        vm.prank(CLAIMANT_TWO);
        claimContract.claim(replay, replaySignature);
    }

    function testMixedClaimAndPublicSaleAccountingRemainsExact() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 5, 1);
        bytes memory signature = _sign(voucher);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, signature);
        (,,,, uint64 saleStart,,,) = sale.sales(tokenId);
        vm.warp(saleStart);
        vm.deal(CLAIMANT_TWO, 3);
        vm.prank(CLAIMANT_TWO);
        sale.purchase{value: 3}(tokenId, 3);
        (,, uint256 sold,,,,,) = sale.sales(tokenId);
        require(release.edition(tokenId).mintedSupply == claimContract.claimedSupply() + sold, "mixed accounting mismatch");
    }

    function testInvalidSignerStillFails() public {
        GenesisHolderClaim.ClaimVoucher memory voucher = _voucher(CLAIMANT, 6, 1);
        bytes32 digest = claimContract.voucherDigest(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OTHER_KEY, digest);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidSignature.selector);
        vm.prank(CLAIMANT);
        claimContract.claim(voucher, abi.encodePacked(r, s, v));
    }

    function _voucher(address claimant, uint256 nonce, uint256 quantity)
        internal
        view
        returns (GenesisHolderClaim.ClaimVoucher memory)
    {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: claimContract.GENESIS_CONTRACT(),
            genesisChainId: claimContract.GENESIS_CHAIN_ID(),
            eligibilityRule: claimContract.ELIGIBILITY_RULE(),
            destinationChainId: 43113,
            releaseContract: address(release),
            tokenId: tokenId,
            quantity: quantity,
            allocation: ALLOCATION,
            nonce: nonce,
            deadline: block.timestamp + 300
        });
    }

    function _sign(GenesisHolderClaim.ClaimVoucher memory voucher) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, claimContract.voucherDigest(voucher));
        return abi.encodePacked(r, s, v);
    }
}
