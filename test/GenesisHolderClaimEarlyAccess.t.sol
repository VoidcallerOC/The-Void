// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GenesisHolderClaim} from "../contracts/GenesisHolderClaim.sol";
import {VoidReleaseFactory} from "../contracts/VoidReleaseFactory.sol";
import {VoidRelease1155V4} from "../contracts/VoidRelease1155V4.sol";
import {VoidPrimarySale} from "../contracts/VoidPrimarySale.sol";

interface VmEarly {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectPartialRevert(bytes4) external;
    function expectRevert() external;
    function etch(address, bytes calldata) external;
}

/// @dev Stands in for the Genesis collection at its C-Chain address; balances are set per test.
contract MockGenesisCollection {
    mapping(address => mapping(uint256 => uint256)) public balance;

    function setBalance(address account, uint256 id, uint256 amount) external {
        balance[account][id] = amount;
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory out) {
        out = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) out[i] = balance[accounts[i]][ids[i]];
    }
}

/// @notice One-wallet early access ahead of the production schedule on C-Chain (43114): an uncapped open
/// edition, free Genesis claims for 24 hours from claimStart, and a 7-day paid sale at 0.25 AVAX with a
/// limit of three per wallet, also from claimStart.
contract GenesisHolderClaimEarlyAccessTest {
    VmEarly internal constant vm = VmEarly(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    address internal constant ARTIST = address(0xA7157);
    address internal constant ADMIN = address(0xAD01);
    address internal constant EARLY = address(0xEA21);
    address internal constant OTHER = address(0x0BAD);
    address internal constant HOLDER = address(0xCA11);
    address internal constant PLATFORM = address(0xFEE);
    address internal constant SAFE = address(0x5AFE);
    bytes32 internal constant RELEASE_KEY = keccak256("early-access-release");
    bytes32 internal constant EDITION_ID = keccak256("early-access-edition");
    uint256 internal constant PRICE = 0.25 ether;
    uint256 internal constant WALLET_LIMIT = 3;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant EARLY_START = T0 + 1 hours;
    uint256 internal constant EARLY_END = T0 + 2 hours;
    uint256 internal constant CLAIM_START = T0 + 3 hours;
    uint256 internal constant CLAIM_END = CLAIM_START + 1 days;
    uint256 internal constant PUBLIC_END = CLAIM_START + 7 days - 1;

    VoidRelease1155V4 internal release;
    VoidPrimarySale internal sale;
    GenesisHolderClaim internal claimContract;
    MockGenesisCollection internal genesis;
    uint256 internal tokenId;
    address internal signer;

    function setUp() public {
        vm.chainId(43114);
        vm.warp(T0);
        signer = vm.addr(SIGNER_KEY);
        MockGenesisCollection impl = new MockGenesisCollection();
        address genesisAddress = 0xD1B4367dd9f235f9ee61878019d66E31511E98eE;
        vm.etch(genesisAddress, address(impl).code);
        genesis = MockGenesisCollection(genesisAddress);
        VoidReleaseFactory factory = new VoidReleaseFactory(PLATFORM, 500, SAFE);
        (address releaseAddress, address saleAddress,) =
            factory.createRelease(ARTIST, RELEASE_KEY, "Early access release", "EAR", "ipfs://early");
        release = VoidRelease1155V4(releaseAddress);
        sale = VoidPrimarySale(payable(saleAddress));
        vm.prank(ARTIST);
        tokenId = release.createEditionWithMintEnd(RELEASE_KEY, EDITION_ID, 0, "ipfs://early-edition", ARTIST, 0, uint64(PUBLIC_END));
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, WALLET_LIMIT, uint64(CLAIM_START), uint64(PUBLIC_END), false);
        claimContract = new GenesisHolderClaim(
            address(release), address(sale), tokenId, 0, 0, CLAIM_START, 1 days, 7 days, PRICE, ADMIN, signer
        );
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
        vm.prank(ADMIN);
        claimContract.configureEarlyAccess(EARLY, uint64(EARLY_START), uint64(EARLY_END));
    }

    // 1. The approved wallet mints once, free, inside its window.
    function testApprovedWalletMintsOnceFreeInsideItsWindow() public {
        vm.warp(EARLY_START);
        uint256 before = EARLY.balance;
        _mint(EARLY, _voucher(EARLY, 1), SIGNER_KEY);
        require(release.balanceOf(EARLY, tokenId) == 1, "early mint missing");
        require(EARLY.balance == before, "early access charged the wallet");
        require(claimContract.earlyAccessClaimed(), "entitlement not consumed");
        require(claimContract.claimedSupply() == 1, "supply accounting skipped the early mint");
        require(!claimContract.hasClaimed(EARLY), "early access consumed a Genesis claim");
        (,, uint256 sold,,,,,) = sale.sales(tokenId);
        require(sold == 0, "early access counted as a sale");
    }

    function testLastSecondOfTheWindowIsAccepted() public {
        vm.warp(EARLY_END - 1);
        _mint(EARLY, _voucher(EARLY, 2), SIGNER_KEY);
        require(release.balanceOf(EARLY, tokenId) == 1, "early mint missing");
    }

    // 2. Any other wallet is rejected, with its own voucher or the approved wallet's.
    function testOtherWalletRejected() public {
        vm.warp(EARLY_START);
        _expectRevert(OTHER, _voucher(OTHER, 3), SIGNER_KEY, GenesisHolderClaim.NotEarlyAccessWallet.selector);
        _expectRevert(OTHER, _voucher(EARLY, 4), SIGNER_KEY, GenesisHolderClaim.NotEarlyAccessWallet.selector);
        GenesisHolderClaim.EarlyAccessVoucher memory substituted = _voucher(OTHER, 5);
        _expectRevert(EARLY, substituted, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
    }

    // 3. and 4. Before the window, at its exclusive end and after it, the wallet is rejected.
    function testRejectedBeforeAndAfterTheWindow() public {
        vm.warp(EARLY_START - 1);
        _expectRevert(EARLY, _voucher(EARLY, 6), SIGNER_KEY, GenesisHolderClaim.EarlyAccessNotOpen.selector);
        vm.warp(EARLY_END);
        _expectRevert(EARLY, _voucher(EARLY, 7), SIGNER_KEY, GenesisHolderClaim.EarlyAccessClosed.selector);
        vm.warp(CLAIM_START);
        _expectRevert(EARLY, _voucher(EARLY, 8), SIGNER_KEY, GenesisHolderClaim.EarlyAccessClosed.selector);
    }

    // 5. A second successful mint is impossible, even with a fresh nonce.
    function testSecondMintRejected() public {
        vm.warp(EARLY_START);
        _mint(EARLY, _voucher(EARLY, 9), SIGNER_KEY);
        _expectRevert(EARLY, _voucher(EARLY, 10), SIGNER_KEY, GenesisHolderClaim.AlreadyClaimed.selector);
        require(release.balanceOf(EARLY, tokenId) == 1, "second early mint");
    }

    // 6. Replayed vouchers, reused nonces and cross-type signatures are rejected.
    function testReplayAndCrossTypeVouchersRejected() public {
        vm.warp(EARLY_START);
        GenesisHolderClaim.EarlyAccessVoucher memory voucher = _voucher(EARLY, 11);
        bytes memory signature = _sign(voucher, SIGNER_KEY);
        vm.prank(EARLY);
        claimContract.earlyAccessMint(voucher, signature);
        vm.prank(EARLY);
        vm.expectPartialRevert(GenesisHolderClaim.AlreadyClaimed.selector);
        claimContract.earlyAccessMint(voucher, signature);
        // The early-access nonce is spent for Genesis claims too.
        genesis.setBalance(HOLDER, 0, 1);
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory claimVoucher = _claimVoucher(HOLDER, 11);
        bytes memory claimSignature = _signClaim(claimVoucher);
        vm.prank(HOLDER);
        vm.expectPartialRevert(GenesisHolderClaim.Replay.selector);
        claimContract.claim(claimVoucher, claimSignature);
    }

    function testGenesisClaimSignatureCannotAuthorizeEarlyAccess() public {
        vm.warp(EARLY_START);
        GenesisHolderClaim.EarlyAccessVoucher memory voucher = _voucher(EARLY, 12);
        GenesisHolderClaim.ClaimVoucher memory claimVoucher = _claimVoucher(EARLY, 12);
        bytes memory claimSignature = _signClaim(claimVoucher);
        vm.prank(EARLY);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidSignature.selector);
        claimContract.earlyAccessMint(voucher, claimSignature);
        _expectRevert(EARLY, voucher, OTHER_KEY, GenesisHolderClaim.InvalidSignature.selector);
    }

    function testVoucherForAnotherWindowOrTokenRejected() public {
        vm.warp(EARLY_START);
        GenesisHolderClaim.EarlyAccessVoucher memory voucher = _voucher(EARLY, 13);
        voucher.windowEnd = CLAIM_START;
        _expectRevert(EARLY, voucher, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        voucher = _voucher(EARLY, 14);
        voucher.quantity = 2;
        _expectRevert(EARLY, voucher, SIGNER_KEY, GenesisHolderClaim.InvalidVoucher.selector);
        voucher = _voucher(EARLY, 15);
        voucher.deadline = EARLY_START - 1;
        _expectRevert(EARLY, voucher, SIGNER_KEY, GenesisHolderClaim.ExpiredVoucher.selector);
    }

    // 7. A failed mint reverts atomically and the same voucher can be retried.
    function testAFailedMintLeavesTheEntitlementUnused() public {
        vm.warp(EARLY_START);
        bytes32 issuerRole = release.ISSUER_ROLE();
        vm.prank(ARTIST);
        release.revokeRole(issuerRole, address(claimContract));
        GenesisHolderClaim.EarlyAccessVoucher memory voucher = _voucher(EARLY, 16);
        bytes memory signature = _sign(voucher, SIGNER_KEY);
        vm.prank(EARLY);
        vm.expectRevert();
        claimContract.earlyAccessMint(voucher, signature);
        require(!claimContract.earlyAccessClaimed() && !claimContract.usedNonces(16), "failed mint consumed state");
        require(claimContract.claimedSupply() == 0, "failed mint counted");
        vm.prank(ARTIST);
        release.grantRole(issuerRole, address(claimContract));
        vm.prank(EARLY);
        claimContract.earlyAccessMint(voucher, signature);
        require(release.balanceOf(EARLY, tokenId) == 1, "retry failed");
    }

    // 8. Missing, disabled, or invalid configuration fails closed.
    function testUnconfiguredAndDisabledEarlyAccessFailClosed() public {
        GenesisHolderClaim fresh = new GenesisHolderClaim(
            address(release), address(sale), tokenId, 0, 0, CLAIM_START, 1 days, 7 days, PRICE, ADMIN, signer
        );
        require(fresh.earlyAccessWallet() == address(0) && !fresh.earlyAccessEnabled(), "early access on by default");
        vm.warp(EARLY_START);
        GenesisHolderClaim.EarlyAccessVoucher memory voucher = _voucher(EARLY, 17);
        bytes32 digest = fresh.earlyAccessVoucherDigest(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        vm.prank(EARLY);
        vm.expectPartialRevert(GenesisHolderClaim.EarlyAccessDisabled.selector);
        fresh.earlyAccessMint(voucher, abi.encodePacked(r, s, v));

        vm.prank(ADMIN);
        claimContract.disableEarlyAccess();
        _expectRevert(EARLY, _voucher(EARLY, 18), SIGNER_KEY, GenesisHolderClaim.EarlyAccessDisabled.selector);
    }

    function testPausedContractBlocksEarlyAccess() public {
        vm.warp(EARLY_START);
        vm.prank(ADMIN);
        claimContract.pause();
        _expectRevert(EARLY, _voucher(EARLY, 19), SIGNER_KEY, GenesisHolderClaim.Paused.selector);
    }

    function testInvalidConfigurationRejected() public {
        GenesisHolderClaim fresh = new GenesisHolderClaim(
            address(release), address(sale), tokenId, 0, 0, CLAIM_START, 1 days, 7 days, PRICE, ADMIN, signer
        );
        uint64 s = uint64(EARLY_START);
        uint64 e = uint64(EARLY_END);
        _expectConfigRevert(fresh, address(0), s, e, GenesisHolderClaim.InvalidAddress.selector);
        _expectConfigRevert(fresh, ADMIN, s, e, GenesisHolderClaim.InvalidAddress.selector);
        _expectConfigRevert(fresh, signer, s, e, GenesisHolderClaim.InvalidAddress.selector);
        _expectConfigRevert(fresh, address(release), s, e, GenesisHolderClaim.InvalidAddress.selector);
        _expectConfigRevert(fresh, address(sale), s, e, GenesisHolderClaim.InvalidAddress.selector);
        _expectConfigRevert(fresh, address(genesis), s, e, GenesisHolderClaim.InvalidAddress.selector);
        _expectConfigRevert(fresh, EARLY, uint64(T0), e, GenesisHolderClaim.InvalidConfiguration.selector);
        _expectConfigRevert(fresh, EARLY, e, s, GenesisHolderClaim.InvalidConfiguration.selector);
        _expectConfigRevert(fresh, EARLY, s, s, GenesisHolderClaim.InvalidConfiguration.selector);
        // The window may end at claimStart, never after it.
        _expectConfigRevert(fresh, EARLY, s, uint64(CLAIM_START + 1), GenesisHolderClaim.InvalidConfiguration.selector);
        vm.prank(OTHER);
        vm.expectPartialRevert(GenesisHolderClaim.Unauthorized.selector);
        fresh.configureEarlyAccess(EARLY, s, e);
        vm.prank(ADMIN);
        fresh.configureEarlyAccess(EARLY, s, uint64(CLAIM_START));
        require(fresh.earlyAccessEnd() == CLAIM_START, "boundary window refused");
    }

    function testConfigurationLocksOnceTheWindowOpensOrTheMintHappens() public {
        // Before the window opens the admin may correct it.
        vm.prank(ADMIN);
        claimContract.configureEarlyAccess(EARLY, uint64(EARLY_START + 60), uint64(EARLY_END));
        vm.warp(EARLY_START + 60);
        _expectConfigRevert(claimContract, OTHER, uint64(EARLY_START + 120), uint64(EARLY_END), GenesisHolderClaim.EarlyAccessLocked.selector);
        _mint(EARLY, _voucher(EARLY, 20), SIGNER_KEY);
        vm.prank(ADMIN);
        claimContract.disableEarlyAccess();
        _expectConfigRevert(claimContract, OTHER, uint64(EARLY_START + 120), uint64(EARLY_END), GenesisHolderClaim.EarlyAccessLocked.selector);
    }

    function testEarlyAccessWalletCannotBecomeSignerOrAdmin() public {
        vm.prank(ADMIN);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidAddress.selector);
        claimContract.setSigner(EARLY);
        vm.prank(ADMIN);
        vm.expectPartialRevert(GenesisHolderClaim.InvalidAddress.selector);
        claimContract.transferAdmin(EARLY);
    }

    // 9. Early access does not bypass the Genesis holder rule for the free claim.
    function testEarlyAccessDoesNotGrantTheGenesisFreeClaim() public {
        vm.warp(EARLY_START);
        _mint(EARLY, _voucher(EARLY, 21), SIGNER_KEY);
        vm.warp(CLAIM_START);
        GenesisHolderClaim.ClaimVoucher memory noHolding = _claimVoucher(EARLY, 22);
        bytes memory signature = _signClaim(noHolding);
        vm.prank(EARLY);
        vm.expectPartialRevert(GenesisHolderClaim.NotGenesisHolder.selector);
        claimContract.claim(noHolding, signature);
        // The ordinary holder path is unchanged.
        genesis.setBalance(HOLDER, 2, 1);
        GenesisHolderClaim.ClaimVoucher memory holderVoucher = _claimVoucher(HOLDER, 23);
        bytes memory holderSignature = _signClaim(holderVoucher);
        vm.prank(HOLDER);
        claimContract.claim(holderVoucher, holderSignature);
        require(claimContract.hasClaimed(HOLDER) && claimContract.claimedSupply() == 2, "holder claim broken");
    }

    // 10. Early access cannot open the paid sale early, and fails closed if the sale schedule drifts.
    function testPaidSaleStaysClosedDuringEarlyAccess() public {
        vm.warp(EARLY_START);
        vm.deal(EARLY, PRICE);
        vm.prank(EARLY);
        vm.expectRevert();
        sale.purchase{value: PRICE}(tokenId, 1);
        _mint(EARLY, _voucher(EARLY, 24), SIGNER_KEY);
        vm.prank(EARLY);
        vm.expectRevert();
        sale.purchase{value: PRICE}(tokenId, 1);
    }

    function testEarlyAccessRefusesASaleRescheduledToOpenEarly() public {
        vm.prank(ARTIST);
        sale.configureSale(tokenId, PRICE, 0, WALLET_LIMIT, uint64(EARLY_START), uint64(PUBLIC_END), false);
        vm.warp(EARLY_START);
        _expectRevert(EARLY, _voucher(EARLY, 25), SIGNER_KEY, GenesisHolderClaim.PublicSaleSchedule.selector);
    }

    // 11. to 13. The paid sale keeps its 0.25 AVAX price, three-per-wallet limit and 7-day / 24-hour schedule,
    // and the early mint does not use any of the approved wallet's three paid mints.
    function testPaidSaleRulesAreUnchangedAndEarlyMintIsNotCounted() public {
        (uint256 price,,, uint256 limit, uint64 start, uint64 end,, bool configured) = sale.sales(tokenId);
        require(price == 0.25 ether && limit == 3 && configured, "sale terms changed");
        require(start == CLAIM_START && end == PUBLIC_END, "sale schedule changed");
        require(claimContract.claimEnd() == CLAIM_START + 1 days, "claim window is not 24 hours");
        require(claimContract.publicSaleEnd() == CLAIM_START + 7 days - 1, "sale is not 7 days");
        require(claimContract.earlyAccessEnd() <= claimContract.claimStart(), "early access overlaps the sale");
        vm.warp(EARLY_START);
        _mint(EARLY, _voucher(EARLY, 26), SIGNER_KEY);
        vm.warp(CLAIM_START);
        vm.deal(EARLY, PRICE * 4);
        vm.prank(EARLY);
        sale.purchase{value: PRICE * 3}(tokenId, 3);
        vm.prank(EARLY);
        vm.expectRevert();
        sale.purchase{value: PRICE}(tokenId, 1);
        require(release.balanceOf(EARLY, tokenId) == 4, "expected one early plus three paid");
        require(release.edition(tokenId).mintedSupply == 4, "supply accounting drifted");
    }

    // ---- helpers ----

    function _voucher(address claimant, uint256 nonce) internal view returns (GenesisHolderClaim.EarlyAccessVoucher memory) {
        return GenesisHolderClaim.EarlyAccessVoucher({
            claimant: claimant,
            destinationChainId: 43114,
            releaseContract: address(release),
            tokenId: tokenId,
            quantity: 1,
            windowStart: claimContract.earlyAccessStart(),
            windowEnd: claimContract.earlyAccessEnd(),
            nonce: nonce,
            deadline: block.timestamp + 300
        });
    }

    function _claimVoucher(address claimant, uint256 nonce) internal view returns (GenesisHolderClaim.ClaimVoucher memory) {
        return GenesisHolderClaim.ClaimVoucher({
            claimant: claimant,
            genesisContract: claimContract.GENESIS_CONTRACT(),
            genesisChainId: 43114,
            eligibilityRule: claimContract.ELIGIBILITY_RULE(),
            destinationChainId: 43114,
            releaseContract: address(release),
            tokenId: tokenId,
            quantity: 1,
            allocation: 0,
            nonce: nonce,
            deadline: block.timestamp + 300
        });
    }

    function _sign(GenesisHolderClaim.EarlyAccessVoucher memory voucher, uint256 key) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, claimContract.earlyAccessVoucherDigest(voucher));
        return abi.encodePacked(r, s, v);
    }

    function _signClaim(GenesisHolderClaim.ClaimVoucher memory voucher) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, claimContract.voucherDigest(voucher));
        return abi.encodePacked(r, s, v);
    }

    function _mint(address caller, GenesisHolderClaim.EarlyAccessVoucher memory voucher, uint256 key) internal {
        bytes memory signature = _sign(voucher, key);
        vm.prank(caller);
        claimContract.earlyAccessMint(voucher, signature);
    }

    function _expectRevert(address caller, GenesisHolderClaim.EarlyAccessVoucher memory voucher, uint256 key, bytes4 selector) internal {
        bytes memory signature = _sign(voucher, key);
        vm.prank(caller);
        vm.expectPartialRevert(selector);
        claimContract.earlyAccessMint(voucher, signature);
    }

    function _expectConfigRevert(GenesisHolderClaim target, address wallet, uint64 start, uint64 end, bytes4 selector) internal {
        vm.prank(ADMIN);
        vm.expectPartialRevert(selector);
        target.configureEarlyAccess(wallet, start, end);
    }
}
