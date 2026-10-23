// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactoryV4Sequential} from "../contracts/VoidReleaseFactoryV4Sequential.sol";
import {VoidRelease1155V6Sequential} from "../contracts/VoidRelease1155V6Sequential.sol";
import {VoidCollection1155} from "../contracts/VoidCollection1155.sol";
import {VoidPrimarySaleSettled} from "../contracts/VoidPrimarySaleSettled.sol";
import {MockGenesisCollection, installGenesisStandIn} from "./helpers/MockGenesisCollection.sol";

interface VmClaimSecurity {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert() external;
    function expectPartialRevert(bytes4) external;
    function expectEmit(bool, bool, bool, bool, address) external;
}

/// @dev A Genesis-holding contract wallet that claims for itself and, inside the ERC-1155 receiver hook, tries
/// a second claim and/or a paid purchase. It records what happened and accepts the token unless told to refuse.
contract ReentrantClaimant {
    GenesisHolderClaim internal immutable claim;
    VoidPrimarySaleSettled internal immutable sale;
    GenesisHolderClaim.ClaimVoucher internal second;
    bytes internal secondSignature;
    bool internal reenterClaim;
    bool internal reenterPurchase;
    bool internal refuse;
    bool internal entered;
    bytes4 public reentryError;
    bool public purchaseSucceeded;

    constructor(GenesisHolderClaim claim_, VoidPrimarySaleSettled sale_) payable {
        claim = claim_;
        sale = sale_;
    }

    function configure(bool reenterClaim_, bool reenterPurchase_, bool refuse_, GenesisHolderClaim.ClaimVoucher calldata second_, bytes calldata secondSignature_) external {
        reenterClaim = reenterClaim_;
        reenterPurchase = reenterPurchase_;
        refuse = refuse_;
        second = second_;
        secondSignature = secondSignature_;
    }

    function claimFor(GenesisHolderClaim.ClaimVoucher calldata voucher, bytes calldata signature) external {
        claim.claim(voucher, signature);
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes calldata) external returns (bytes4) {
        if (refuse) return bytes4(0xdeadbeef);
        if (!entered) {
            entered = true;
            if (reenterClaim) {
                try claim.claim(second, secondSignature) {
                    reentryError = bytes4(0);
                } catch (bytes memory reason) {
                    reentryError = bytes4(reason);
                }
            }
            if (reenterPurchase) {
                try sale.purchase{value: 0.25 ether}(id, 1) {
                    purchaseSucceeded = true;
                } catch {}
            }
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }
}

/// @notice GenesisHolderClaim security on the production contracts: VoidReleaseFactoryV4Sequential, a
/// VoidRelease1155V6Sequential clone with token 1 created like Studio's single, its VoidPrimarySaleSettled
/// (0.25 AVAX, uncapped, 3 paid per wallet), chain id 43114, and a Genesis stand-in at the real Genesis address
/// with explicit holders. The schedule is a test fixture (T + 8 days 4 hours), not a launch decision. Local EVM
/// only; keys are cheat-code fixtures.
contract GenesisHolderClaimSecurityTest {
    VmClaimSecurity internal constant vm = VmClaimSecurity(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant NANO = 0xb65C575CaE01574296Fab6E620B9A15cC0121ce4;
    address internal constant GENESIS = 0xD1B4367dd9f235f9ee61878019d66E31511E98eE;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant HOLDER = address(0x40D1);
    address internal constant HOLDER_TWO = address(0x40D2);
    address internal constant NON_HOLDER = address(0xBAD0);
    address internal constant STRANGER = address(0x57A);
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xBAD5;
    uint256 internal constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes32 internal constant APP = keccak256("forgive-and-forget-claim-security");
    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant PER_WALLET = 3;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant START = T0 + 1 hours;
    uint256 internal constant WINDOW = 8 days + 4 hours;
    uint256 internal constant END = START + WINDOW - 1;
    uint256 internal constant CLAIM_END = START + 1 days;

    event GenesisHolderClaimed(address indexed claimant, address indexed releaseContract, uint256 indexed tokenId, uint256 quantity, uint256 nonce, bytes32 voucherHash);

    VoidReleaseFactoryV4Sequential internal factory;
    VoidRelease1155V6Sequential internal release;
    VoidPrimarySaleSettled internal sale;
    GenesisHolderClaim internal claimContract;
    MockGenesisCollection internal genesis;
    bytes32 internal releaseKey;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(T0);
        genesis = installGenesisStandIn(false);
        genesis.setBalance(HOLDER, 0, 1);
        genesis.setBalance(HOLDER_TWO, 3, 5);
        factory = new VoidReleaseFactoryV4Sequential(NANO);
        releaseKey = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), APP, ARTIST));
        vm.prank(ARTIST);
        (address releaseAddress, address saleAddress,) = factory.createRelease(APP, releaseKey, "Forgive & Forget", "FNF", "ipfs://fnf");
        release = VoidRelease1155V6Sequential(releaseAddress);
        sale = VoidPrimarySaleSettled(saleAddress);
        vm.prank(ARTIST);
        release.createEdition(releaseKey, bytes32(TOKEN_ID), 0, "ipfs://fnf-1", ARTIST, 250);
        vm.prank(ARTIST);
        sale.configureSale(TOKEN_ID, PRICE, 0, PER_WALLET, uint64(START), uint64(END), false);
        claimContract = _deploy(address(release), address(sale), TOKEN_ID, ADMIN, vm.addr(SIGNER_KEY));
        _grantIssuer(address(claimContract));
    }

    // ---- 1. an eligible Genesis holder claims token 1 ---------------------------------------

    function testEligibleGenesisHolderClaimsTokenOne() public {
        vm.warp(START);
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(HOLDER, 1, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, v);
        vm.expectEmit(true, true, true, true, address(claimContract));
        emit GenesisHolderClaimed(HOLDER, address(release), TOKEN_ID, 1, 1, claimContract.voucherDigest(v));
        vm.prank(HOLDER);
        claimContract.claim(v, signature);
        require(release.balanceOf(HOLDER, TOKEN_ID) == 1, "token 1 minted to the holder");
        require(claimContract.hasClaimed(HOLDER) && claimContract.usedNonces(1) && claimContract.claimedSupply() == 1, "state");
        require(release.edition(TOKEN_ID).mintedSupply == 1, "one minted");
        // A holder of any Genesis ID 0..3 (here only ID 3) is eligible.
        _claim(HOLDER_TWO, 2);
        require(release.balanceOf(HOLDER_TWO, TOKEN_ID) == 1, "ID 3 holder");
    }

    // ---- 2. a non-holder is rejected, even with a correctly signed voucher -------------------

    function testNonHolderIsRejectedEvenWithAValidVoucher() public {
        vm.warp(START);
        _expectClaimRevert(NON_HOLDER, _voucher(NON_HOLDER, 3, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.NotGenesisHolder.selector);
        // Holding only a token outside Genesis IDs 0..3 does not count.
        genesis.setBalance(NON_HOLDER, 4, 10);
        _expectClaimRevert(NON_HOLDER, _voucher(NON_HOLDER, 4, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.NotGenesisHolder.selector);
        // A holder who moves the Genesis token away after the voucher was signed can no longer claim.
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(HOLDER, 5, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, v);
        genesis.setBalance(HOLDER, 0, 0);
        vm.expectPartialRevert(GenesisHolderClaim.NotGenesisHolder.selector);
        vm.prank(HOLDER);
        claimContract.claim(v, signature);
        require(!claimContract.hasClaimed(NON_HOLDER) && !claimContract.hasClaimed(HOLDER) && !claimContract.usedNonces(5), "nothing recorded");
        require(claimContract.claimedSupply() == 0 && release.edition(TOKEN_ID).mintedSupply == 0, "nothing minted");
        // The Genesis read failing closes claims rather than skipping the check.
        genesis.setBalance(HOLDER, 0, 1);
        genesis.setReverting(true);
        vm.expectRevert();
        vm.prank(HOLDER);
        claimContract.claim(v, signature);
    }

    // ---- 3. double claims are rejected -------------------------------------------------------

    function testDoubleClaimIsRejected() public {
        vm.warp(START);
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(HOLDER, 6, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, v);
        vm.prank(HOLDER);
        claimContract.claim(v, signature);
        // The same voucher again, and a fresh voucher with a new nonce, are both refused for the same wallet.
        vm.expectPartialRevert(GenesisHolderClaim.AlreadyClaimed.selector);
        vm.prank(HOLDER);
        claimContract.claim(v, signature);
        _expectClaimRevert(HOLDER, _voucher(HOLDER, 7, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.AlreadyClaimed.selector);
        // More Genesis units do not buy more claims.
        genesis.setBalance(HOLDER, 1, 50);
        _expectClaimRevert(HOLDER, _voucher(HOLDER, 8, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.AlreadyClaimed.selector);
        require(release.balanceOf(HOLDER, TOKEN_ID) == 1 && claimContract.claimedSupply() == 1, "one claim");
    }

    // ---- 4. claim before opening and at/after expiry is rejected -----------------------------

    function testClaimWindowBoundaries() public {
        vm.warp(START - 1);
        _expectClaimRevert(HOLDER, _voucher(HOLDER, 9, START + 300), SIGNER_KEY, GenesisHolderClaim.ClaimNotOpen.selector);
        vm.warp(START);
        _claim(HOLDER, 10);
        vm.warp(CLAIM_END - 1);
        // A voucher whose deadline is exactly now is still valid; one second earlier is expired.
        GenesisHolderClaim.ClaimVoucher memory atDeadline = _voucher(HOLDER_TWO, 11, block.timestamp);
        _expectClaimRevert(HOLDER_TWO, _voucher(HOLDER_TWO, 12, block.timestamp - 1), SIGNER_KEY, GenesisHolderClaim.ExpiredVoucher.selector);
        bytes memory signature = _sign(SIGNER_KEY, atDeadline);
        vm.prank(HOLDER_TWO);
        claimContract.claim(atDeadline, signature);
        vm.warp(CLAIM_END);
        genesis.setBalance(NON_HOLDER, 2, 1);
        _expectClaimRevert(NON_HOLDER, _voucher(NON_HOLDER, 13, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.ClaimWindowClosed.selector);
        vm.warp(END + 1);
        _expectClaimRevert(NON_HOLDER, _voucher(NON_HOLDER, 14, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.ClaimWindowClosed.selector);
        require(claimContract.claimedSupply() == 2, "only in-window claims");
    }

    // ---- 5. wrong token, collection, chain, signature and replay are rejected ----------------

    function testWrongTokenCollectionOrRuleIsRejected() public {
        vm.warp(START);
        GenesisHolderClaim.ClaimVoucher memory v;
        v = _voucher(HOLDER, 15, block.timestamp + 300);
        v.tokenId = 2;
        _expectClaimRevert(HOLDER, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(HOLDER, 16, block.timestamp + 300);
        v.releaseContract = address(sale);
        _expectClaimRevert(HOLDER, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(HOLDER, 17, block.timestamp + 300);
        v.genesisContract = address(release);
        _expectClaimRevert(HOLDER, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(HOLDER, 18, block.timestamp + 300);
        v.genesisChainId = 43113;
        _expectClaimRevert(HOLDER, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(HOLDER, 19, block.timestamp + 300);
        v.eligibilityRule = keccak256("any wallet");
        _expectClaimRevert(HOLDER, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(HOLDER, 20, block.timestamp + 300);
        v.destinationChainId = 43113;
        _expectClaimRevert(HOLDER, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(HOLDER, 21, block.timestamp + 300);
        v.allocation = 5;
        _expectClaimRevert(HOLDER, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(HOLDER, 22, block.timestamp + 300);
        v.quantity = 2;
        _expectClaimRevert(HOLDER, v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        v = _voucher(address(0), 23, block.timestamp + 300);
        _expectClaimRevert(address(0), v, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        // The deployed claim refuses to run under another chain id.
        vm.chainId(43113);
        _expectClaimRevert(HOLDER, _voucher(HOLDER, 24, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.WrongDestinationChain.selector);
        vm.chainId(43114);
        require(claimContract.claimedSupply() == 0, "nothing claimed");
    }

    function testInvalidSignaturesAreRejected() public {
        vm.warp(START);
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(HOLDER, 25, block.timestamp + 300);
        bytes32 digest = claimContract.voucherDigest(v);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        // Another key.
        _expectClaimRevert(HOLDER, v, OTHER_KEY, GenesisHolderClaim.InvalidSignature.selector);
        // Wrong length (64-byte compact form is not accepted).
        _expectRawRevert(HOLDER, v, abi.encodePacked(r, s), GenesisHolderClaim.InvalidSignature.selector);
        // The malleable twin (s' = n - s, flipped v) of a valid signature.
        _expectRawRevert(HOLDER, v, abi.encodePacked(r, bytes32(SECP256K1N - uint256(s)), sv == 27 ? uint8(28) : uint8(27)), GenesisHolderClaim.InvalidSignature.selector);
        // v outside {27, 28}.
        _expectRawRevert(HOLDER, v, abi.encodePacked(r, s, uint8(sv - 27)), GenesisHolderClaim.InvalidSignature.selector);
        // A signature over another field set (the voucher edited after signing).
        // (a fresh struct: assigning a memory struct copies only the reference)
        GenesisHolderClaim.ClaimVoucher memory edited = _voucher(HOLDER, 25, v.deadline + 1);
        _expectRawRevert(HOLDER, edited, abi.encodePacked(r, s, sv), GenesisHolderClaim.InvalidSignature.selector);
        // A voucher signed for another claim contract (different EIP-712 domain).
        GenesisHolderClaim other = _deploy(address(release), address(sale), TOKEN_ID, ADMIN, vm.addr(SIGNER_KEY));
        (uint8 ov, bytes32 orr, bytes32 os) = vm.sign(SIGNER_KEY, other.voucherDigest(v));
        _expectRawRevert(HOLDER, v, abi.encodePacked(orr, os, ov), GenesisHolderClaim.InvalidSignature.selector);
        // The genuine signature still works afterwards: none of the failures consumed anything.
        vm.prank(HOLDER);
        claimContract.claim(v, abi.encodePacked(r, s, sv));
        require(claimContract.claimedSupply() == 1, "one claim");
    }

    function testReplayAndFrontRunningCannotTakeAnotherWalletsEntitlement() public {
        vm.warp(START);
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(HOLDER, 26, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, v);
        // A front-runner submitting the holder's voucher from its own address is refused; the mint is bound to
        // voucher.claimant, which the signature covers, so it cannot be redirected.
        genesis.setBalance(STRANGER, 0, 1);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidVoucher.selector);
        vm.prank(STRANGER);
        claimContract.claim(v, signature);
        GenesisHolderClaim.ClaimVoucher memory redirected = _voucher(HOLDER, 26, v.deadline);
        redirected.claimant = STRANGER;
        vm.expectPartialRevert(GenesisHolderClaim.InvalidSignature.selector);
        vm.prank(STRANGER);
        claimContract.claim(redirected, signature);
        // The front-run attempts consumed nothing: the holder still claims.
        vm.prank(HOLDER);
        claimContract.claim(v, signature);
        // A used nonce cannot be replayed by any wallet, even with its own valid signature.
        _expectClaimRevert(HOLDER_TWO, _voucher(HOLDER_TWO, 26, block.timestamp + 300), SIGNER_KEY, GenesisHolderClaim.Replay.selector);
        require(release.balanceOf(HOLDER, TOKEN_ID) == 1 && release.balanceOf(STRANGER, TOKEN_ID) == 0, "entitlement kept");
    }

    // ---- 6. unauthorized callers cannot change parameters or take funds ----------------------

    function testOnlyTheAdminChangesTheSignerAdminOrPause() public {
        address signer = vm.addr(SIGNER_KEY);
        address[3] memory outsiders = [ARTIST, signer, STRANGER];
        for (uint256 i; i < outsiders.length; ++i) {
            vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
            vm.prank(outsiders[i]);
            claimContract.setSigner(outsiders[i]);
            vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
            vm.prank(outsiders[i]);
            claimContract.transferAdmin(outsiders[i]);
            vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
            vm.prank(outsiders[i]);
            claimContract.pause();
            vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
            vm.prank(outsiders[i]);
            claimContract.unpause();
        }
        // The admin keeps the roles separate: no zero signer, no signer equal to the admin, no admin equal to the signer.
        vm.expectPartialRevert(GenesisHolderClaim.InvalidAddress.selector);
        vm.prank(ADMIN);
        claimContract.setSigner(address(0));
        vm.expectPartialRevert(GenesisHolderClaim.InvalidAddress.selector);
        vm.prank(ADMIN);
        claimContract.setSigner(ADMIN);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidAddress.selector);
        vm.prank(ADMIN);
        claimContract.transferAdmin(signer);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidAddress.selector);
        vm.prank(ADMIN);
        claimContract.transferAdmin(address(0));
        // After an admin transfer the old admin has no power.
        vm.prank(ADMIN);
        claimContract.transferAdmin(STRANGER);
        vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
        vm.prank(ADMIN);
        claimContract.pause();
        require(claimContract.admin() == STRANGER && claimContract.signer() == signer, "roles");
    }

    function testNoFundsCanEnterOrLeaveThroughTheClaim() public {
        vm.warp(START);
        // The claim takes no payment and holds no balance: value on claim() or a plain transfer is refused.
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(HOLDER, 27, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, v);
        vm.deal(HOLDER, 1 ether);
        vm.prank(HOLDER);
        (bool paid,) = address(claimContract).call{value: 1 wei}(abi.encodeCall(GenesisHolderClaim.claim, (v, signature)));
        require(!paid, "claim accepted value");
        vm.prank(HOLDER);
        (bool sent,) = address(claimContract).call{value: 1 wei}("");
        require(!sent, "claim accepted a transfer");
        require(address(claimContract).balance == 0, "claim holds no AVAX");
        // Sale proceeds are withdrawable only by the payout wallet itself.
        vm.deal(STRANGER, PRICE);
        vm.prank(STRANGER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        uint256 owed = sale.balances(ARTIST);
        require(owed == PRICE - (PRICE * 250) / 10_000, "artist credited");
        vm.expectPartialRevert(VoidPrimarySaleSettled.NothingToWithdraw.selector);
        vm.prank(STRANGER);
        sale.withdraw();
        vm.expectPartialRevert(VoidPrimarySaleSettled.NothingToWithdraw.selector);
        vm.prank(ADMIN);
        sale.withdraw();
        require(sale.balances(ARTIST) == owed, "artist proceeds intact");
    }

    function testTheClaimHoldsOnlyTheMintPermission() public view {
        require(release.hasRole(release.ISSUER_ROLE(), address(claimContract)), "issuer");
        require(!release.hasRole(release.DEFAULT_ADMIN_ROLE(), address(claimContract)), "no admin");
        require(!release.hasRole(release.ARTIST_ROLE(), address(claimContract)), "no artist role");
        // The artist administers the release but cannot mint directly; only the sale and the claim can.
        require(!release.hasRole(release.ISSUER_ROLE(), ARTIST) && release.hasRole(release.ISSUER_ROLE(), address(sale)), "issuers");
    }

    // ---- 7. failed mints and reentrant receivers cannot bypass protections ------------------

    function testAFailedMintRevertsEverythingAndConsumesNothing() public {
        vm.warp(START);
        // No ISSUER_ROLE yet: the mint reverts and nothing is recorded.
        GenesisHolderClaim fresh = _deploy(address(release), address(sale), TOKEN_ID, ADMIN, vm.addr(SIGNER_KEY));
        GenesisHolderClaim.ClaimVoucher memory v = _voucherFor(fresh, HOLDER, 28, block.timestamp + 300);
        bytes memory signature = _signFor(fresh, SIGNER_KEY, v);
        vm.expectPartialRevert(VoidCollection1155.AccessDenied.selector);
        vm.prank(HOLDER);
        fresh.claim(v, signature);
        require(!fresh.hasClaimed(HOLDER) && !fresh.usedNonces(28) && fresh.claimedSupply() == 0, "no grant: nothing recorded");
        // The release paused by its admin: the mint reverts and nothing is recorded.
        vm.prank(ARTIST);
        release.pause();
        GenesisHolderClaim.ClaimVoucher memory p = _voucher(HOLDER, 29, block.timestamp + 300);
        bytes memory pSignature = _sign(SIGNER_KEY, p);
        vm.expectPartialRevert(VoidCollection1155.ContractPaused.selector);
        vm.prank(HOLDER);
        claimContract.claim(p, pSignature);
        vm.prank(ARTIST);
        release.unpause();
        // A contract claimant that refuses the token: the mint reverts and nothing is recorded.
        ReentrantClaimant refusing = new ReentrantClaimant(claimContract, sale);
        genesis.setBalance(address(refusing), 0, 1);
        GenesisHolderClaim.ClaimVoucher memory none;
        refusing.configure(false, false, true, none, "");
        GenesisHolderClaim.ClaimVoucher memory r = _voucher(address(refusing), 30, block.timestamp + 300);
        bytes memory rSignature = _sign(SIGNER_KEY, r);
        vm.expectPartialRevert(VoidCollection1155.UnsafeRecipient.selector);
        refusing.claimFor(r, rSignature);
        require(!claimContract.hasClaimed(address(refusing)) && !claimContract.usedNonces(30), "refused: nothing recorded");
        // The paused-release voucher still works once the release is unpaused.
        vm.prank(HOLDER);
        claimContract.claim(p, pSignature);
        require(claimContract.claimedSupply() == 1 && release.edition(TOKEN_ID).mintedSupply == 1, "one mint");
    }

    function testReentrantClaimFromTheReceiverHookIsBlocked() public {
        vm.warp(START);
        ReentrantClaimant attacker = new ReentrantClaimant(claimContract, sale);
        genesis.setBalance(address(attacker), 0, 1);
        // The re-entry uses a second, correctly signed voucher with a fresh nonce for the same wallet.
        GenesisHolderClaim.ClaimVoucher memory second = _voucher(address(attacker), 32, block.timestamp + 300);
        attacker.configure(true, false, false, second, _sign(SIGNER_KEY, second));
        GenesisHolderClaim.ClaimVoucher memory first = _voucher(address(attacker), 31, block.timestamp + 300);
        attacker.claimFor(first, _sign(SIGNER_KEY, first));
        bytes4 reentrancy = bytes4(keccak256("Reentrancy()"));
        require(attacker.reentryError() == reentrancy, "re-entry not blocked by the guard");
        require(release.balanceOf(address(attacker), TOKEN_ID) == 1 && claimContract.claimedSupply() == 1, "one free token");
        require(claimContract.usedNonces(31) && !claimContract.usedNonces(32), "second voucher unused");
        // Outside the hook the second voucher is refused too: the wallet has claimed.
        bytes memory secondSignature = _sign(SIGNER_KEY, second);
        vm.expectPartialRevert(GenesisHolderClaim.AlreadyClaimed.selector);
        attacker.claimFor(second, secondSignature);
    }

    function testAPaidPurchaseFromTheReceiverHookStillPaysAndKeepsAccounting() public {
        vm.warp(START);
        ReentrantClaimant buyer = new ReentrantClaimant{value: PRICE}(claimContract, sale);
        genesis.setBalance(address(buyer), 2, 1);
        GenesisHolderClaim.ClaimVoucher memory none;
        buyer.configure(false, true, false, none, "");
        uint256 nanoBefore = NANO.balance;
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(address(buyer), 33, block.timestamp + 300);
        buyer.claimFor(v, _sign(SIGNER_KEY, v));
        require(buyer.purchaseSucceeded(), "nested purchase");
        require(release.balanceOf(address(buyer), TOKEN_ID) == 2, "1 free + 1 paid");
        require(NANO.balance - nanoBefore == (PRICE * 250) / 10_000, "platform fee pushed for the paid copy only");
        require(sale.balances(ARTIST) == PRICE - (PRICE * 250) / 10_000, "artist credited for the paid copy only");
        require(sale.walletPurchased(TOKEN_ID, address(buyer)) == 1, "the free copy is not a paid purchase");
        _assertAccounting(1, 1);
    }

    // ---- 8. claim + paid sale: supply, wallet limit, fees ------------------------------------

    function testClaimThenThreePaidPerWalletWithExactFees() public {
        vm.warp(START);
        uint256 nanoBefore = NANO.balance;
        _claim(HOLDER, 34);
        require(NANO.balance == nanoBefore && sale.balances(ARTIST) == 0, "a free claim moves no AVAX");
        vm.deal(HOLDER, PRICE * 4);
        vm.prank(HOLDER);
        sale.purchase{value: PRICE * 3}(TOKEN_ID, 3);
        vm.expectPartialRevert(VoidPrimarySaleSettled.WalletLimitExceeded.selector);
        vm.prank(HOLDER);
        sale.purchase{value: PRICE}(TOKEN_ID, 1);
        vm.expectPartialRevert(VoidPrimarySaleSettled.WrongPayment.selector);
        vm.prank(HOLDER_TWO);
        sale.purchase{value: 0}(TOKEN_ID, 1);
        uint256 paid = PRICE * 3;
        require(NANO.balance - nanoBefore == (paid * 250) / 10_000, "2.5% of paid copies");
        require(sale.balances(ARTIST) == paid - (paid * 250) / 10_000, "97.5% of paid copies");
        require(release.balanceOf(HOLDER, TOKEN_ID) == 4 && sale.walletPurchased(TOKEN_ID, HOLDER) == 3, "1 free + 3 paid");
        _assertAccounting(1, 3);
        // The paid sale continues after the claim closes, with the same limit.
        vm.warp(CLAIM_END);
        vm.deal(NON_HOLDER, PRICE * 3);
        vm.prank(NON_HOLDER);
        sale.purchase{value: PRICE * 3}(TOKEN_ID, 3);
        _assertAccounting(1, 6);
    }

    // ---- 9. constructor validation and invalid configurations -------------------------------

    function testConstructorRefusesUnsafeTargetsAndRoles() public {
        address signer = vm.addr(SIGNER_KEY);
        // A sale for a different release: the claim would read another token's schedule.
        bytes32 otherApp = keccak256("another release");
        bytes32 otherKey = keccak256(abi.encode("the-void:studio-release:v2", block.chainid, address(factory), otherApp, ARTIST));
        vm.prank(ARTIST);
        (, address otherSale,) = factory.createRelease(otherApp, otherKey, "Other", "OTH", "ipfs://other");
        _expectDeployRevert(address(release), otherSale, TOKEN_ID, ADMIN, signer);
        // Zero addresses, targets without code, the same contract twice, the Genesis collection as a target.
        _expectDeployRevert(address(0), address(sale), TOKEN_ID, ADMIN, signer);
        _expectDeployRevert(address(release), address(0), TOKEN_ID, ADMIN, signer);
        _expectDeployRevert(address(release), address(sale), TOKEN_ID, address(0), signer);
        _expectDeployRevert(address(release), address(sale), TOKEN_ID, ADMIN, address(0));
        _expectDeployRevert(address(0xC0DE), address(sale), TOKEN_ID, ADMIN, signer);
        _expectDeployRevert(address(release), address(0xC0DE), TOKEN_ID, ADMIN, signer);
        _expectDeployRevert(address(release), address(release), TOKEN_ID, ADMIN, signer);
        _expectDeployRevert(GENESIS, address(sale), TOKEN_ID, ADMIN, signer);
        // The voucher signer may not be the admin.
        _expectDeployRevert(address(release), address(sale), TOKEN_ID, ADMIN, ADMIN);
        // A token that does not exist on the release.
        vm.expectRevert();
        new GenesisHolderClaim(address(release), address(sale), 2, 0, 0, START, 1 days, WINDOW, PRICE, ADMIN, signer);
    }

    function testMainnetRefusesToDeployWithoutTheGenesisCollection() public {
        // The Genesis collection must exist on C-Chain for the holder check; an empty address fails closed.
        VmEtchLike(address(vm)).etch(GENESIS, "");
        _expectDeployRevert(address(release), address(sale), TOKEN_ID, ADMIN, vm.addr(SIGNER_KEY));
        // Fuji has no Genesis collection and skips the on-chain holder check (vouchers alone gate test claims).
        vm.chainId(43113);
        vm.prank(ARTIST);
        sale.configureSale(TOKEN_ID, 0.01 ether, 0, PER_WALLET, uint64(START), uint64(START + 10 minutes - 1), false);
        GenesisHolderClaim fuji = new GenesisHolderClaim(address(release), address(sale), TOKEN_ID, 0, 0, START, 5 minutes, 10 minutes, 0.01 ether, ADMIN, vm.addr(SIGNER_KEY));
        _grantIssuer(address(fuji));
        vm.warp(START);
        GenesisHolderClaim.ClaimVoucher memory v = _voucherFor(fuji, NON_HOLDER, 35, block.timestamp + 60);
        v.destinationChainId = 43113;
        bytes memory signature = _signFor(fuji, SIGNER_KEY, v);
        vm.prank(NON_HOLDER);
        fuji.claim(v, signature);
        require(release.balanceOf(NON_HOLDER, TOKEN_ID) == 1, "Fuji claim");
    }

    // ---- helpers -----------------------------------------------------------------------------

    function _deploy(address releaseAddress, address saleAddress, uint256 id, address admin, address signer) internal returns (GenesisHolderClaim) {
        return new GenesisHolderClaim(releaseAddress, saleAddress, id, 0, 0, START, 1 days, WINDOW, PRICE, admin, signer);
    }

    function _expectDeployRevert(address releaseAddress, address saleAddress, uint256 id, address admin, address signer) internal {
        vm.expectPartialRevert(GenesisHolderClaim.InvalidConfiguration.selector);
        _deploy(releaseAddress, saleAddress, id, admin, signer);
    }

    function _grantIssuer(address to) internal {
        bytes32 role = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(role, to);
    }

    function _assertAccounting(uint256 claimed, uint256 sold) internal view {
        (,, uint256 saleSold,,,,,) = sale.sales(TOKEN_ID);
        require(saleSold == sold && claimContract.claimedSupply() == claimed, "counters");
        require(release.edition(TOKEN_ID).mintedSupply == saleSold + claimContract.claimedSupply(), "mintedSupply != sold + claimed");
    }

    function _claim(address claimant, uint256 nonce) internal {
        GenesisHolderClaim.ClaimVoucher memory v = _voucher(claimant, nonce, block.timestamp + 300);
        bytes memory signature = _sign(SIGNER_KEY, v);
        vm.prank(claimant);
        claimContract.claim(v, signature);
    }

    function _expectClaimRevert(address caller, GenesisHolderClaim.ClaimVoucher memory v, uint256 key, bytes4 selector) internal {
        _expectRawRevert(caller, v, _sign(key, v), selector);
    }

    function _expectRawRevert(address caller, GenesisHolderClaim.ClaimVoucher memory v, bytes memory signature, bytes4 selector) internal {
        vm.expectPartialRevert(selector);
        vm.prank(caller);
        claimContract.claim(v, signature);
    }

    function _voucher(address claimant, uint256 nonce, uint256 deadline) internal view returns (GenesisHolderClaim.ClaimVoucher memory) {
        return _voucherFor(claimContract, claimant, nonce, deadline);
    }

    function _voucherFor(GenesisHolderClaim c, address claimant, uint256 nonce, uint256 deadline) internal view returns (GenesisHolderClaim.ClaimVoucher memory) {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: c.GENESIS_CONTRACT(),
            genesisChainId: c.GENESIS_CHAIN_ID(),
            eligibilityRule: c.ELIGIBILITY_RULE(),
            destinationChainId: 43114,
            releaseContract: c.releaseContract(),
            tokenId: c.tokenId(),
            quantity: 1,
            allocation: c.allocation(),
            nonce: nonce,
            deadline: deadline
        });
    }

    function _sign(uint256 key, GenesisHolderClaim.ClaimVoucher memory v) internal returns (bytes memory) {
        return _signFor(claimContract, key, v);
    }

    function _signFor(GenesisHolderClaim c, uint256 key, GenesisHolderClaim.ClaimVoucher memory v) internal returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(key, c.voucherDigest(v));
        return abi.encodePacked(r, s, sv);
    }
}

interface VmEtchLike {
    function etch(address target, bytes calldata code) external;
}
