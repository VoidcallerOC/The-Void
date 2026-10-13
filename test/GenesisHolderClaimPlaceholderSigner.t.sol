// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactoryV2} from "../contracts/VoidReleaseFactoryV2.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";

interface VmPlaceholder {
    function chainId(uint256) external;
    function warp(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
}

/// @notice The Fuji claim is deployed with the artist as admin and a PLACEHOLDER voucher signer (the dead
/// address, for which no key exists) until the real signer is chosen. This proves, with the worst case
/// (the claim already holds ISSUER_ROLE and the window is open), that no voucher can succeed under the
/// placeholder, that only the artist can later rotate the signer, and that after rotation the claim works
/// exactly as before and still refuses outside its window. Test keys are local cheat-code fixtures only.
contract GenesisHolderClaimPlaceholderSignerTest {
    VmPlaceholder internal constant vm = VmPlaceholder(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant PLACEHOLDER = 0x000000000000000000000000000000000000dEaD;
    address internal constant ARTIST = address(0xA7157);
    address internal constant DEPLOYER = address(0xDE9107E4);
    address internal constant NANO = address(0xFEE);
    address internal constant CLAIMANT = address(0xCA11);
    address internal constant CLAIMANT_TWO = address(0xCA12);
    uint256 internal constant REAL_SIGNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    bytes32 internal constant APP = keccak256("fuji-placeholder-signer");
    bytes32 internal constant EDITION_ID = keccak256("fuji-placeholder-edition");
    uint256 internal constant PRICE = 0.01 ether;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant CLAIM_START = T0 + 1 hours;
    uint256 internal constant CLAIM_END = CLAIM_START + 300;
    uint256 internal constant PUBLIC_END = CLAIM_END + 600 - 1;

    VoidRelease1155V4 internal release;
    VoidPrimarySale internal sale;
    GenesisHolderClaim internal claimContract;
    uint256 internal tokenId;

    function setUp() public {
        vm.chainId(43113);
        vm.warp(T0);
        VoidReleaseFactoryV2 factory = new VoidReleaseFactoryV2(NANO);
        bytes32 releaseKey = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), APP, ARTIST));
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = factory.createRelease(APP, releaseKey, "Forgive & Forget", "FNF", "ipfs://fnf");
        release = VoidRelease1155V4(releaseAddress);
        sale = VoidPrimarySale(saleAddress);
        vm.prank(ARTIST);
        tokenId = release.createEditionWithMintEnd(releaseKey, EDITION_ID, 0, "ipfs://fnf-edition", ARTIST, 250, uint64(PUBLIC_END));
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, 0, uint64(CLAIM_END), uint64(PUBLIC_END), false);
        // The deployer deploys the claim; the artist is its admin; the voucher signer is the placeholder.
        vm.prank(DEPLOYER);
        claimContract = new GenesisHolderClaim(address(release), address(sale), tokenId, 0, 0, CLAIM_START, 300, 600, PRICE, ARTIST, PLACEHOLDER);
        // Worst case for the placeholder: the artist has already granted the claim its issuer role.
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
    }

    function _voucher(address claimant, uint256 nonce) internal view returns (GenesisHolderClaim.ClaimVoucher memory) {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: claimContract.GENESIS_CONTRACT(),
            genesisChainId: claimContract.GENESIS_CHAIN_ID(),
            eligibilityRule: claimContract.ELIGIBILITY_RULE(),
            destinationChainId: 43113,
            releaseContract: address(release),
            tokenId: tokenId,
            quantity: 1,
            allocation: claimContract.allocation(),
            nonce: nonce,
            deadline: block.timestamp + 300
        });
    }

    function _try(address claimant, GenesisHolderClaim.ClaimVoucher memory v, bytes memory signature)
        internal
        returns (bool ok, bytes4 selector)
    {
        vm.prank(claimant);
        bytes memory ret;
        (ok, ret) = address(claimContract).call(abi.encodeCall(GenesisHolderClaim.claim, (v, signature)));
        if (ret.length >= 4) selector = bytes4(ret);
    }

    function _sign(uint256 key, GenesisHolderClaim.ClaimVoucher memory v) internal returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(key, claimContract.voucherDigest(v));
        return abi.encodePacked(r, s, sv);
    }

    function _assertNothingMinted(address claimant) internal view {
        require(!claimContract.hasClaimed(claimant), "claimed");
        require(claimContract.claimedSupply() == 0, "supply moved");
        require(release.balanceOf(claimant, tokenId) == 0, "token minted");
    }

    // ---- the placeholder cannot authorize anything ----

    function testDeploymentRecordsTheArtistAsAdminAndThePlaceholderAsSigner() public view {
        require(claimContract.admin() == ARTIST, "admin");
        require(claimContract.signer() == PLACEHOLDER, "signer");
        require(!release.hasRole(release.ISSUER_ROLE(), PLACEHOLDER), "placeholder holds issuer");
        require(!release.hasRole(release.DEFAULT_ADMIN_ROLE(), PLACEHOLDER), "placeholder holds admin");
        require(claimContract.admin() != DEPLOYER, "deployer kept the claim admin");
    }

    function testNoVoucherSucceedsWhilePlaceholderIsTheSigner() public {
        vm.warp(CLAIM_START);
        uint256[4] memory keys = [REAL_SIGNER_KEY, OTHER_KEY, uint256(0xA7157), uint256(0xDE9107E4)];
        for (uint256 i = 0; i < keys.length; i++) {
            GenesisHolderClaim.ClaimVoucher memory v = _voucher(CLAIMANT, 100 + i);
            (bool ok, bytes4 selector) = _try(CLAIMANT, v, _sign(keys[i], v));
            require(!ok && selector == GenesisHolderClaim.InvalidSignature.selector, "a signed voucher was accepted");
        }
        // Malformed, empty and zero signatures cannot recover to the placeholder either.
        GenesisHolderClaim.ClaimVoucher memory v2 = _voucher(CLAIMANT, 200);
        (bool ok2, bytes4 sel2) = _try(CLAIMANT, v2, hex"");
        require(!ok2 && sel2 == GenesisHolderClaim.InvalidSignature.selector, "empty signature");
        (ok2, sel2) = _try(CLAIMANT, v2, new bytes(65));
        require(!ok2 && sel2 == GenesisHolderClaim.InvalidSignature.selector, "zero signature");
        (ok2, sel2) = _try(CLAIMANT, v2, abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(1)), uint8(27)));
        require(!ok2 && sel2 == GenesisHolderClaim.InvalidSignature.selector, "forged signature");
        _assertNothingMinted(CLAIMANT);
    }

    function testPlaceholderStaysClosedForTheWholeClaimWindowEvenWithTheIssuerGrant() public {
        uint256[3] memory times = [CLAIM_START, CLAIM_START + 150, CLAIM_END - 1];
        for (uint256 i = 0; i < times.length; i++) {
            vm.warp(times[i]);
            GenesisHolderClaim.ClaimVoucher memory v = _voucher(CLAIMANT, 300 + i);
            (bool ok,) = _try(CLAIMANT, v, _sign(REAL_SIGNER_KEY, v));
            require(!ok, "claim opened under the placeholder");
        }
        _assertNothingMinted(CLAIMANT);
    }

    // ---- only the artist can replace it ----

    function testOnlyTheArtistCanRotateTheSigner() public {
        address[4] memory outsiders = [DEPLOYER, NANO, CLAIMANT, PLACEHOLDER];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            (bool ok,) = address(claimContract).call(abi.encodeCall(GenesisHolderClaim.setSigner, (vm.addr(REAL_SIGNER_KEY))));
            require(!ok, "an outsider rotated the signer");
            vm.prank(outsiders[i]);
            (ok,) = address(claimContract).call(abi.encodeCall(GenesisHolderClaim.transferAdmin, (outsiders[i])));
            require(!ok, "an outsider took the claim admin");
        }
        require(claimContract.signer() == PLACEHOLDER && claimContract.admin() == ARTIST, "state moved");
        // The signer can never be rotated to the zero address, which a failed recovery returns.
        vm.prank(ARTIST);
        (bool zeroOk,) = address(claimContract).call(abi.encodeCall(GenesisHolderClaim.setSigner, (address(0))));
        require(!zeroOk, "zero signer accepted");
    }

    function testArtistRotationActivatesClaimsOnlyInsideTheWindowAndOnlyForTheNewSigner() public {
        address realSigner = vm.addr(REAL_SIGNER_KEY);
        vm.prank(ARTIST);
        claimContract.setSigner(realSigner);
        require(claimContract.signer() == realSigner, "not rotated");
        // Still closed before the window opens.
        vm.warp(CLAIM_START - 1);
        GenesisHolderClaim.ClaimVoucher memory early = _voucher(CLAIMANT, 400);
        (bool ok, bytes4 selector) = _try(CLAIMANT, early, _sign(REAL_SIGNER_KEY, early));
        require(!ok && selector == GenesisHolderClaim.ClaimNotOpen.selector, "opened early");
        // Open: the new signer's voucher mints, another key's does not, and the old placeholder never could.
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory other = _voucher(CLAIMANT_TWO, 401);
        (ok, selector) = _try(CLAIMANT_TWO, other, _sign(OTHER_KEY, other));
        require(!ok && selector == GenesisHolderClaim.InvalidSignature.selector, "a stranger's voucher was accepted");
        GenesisHolderClaim.ClaimVoucher memory good = _voucher(CLAIMANT, 402);
        (ok,) = _try(CLAIMANT, good, _sign(REAL_SIGNER_KEY, good));
        require(ok, "the real signer's voucher failed");
        require(release.balanceOf(CLAIMANT, tokenId) == 1 && claimContract.hasClaimed(CLAIMANT), "not minted");
        // And closed again once the window ends.
        vm.warp(CLAIM_END);
        GenesisHolderClaim.ClaimVoucher memory late = _voucher(CLAIMANT_TWO, 403);
        (ok, selector) = _try(CLAIMANT_TWO, late, _sign(REAL_SIGNER_KEY, late));
        require(!ok && selector == GenesisHolderClaim.ClaimWindowClosed.selector, "claim stayed open");
    }

    function testArtistCanPauseWhileThePlaceholderIsInPlaceAndAfterRotation() public {
        vm.prank(ARTIST);
        claimContract.pause();
        vm.prank(ARTIST);
        claimContract.setSigner(vm.addr(REAL_SIGNER_KEY));
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(CLAIMANT, 500);
        (bool ok, bytes4 selector) = _try(CLAIMANT, v, _sign(REAL_SIGNER_KEY, v));
        require(!ok && selector == GenesisHolderClaim.Paused.selector, "paused claim accepted a voucher");
    }
}
